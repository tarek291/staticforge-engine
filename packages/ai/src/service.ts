import type Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_CONTENT_PROFILE,
  GeneratedPageSchema,
  collectContentIssues,
  type ContentIssue,
  type ContentProfile,
  type GeneratedPage,
} from "@staticforge/schemas";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  AIContentRejectedError,
  AIRequestError,
  AIToolCallMissingError,
  AITransportError,
} from "./errors.js";
import {
  collectGroundingIssues,
  renderGroundingFacts,
  type GroundingFacts,
  type GroundingOptions,
} from "./grounding.js";
import {
  buildCacheKey,
  type CacheKeyParts,
  type ContentCache,
} from "./cache.js";
import { PROMPT_VERSION, buildSystemPrompt, buildUserPrompt } from "./prompts.js";
import type { PagePromptDetails } from "./prompts.js";
import { RetryExhaustedError, withRetry, type RetryOptions } from "./retry.js";

/**
 * The AI content generation service.
 *
 * ## Separation of powers
 *
 * The model authors data. It has no authority to accept it. Every response
 * passes four gates before this service returns anything:
 *
 * 1. **Tool call present** — the model must answer through the tool, not prose.
 * 2. **Structural contract** — the arguments are parsed with the Zod schema
 *    derived from `GeneratedPageSchema`. The model cannot widen the shape.
 * 3. **Quality profile** — the parsed content is measured against the same
 *    `ContentProfile` whose rules were rendered into the prompt.
 * 4. **Fact grounding** — every checkable claim is matched against the verified
 *    record that was put in front of the model. Runs only when facts are
 *    supplied: what is not known cannot be verified.
 *
 * A failure at any gate is a rejection, not a retry. Retrying is reserved for
 * transport failures, where waiting can plausibly change the outcome; rejected
 * content would cost another paid call to produce the same violation.
 */

/**
 * The authored slice of a generated page.
 *
 * Derived from `GeneratedPageSchema` with `.pick()` — the same derivation
 * pattern `ManifestEntrySchema` uses — so the two stay aligned automatically.
 *
 * The omitted fields are deliberately not the model's to decide: `slug` is
 * derived from service + city by the generator (and guarded against
 * collisions), `businessId` / `serviceId` / `locationId` are input-data
 * identifiers the model never sees, `locale` comes from the input, and
 * `templateId` is resolved by the service → content → "default" precedence.
 * Asking the model for them would only invite plausible-looking fabrications.
 */
export const GeneratedPageContentSchema = GeneratedPageSchema.pick({
  title: true,
  metaDescription: true,
  h1: true,
  content: true,
});
export type GeneratedPageContent = z.infer<typeof GeneratedPageContentSchema>;

/** Model used for content generation. */
export const DEFAULT_MODEL = "claude-opus-5";

/** Name of the tool the model must call to return its answer. */
export const TOOL_NAME = "emit_page_content";

/**
 * Engine-owned fields, supplied so profile rules that target authored fields
 * can run against a structurally complete page.
 *
 * The real values are resolved by the generator and merged in afterwards;
 * these exist only so the profile check has a whole page to look at. They are
 * chosen to satisfy every rule that is not about authored content, so any issue
 * that surfaces is genuinely the model's.
 */
const ENGINE_OWNED_PLACEHOLDERS: Omit<
  GeneratedPage,
  "title" | "metaDescription" | "h1" | "content"
> = {
  slug: "content-probe",
  locale: "de",
  schemaOrg: { "@type": "Service" },
  templateId: "default",
  contentProfileId: "default",
  businessId: "00000000-0000-4000-8000-000000000000",
  serviceId: "content-probe-service",
  locationId: "content-probe-location",
  // Internal links are computed after authoring, over the whole build, so the
  // model is never asked for them and the probe carries none.
  links: [],
};

