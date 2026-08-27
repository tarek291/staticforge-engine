import {
  buildGroundingFacts,
  type AuthoredContent,
  type GenerationRequest,
} from "@staticforge/ai";
import { sleep, stableHash } from "@staticforge/core";
import { GeneratedPageSchema, type GeneratedPage } from "@staticforge/schemas";

import type { Business, Location, Service } from "@staticforge/schemas";

import { ValidationError, type ValidationIssue } from "./errors.js";
import type { ValidatedInputData } from "./types.js";

/**
 * Environment variable that opts the pipeline into AI-authored page content.
 *
 * Strictly opt-in: only the exact string `"true"` enables it, so a stray
 * `USE_AI_GENERATION=1` or `=yes` cannot silently start spending tokens.
 */
const AI_ENV_VAR = "USE_AI_GENERATION";

/**
 * Pause between consecutive AI calls, in milliseconds.
 *
 * Pages are authored one at a time with this delay in between so a full run
 * stays well inside provider rate limits.
 */
export const AI_CALL_DELAY_MS = 3000;

/** Whether AI-authored content is enabled for this run. */
export function isAiGenerationEnabled(): boolean {
  return process.env[AI_ENV_VAR] === "true";
}

/**
 * Authors the content for one page.
 *
 * Structurally identical to `AIGenerationService.authorPage`; it is injected
 * rather than imported directly so the merge can be tested against a stub
 * without any network call or API key.
 *
 * Takes the full request — including the verified record and the cache
 * identity — rather than three names, so the grounding gate and the cache are
 * live in a real run instead of only in the AI package's own tests.
 */
export type GenerateContentFn = (
  request: GenerationRequest,
) => Promise<AuthoredContent>;

/** Reported after each page is authored, for CLI progress output. */
export interface AiProgress {
  done: number;
  total: number;
  slug: string;
  /** Whether the content came from the cache rather than a paid call. */
  cacheHit: boolean;
  /**
   * Whether the content came from a previous, interrupted attempt at this same
   * project rather than from this run at all.
   */
  resumed: boolean;
}

/**
 * Authored content a previous attempt already produced, by slug.
 *
 * Shaped as the engine's own page fields plus the provenance that says what
 * produced them, because that provenance is the only thing that makes reuse
 * safe: the stored `sourceHash` has to match the one computed now, or the
 * inputs have moved and the stored prose describes a page that no longer
 * exists.
 */
export interface ResumableContent {
  title: string;
  metaDescription: string;
  h1: string;
  content: unknown;
  generation: unknown;
}

/**
 * Fingerprint the source data behind one page.
 *
 * Covers everything the authored content is derived from: the business
 * identity, the service, the city, and the shared content template. Edit any of
 * them and the fingerprint moves, the cache misses, and the page is rewritten —
 * which is the point. Leave them alone and a re-run costs nothing.
 *
 * Only the fields that actually reach the model or the grounding record are
 * included. A change to, say, a service's internal id would otherwise force a
 * pointless rewrite of identical prose.
 */
export function computeSourceHash(
  business: Business,
  service: Service,
  location: Location,
  content: ValidatedInputData["content"],
): string {
  return stableHash({
    business: {
      name: business.name,
      description: business.description,
      niche: business.niche,
      foundedYear: business.foundedYear,
      contactEmail: business.contactEmail,
      contactPhone: business.contactPhone,
      serviceIds: business.serviceIds,
      locationIds: business.locationIds,
    },
    service: {
      name: service.name,
      description: service.description,
      benefits: service.benefits,
      pricing: service.pricing,
    },
    location: { city: location.city, state: location.state, country: location.country },
    content,
  });
}

/** Optional knobs for {@link applyAiContent}. */
export interface ApplyAiContentOptions {
  /** Per-page progress callback. */
  onProgress?: (progress: AiProgress) => void;
  /**
   * Delay between calls, in milliseconds. Defaults to {@link AI_CALL_DELAY_MS};
   * tests pass `0` so the suite does not spend real seconds waiting.
   */
  delayMs?: number;
  /**
   * Injected so a test can observe *whether* the run paced, not merely how
   * long it took. The same seam `withRetry` and the mock service already use,
   * for the same reason: a wall-clock assertion is a slow test and a flaky one.
   */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Content an interrupted attempt at this project already wrote, by slug.
   *
   * Consulted before the provider is. A page whose stored provenance carries
   * the same `sourceHash` this run computes was authored from identical inputs
   * by the same prompt, model and profile — so re-buying it would produce the
   * same prose and charge for it twice.
   *
   * Omit to disable resumption, which is what a local file run does: there is
   * no earlier attempt to resume from.
   */
  resumeFrom?: ReadonlyMap<string, ResumableContent>;
  /**
   * Called after every page with the running totals, so a long run can report
   * progress somewhere durable. Awaited, because a progress write that races
   * the next page is a progress bar that jumps backwards.
   */
  onCount?: (counts: { completed: number; total: number }) => Promise<void>;
}

