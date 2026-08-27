import type { GeneratedPageContent, PagePromptDetails } from "@staticforge/ai";
import { sleep } from "@staticforge/core";
import { GeneratedPageSchema, type GeneratedPage } from "@staticforge/schemas";

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
 * Structurally identical to `generatePageContent` from `@staticforge/ai`; it is
 * injected rather than imported directly so the merge can be tested against a
 * stub without any network call or API key.
 */
export type GenerateContentFn = (
  details: PagePromptDetails,
) => Promise<GeneratedPageContent>;

/** Reported after each page is authored, for CLI progress output. */
export interface AiProgress {
  done: number;
  total: number;
  slug: string;
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
}

/** Index a list of identified entities by id. */
function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
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
  const { onProgress, delayMs = AI_CALL_DELAY_MS } = options;

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

    const content = await generateContentFn({
      businessName: business.name,
      serviceName: service.name,
      cityName: location.city,
    });

    const merged = {
      ...page,
      title: content.title,
      metaDescription: content.metaDescription,
      h1: content.h1,
      content: content.content,
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
    onProgress?.({ done: index + 1, total: pages.length, slug: page.slug });

    // Pace the calls — skipped after the final page, where the delay would
    // only add dead time before the run ends.
    if (index < pages.length - 1) {
      await sleep(delayMs);
    }
  }

  return authored;
}