/**
 * The Zod contract, expressed as JSON Schema for the Anthropic tool.
 *
 * `$refStrategy: "none"` inlines every sub-schema, because the API expects one
 * self-contained schema object rather than a `$ref` / `definitions` graph. The
 * generated `$schema` key is dropped for the same reason.
 *
 * `strict: true` is intentionally not set on the tool: strict mode requires
 * every property to appear in `required`, which the optional fields in
 * `content` (`hero.subheading`, `hero.image`, `cta.secondary`) cannot satisfy.
 * The JSON Schema steers the model; the Zod parse below is what guarantees the
 * shape.
 */
export const TOOL_INPUT_SCHEMA = ((): Anthropic.Tool["input_schema"] => {
  const { $schema, ...schema } = zodToJsonSchema(GeneratedPageContentSchema, {
    $refStrategy: "none",
  }) as Record<string, unknown> & { $schema?: string };

  void $schema;

  return schema as Anthropic.Tool["input_schema"];
})();

/** Reported when a transport failure is about to be retried. */
export interface GenerationRetryNotice {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  status: number | undefined;
}

/** Construction options for {@link AIGenerationService}. */
export interface AIGenerationServiceOptions {
  /**
   * The Anthropic client. Injected rather than constructed, so the service can
   * be exercised against a double with no network and no API key.
   */
  client: Pick<Anthropic, "messages">;
  /** Quality policy. Drives both the prompt and the verdict. */
  profile?: ContentProfile;
  model?: string;
  maxTokens?: number;
  /** Transport retry policy. */
  retry?: RetryOptions;
  onRetry?: (notice: GenerationRetryNotice) => void;
  /** Grounding guard configuration. */
  grounding?: GroundingOptions;
  /** Where accepted content is stored and looked up. Omit to disable caching. */
  cache?: ContentCache;
  /** Version recorded on output and folded into the cache key. */
  promptVersion?: string;
  /**
   * Refuse to generate at all when no verified record is supplied.
   *
   * Off by default so existing callers keep working, but worth turning on for
   * anything published: without facts the grounding gate cannot run, and an
   * ungrounded page looks exactly like a grounded one.
   */
  requireFacts?: boolean;
}

/**
 * The identity a cached page is keyed on, minus the parts the service knows
 * itself (profile, prompt version, model).
 *
 * Supplied by the caller because only it knows which entities and which source
 * data produced this request. Omit it and caching is skipped: a key that cannot
 * be built reliably is worse than no cache, because a wrong key serves the
 * wrong page.
 */
export interface CacheIdentity {
  businessId: string;
  serviceId: string;
  locationId: string;
  /** Fingerprint of the source entities and content template. */
  sourceHash: string;
}

/** A page to author, with the verified record it must stay inside. */
export interface GenerationRequest extends PagePromptDetails {
  /** The verified record. Omit to skip the grounding gate. */
  facts?: GroundingFacts;
  /** Identity for caching. Omit to bypass the cache. */
  cacheIdentity?: CacheIdentity;
  /**
   * Which content profile this page is held to.
   *
   * The service itself is built around one profile — its prompt is rendered
   * from it once — so this field is how a *router* knows which service to hand
   * the request to, not something a single service switches on.
   */
  contentProfileId?: string;
}

/** What produced a piece of content, recorded on the page it becomes. */
export interface ContentProvenance {
  promptVersion: string;
  modelVersion: string;
  profileId: string;
  sourceHash: string | undefined;
  /** Whether this came from the cache rather than the provider. */
  cacheHit: boolean;
}

/** Authored content together with its provenance. */
export interface AuthoredContent {
  content: GeneratedPageContent;
  provenance: ContentProvenance;
}

export class AIGenerationService {
  private readonly client: Pick<Anthropic, "messages">;
  private readonly profile: ContentProfile;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly retryOptions: RetryOptions;
  private readonly onRetry: ((notice: GenerationRetryNotice) => void) | undefined;
  private readonly groundingOptions: GroundingOptions;
  private readonly requireFacts: boolean;
  private readonly cache: ContentCache | undefined;
  private readonly promptVersion: string;
  private readonly systemPrompt: string;