/** Index a list of identified entities by id. */
function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * Whether stored content may stand in for a fresh authoring call.
 *
 * The single question that matters: was it written from the inputs this run is
 * about to use? `sourceHash` fingerprints the business, the service, the city
 * and the content template, so a match means the model would be handed exactly
 * what it was handed last time. Anything else — a renamed service, an edited
 * description, a different prompt version recorded alongside it — and the
 * stored prose is about a page that no longer exists.
 *
 * Missing or malformed provenance is treated as "no", not as "probably fine".
 * A page that cannot say what produced it cannot be shown to be current.
 */
function isReusable(stored: ResumableContent, sourceHash: string): boolean {
  const generation = stored.generation;

  if (typeof generation !== "object" || generation === null) {
    return false;
  }

  return (generation as { sourceHash?: unknown }).sourceHash === sourceHash;
}

/**
 * Realign a page's structured data with the content it now carries.
 *
 * `schemaOrg` is assembled during template building, from the template's hero
 * title and subtitle. The authoring pass then replaces the title, the meta
 * description and the h1 and left the structured data untouched — so every
 * AI-authored page shipped JSON-LD describing a page that no longer existed,
 * telling a crawler one thing while showing a reader another. For a
 * programmatic SEO engine that is not a cosmetic inconsistency: mismatched
 * structured data is a documented negative signal, and this product exists to
 * rank.
 *
 * "Engine-owned" was always the right call for this field. It should have meant
 * *derived from the finished page*, not *frozen at template time*.
 *
 * Only the two fields that describe the page move. `serviceType`, `provider`
 * and `areaServed` come from the business record rather than from any prose,
 * so the model has no say in them and no reason to be consulted about them.
 * The roles are the ones the template established: `name` tracks the visible
 * heading, `description` tracks the meta description.
 */
function realignSchemaOrg(
  schemaOrg: GeneratedPage["schemaOrg"],
  content: { h1: string; metaDescription: string },
): GeneratedPage["schemaOrg"] {
  return {
    ...schemaOrg,
    name: content.h1,
    description: content.metaDescription,
  };
}

/**
 * Overlay AI-authored content onto already-built, already-valid pages.
 *
 * Only the authored slice is replaced — `title`, `metaDescription`, `h1` and
 * `content`. Every deterministic field is carried through untouched: `slug`
 * (and therefore the duplicate-slug guarantee established in `buildPages`),
 * `locale`, `templateId`, `schemaOrg`, and the three input identifiers. The
 * model is never asked for them, so it cannot fabricate them.
 *
 * Each merged page is re-validated against {@link GeneratedPageSchema}, so an
 * AI run can never widen or weaken the payload contract that the web app and
 * the manifest depend on.
 *
 * This is deliberately a separate async pass rather than a change to
 * `buildPages`: `buildPages` stays pure, synchronous and I/O-free, and remains
 * the single source of the deterministic baseline.
 *
 * Fails fast rather than collecting issues across all pages — every iteration
 * costs a paid API call, so continuing past a failure would waste tokens.
 *
 * ## Resuming
 *
 * When `resumeFrom` is supplied, each page is checked against what a previous
 * attempt at this project already wrote. A stored page whose provenance carries
 * the same `sourceHash` this run computes was authored from identical inputs,
 * so it is reused outright: no provider call, no pacing delay, no second charge
 * for prose that already exists. That is what turns a run killed at page four
 * hundred from a total loss into a hundred pages of remaining work.
 *
 * Does not mutate `pages`; a new array of new objects is returned.
 *
 * @param pages - Deterministic pages produced by `buildPages`.
 * @param input - The validated input the pages were built from.
 * @param generateContentFn - Authors the content for a single page.
 * @param options - Progress reporting and call pacing.
 * @returns A new array of pages with AI-authored content applied.
 * @throws {ValidationError} If a page references an unknown entity id, or if a
 * merged page fails schema validation.
 */
export async function applyAiContent(
  pages: GeneratedPage[],
  input: ValidatedInputData,
  generateContentFn: GenerateContentFn,
  options: ApplyAiContentOptions = {},
): Promise<GeneratedPage[]> {
  const {
    onProgress,
    delayMs = AI_CALL_DELAY_MS,
    sleepFn = sleep,
    resumeFrom,
    onCount,
  } = options;

  const businesses = indexById(input.businesses);
  const services = indexById(input.services);
  const locations = indexById(input.locations);

  const authored: GeneratedPage[] = [];

  for (const [index, page] of pages.entries()) {
    const business = businesses.get(page.businessId);
    const service = services.get(page.serviceId);
    const location = locations.get(page.locationId);

    if (business === undefined || service === undefined || location === undefined) {
      const missing: ValidationIssue[] = [
        {
          path: `pages[${page.slug}]`,
          message:
            `Cannot author content: unknown ` +
            `business="${page.businessId}", service="${page.serviceId}", ` +
            `location="${page.locationId}".`,
        },
      ];
      throw new ValidationError("ai-content", missing);
    }

    const sourceHash = computeSourceHash(business, service, location, input.content);

    // Resume before spending anything. A previous attempt at this project may
    // already hold this exact page, written from these exact inputs, and paid
    // for once.
    const stored = resumeFrom?.get(page.slug);
    const reusable =
      stored !== undefined && isReusable(stored, sourceHash) ? stored : undefined;

    if (reusable !== undefined) {
      const restored = GeneratedPageSchema.safeParse({
        ...page,
        title: reusable.title,
        metaDescription: reusable.metaDescription,
        h1: reusable.h1,
        content: reusable.content,
        schemaOrg: realignSchemaOrg(page.schemaOrg, {
          h1: reusable.h1,
          metaDescription: reusable.metaDescription,
        }),
        generation: reusable.generation,
      });

      if (restored.success) {
        authored.push(restored.data);
        onProgress?.({
          done: index + 1,
          total: pages.length,
          slug: page.slug,
          cacheHit: false,
          resumed: true,
        });
        await onCount?.({ completed: index + 1, total: pages.length });
        // No provider call was made, so there is no rate limit to respect and
        // nothing to pace.
        continue;
      }

      // Stored content that no longer satisfies the contract is not a reason to
      // fail the run — the page is simply authored again, which is what would
      // have happened without a previous attempt at all.
    }

    const { content, provenance } = await generateContentFn({
      businessName: business.name,
      serviceName: service.name,
      cityName: location.city,
      // The verified record. Supplying it is what activates the grounding gate:
      // without facts there is nothing to check a claim against.
      facts: buildGroundingFacts(business, service, {
        services: input.services,
        locations: input.locations,
      }),
      // Routed on, not switched on: the page states which profile it is held
      // to, and the caller decides which service that means.
      contentProfileId: page.contentProfileId,
      cacheIdentity: {
        businessId: page.businessId,
        serviceId: page.serviceId,
        locationId: page.locationId,
        sourceHash,
      },
    });

    const merged = {
      ...page,
      title: content.title,
      metaDescription: content.metaDescription,
      h1: content.h1,
      content: content.content,
      // Derived from the finished page rather than carried over from the
      // template, so the structured data cannot describe copy that was
      // replaced.
      schemaOrg: realignSchemaOrg(page.schemaOrg, content),
      // Provenance travels with the page, so a later run can tell what wrote it
      // without re-reading the text.
      generation: {
        promptVersion: provenance.promptVersion,
        modelVersion: provenance.modelVersion,
        profileId: provenance.profileId,
        sourceHash,
        // Fingerprinted here too, so a later refresh can tell whether it
        // actually changed anything rather than guessing.
        contentHash: stableHash({
          title: content.title,
          metaDescription: content.metaDescription,
          h1: content.h1,
          content: content.content,
        }),
        generatedAt: new Date().toISOString(),
      },
    };

    const result = GeneratedPageSchema.safeParse(merged);
    if (!result.success) {
      throw new ValidationError(
        "ai-content",
        result.error.issues.map((issue) => ({
          path: `pages[${page.slug}].${issue.path.join(".")}`,
          message: issue.message,
        })),
      );
    }

    authored.push(result.data);
    onProgress?.({
      done: index + 1,
      total: pages.length,
      slug: page.slug,
      cacheHit: provenance.cacheHit,
      resumed: false,
    });
    await onCount?.({ completed: index + 1, total: pages.length });

    // Pace the calls. Skipped after the final page, where the delay would only
    // add dead time before the run ends — and skipped entirely on a cache hit,
    // which never touched the provider and so has no rate limit to respect.
    // Pacing it anyway is pure waiting: a fully cached re-run of five hundred
    // pages spent twenty-five minutes asleep to make zero requests.
    if (index < pages.length - 1 && !provenance.cacheHit) {
      await sleepFn(delayMs);
    }
  }

  return authored;
}