  constructor(options: AIGenerationServiceOptions) {
    this.client = options.client;
    this.profile = options.profile ?? DEFAULT_CONTENT_PROFILE;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? 16_000;
    this.retryOptions = options.retry ?? {};
    this.onRetry = options.onRetry;
    this.groundingOptions = options.grounding ?? {};
    this.requireFacts = options.requireFacts ?? false;
    this.cache = options.cache;
    this.promptVersion = options.promptVersion ?? PROMPT_VERSION;
    // Rendered once: the prompt is derived from the profile, so it changes only
    // when the profile does.
    this.systemPrompt = buildSystemPrompt(this.profile);
  }

  /** The profile this service enforces. */
  get contentProfile(): ContentProfile {
    return this.profile;
  }

  /** The system prompt, exposed for inspection and testing. */
  get prompt(): string {
    return this.systemPrompt;
  }

  /**
   * Author validated content for one service-in-city combination.
   *
   * @param details - Business, service and city names.
   * @returns Content that satisfies both the structural contract and the profile.
   * @throws {AITransportError} The provider stayed unreachable across every attempt.
   * @throws {AIRequestError} The request itself was rejected; retrying cannot help.
   * @throws {AIToolCallMissingError} The model answered without calling the tool.
   * @throws {AIContentRejectedError} The content violated the contract.
   */
  async generatePageContent(
    request: GenerationRequest,
  ): Promise<GeneratedPageContent> {
    return (await this.authorPage(request)).content;
  }

  /**
   * Author a page, returning the content together with what produced it.
   *
   * Consults the cache first. A hit returns without touching the provider and
   * without re-running the gates: the entry was only stored because it passed
   * them, under a key that encodes every input that shaped it.
   *
   * Only accepted content is stored. A rejection is never cached — caching a
   * refusal would turn one bad answer into a permanent one.
   */
  async authorPage(request: GenerationRequest): Promise<AuthoredContent> {
    const cacheParts = this.cacheParts(request);
    const key = cacheParts === undefined ? undefined : buildCacheKey(cacheParts);

    if (key !== undefined && this.cache !== undefined) {
      const cached = await this.cache.get(key);

      if (cached !== undefined) {
        return {
          content: cached.content,
          provenance: this.provenance(request, true),
        };
      }
    }

    const content = await this.callAndVerify(request);

    if (key !== undefined && cacheParts !== undefined && this.cache !== undefined) {
      await this.cache.set(key, {
        content,
        parts: cacheParts,
        storedAt: new Date().toISOString(),
      });
    }

    return { content, provenance: this.provenance(request, false) };
  }

  /** The full cache key parts, or undefined when the caller supplied no identity. */
  private cacheParts(request: GenerationRequest): CacheKeyParts | undefined {
    if (request.cacheIdentity === undefined) {
      return undefined;
    }

    return {
      businessId: request.cacheIdentity.businessId,
      serviceId: request.cacheIdentity.serviceId,
      locationId: request.cacheIdentity.locationId,
      profileId: this.profile.id,
      promptVersion: this.promptVersion,
      modelVersion: this.model,
      sourceHash: request.cacheIdentity.sourceHash,
    };
  }

  /** What produced this content. */
  private provenance(
    request: GenerationRequest,
    cacheHit: boolean,
  ): ContentProvenance {
    return {
      promptVersion: this.promptVersion,
      modelVersion: this.model,
      profileId: this.profile.id,
      sourceHash: request.cacheIdentity?.sourceHash,
      cacheHit,
    };
  }

  /** Call the provider and run every gate. */
  private async callAndVerify(
    request: GenerationRequest,
  ): Promise<GeneratedPageContent> {
    if (this.requireFacts && request.facts === undefined) {
      throw new AIRequestError(
        "requireFacts is enabled but no verified record was supplied; " +
          "the grounding gate cannot run and the page would be unverifiable.",
        undefined,
        undefined,
      );
    }

    const response = await this.callProvider(request);

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock =>
        block.type === "tool_use" && block.name === TOOL_NAME,
    );

    if (toolUse === undefined) {
      throw new AIToolCallMissingError(TOOL_NAME, response.stop_reason);
    }

    return this.acceptOrReject(toolUse.input, request.facts);
  }

  /**
   * Gates 2, 3 and 4: structure, then quality, then grounding.
   *
   * Ordered cheapest and most fundamental first — content that is not a page
   * cannot be judged for quality, and content that fails the quality bar will
   * be rewritten anyway, so there is no point scanning it for fabricated
   * claims.
   *
   * Exposed so the same verdict can be applied to content that arrived by
   * another route, and so the rejection path is testable without a provider.
   */
  acceptOrReject(input: unknown, facts?: GroundingFacts): GeneratedPageContent {
    const parsed = GeneratedPageContentSchema.safeParse(input);

    if (!parsed.success) {
      throw new AIContentRejectedError(
        "schema",
        this.profile.id,
        parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      );
    }

    const profileIssues = this.collectProfileIssues(parsed.data);

    if (profileIssues.length > 0) {
      throw new AIContentRejectedError("profile", this.profile.id, profileIssues);
    }

    if (facts !== undefined) {
      const groundingIssues = collectGroundingIssues(
        parsed.data,
        facts,
        this.groundingOptions,
      );

      if (groundingIssues.length > 0) {
        throw new AIContentRejectedError(
          "grounding",
          this.profile.id,
          groundingIssues,
        );
      }
    }

    return parsed.data;
  }

  /**
   * Measure authored content against the profile.
   *
   * The authored slice is completed with engine-owned placeholders so the
   * profile has a whole page to judge; every issue that survives therefore
   * concerns a field the model actually wrote.
   */
  private collectProfileIssues(content: GeneratedPageContent): ContentIssue[] {
    const probe: GeneratedPage = {
      ...ENGINE_OWNED_PLACEHOLDERS,
      ...content,
    };

    return collectContentIssues(probe, this.profile);
  }

  /**
   * The user turn, with the verified record appended when one exists.
   *
   * Grounding is two halves of one mechanism: the record is put in front of the
   * model so it has no reason to invent, and the same record then judges the
   * answer. Sending the facts without checking them would be a hope; checking
   * without sending them would be a trap.
   */
  private buildRequestText(request: GenerationRequest): string {
    const userPrompt = buildUserPrompt(request);

    return request.facts === undefined
      ? userPrompt
      : `${userPrompt}\n\n${renderGroundingFacts(request.facts)}`;
  }

  /** Gate 1, with the transport retry policy wrapped around it. */
  private async callProvider(
    request: GenerationRequest,
  ): Promise<Anthropic.Message> {
    try {
      return await withRetry(
        () =>
          this.client.messages.create({
            model: this.model,
            max_tokens: this.maxTokens,
            thinking: { type: "adaptive" },
            system: this.systemPrompt,
            tools: [
              {
                name: TOOL_NAME,
                description:
                  "Return the authored landing page content. This is the only way to deliver an answer.",
                input_schema: TOOL_INPUT_SCHEMA,
              },
            ],
            tool_choice: {
              type: "tool",
              name: TOOL_NAME,
              disable_parallel_tool_use: true,
            },
            messages: [
              { role: "user", content: this.buildRequestText(request) },
            ],
          }) as Promise<Anthropic.Message>,
        {
          ...this.retryOptions,
          onRetry: (attempt) => {
            this.onRetry?.({
              attempt: attempt.attempt,
              maxAttempts: attempt.maxAttempts,
              delayMs: attempt.delayMs,
              status: attempt.status,
            });
            this.retryOptions.onRetry?.(attempt);
          },
        },
      );
    } catch (error: unknown) {
      if (error instanceof RetryExhaustedError) {
        throw new AITransportError(
          "Provider unreachable or unavailable",
          error.attempts,
          error.status,
          error.cause,
        );
      }

      // Not retryable: a bad key, a bad model id, a malformed tool schema.
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : String(error);

      throw new AIRequestError(
        `Provider rejected the request: ${message}`,
        status,
        error,
      );
    }
  }
}
