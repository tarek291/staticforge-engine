import { buildGroundingFacts, collectGroundingIssues } from "@staticforge/ai";
import {
  CONTENT_PROFILES,
  DEFAULT_CONTENT_PROFILE,
  collectContentIssues,
  type GeneratedPage,
} from "@staticforge/schemas";

import { loadInputData, defaultInputPaths } from "./load-data.js";
import { validateInputData } from "./validate-input.js";
import type { ValidatedInputData } from "./types.js";
import type { ValidationIssue } from "./errors.js";

/**
 * Re-checking published output against the policy that was supposed to govern
 * it.
 *
 * The engine gates content on the way in: a structural contract, a quality
 * profile, and a verified record. Every one of those runs in memory, in the
 * process that produced the page, over a value that process had just built.
 * None of them says anything about the file that ends up on disk.
 *
 * That gap is reachable. Content served from the cache skips the profile and
 * the grounding record by design, because it passed them once. A page file can
 * be edited after it is written. A mock authoring pass produces publishable
 * output that never touched the gates at all. In each case the page still
 * satisfies its *schema*, which is all the pre-build validation checked — so it
 * would be published looking exactly like a page that had earned it.
 *
 * This module closes that by asking the same questions again, of the artifact
 * rather than of the process: is this page still what its profile requires, and
 * does it still say only what the record supports?
 *
 * ## Why the input has to be reloaded
 *
 * Grounding compares a page against a verified record, and the record is built
 * from the business, the service and the city — none of which are stored in the
 * page. Re-deriving them from the same source the run used is the point: a
 * check that trusted values carried over from the run would be checking the
 * run's memory again, which is the thing already known to be insufficient.
 */

/** Where the pages under inspection came from. */
export interface PolicySource {
  repoRoot: string;
  /** Database project, or `undefined` for local file mode. */
  projectId: string | undefined;
  /** Operator the database read is scoped to. Ignored in file mode. */
  userId?: string;
}

/**
 * Reload the input the pages were generated from.
 *
 * Mirrors the generator's own dual-mode load, including the dynamic Prisma
 * import, so a local run still never constructs a database client.
 */
export async function loadPolicyInput(
  source: PolicySource,
): Promise<ValidatedInputData> {
  if (source.projectId === undefined) {
    const inputDir = `${source.repoRoot}/data/input`;
    return validateInputData(await loadInputData(defaultInputPaths(inputDir)));
  }

  const { getProjectPayload, prisma, resolveOperatorId } = await import(
    "@staticforge/database"
  );

  const payload = await getProjectPayload(
    source.projectId,
    source.userId ?? resolveOperatorId(),
    prisma,
  );

  return validateInputData({
    businesses: payload.businesses,
    services: payload.services,
    locations: payload.locations,
    content: payload.content,
  });
}

/** Index a list of identified entities by id. */
function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * Check written pages against the profile each one names and the record each
 * one was written from.
 *
 * Collects every finding rather than stopping at the first, matching how the
 * rest of the engine reports: an operator fixes a bad run in one pass, not one
 * page per run.
 *
 * A page naming a profile that does not exist is itself a finding. Falling back
 * to a default would mean judging it by rules nobody chose, and reporting it
 * clean would mean the strictest thing about a page — which policy it claims —
 * is the one thing never verified.
 *
 * @param pages - Pages re-read from disk.
 * @param input - The input those pages were generated from.
 * @returns Every violation found. Empty means the output holds.
 */
export function collectPolicyIssues(
  pages: GeneratedPage[],
  input: ValidatedInputData,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const businesses = indexById(input.businesses);
  const services = indexById(input.services);
  const locations = indexById(input.locations);

  for (const page of pages) {
    // `Object.hasOwn` rather than a bare index: `CONTENT_PROFILES` is an object
    // literal, so it inherits `Object.prototype`, and a page naming
    // "constructor" or "toString" would read as a registered profile and be
    // judged against a function. The value is tenant-controlled, and this is
    // the check that is supposed to fail loudly.
    const profile = Object.hasOwn(CONTENT_PROFILES, page.contentProfileId)
      ? CONTENT_PROFILES[page.contentProfileId]
      : undefined;

    if (profile === undefined) {
      issues.push({
        path: `pages[${page.slug}].contentProfileId`,
        message:
          `Unknown contentProfileId "${page.contentProfileId}". Registered: ` +
          `${Object.keys(CONTENT_PROFILES).join(", ")}.`,
      });
      continue;
    }

    for (const issue of collectContentIssues(page, profile)) {
      issues.push({
        path: `pages[${page.slug}].${issue.path}`,
        message: `[${profile.id}] ${issue.message}`,
      });
    }

    const business = businesses.get(page.businessId);
    const service = services.get(page.serviceId);
    const location = locations.get(page.locationId);

    if (business === undefined || service === undefined || location === undefined) {
      // The page names entities the input no longer has, so no record can be
      // built for it — which is itself a reason not to publish it.
      issues.push({
        path: `pages[${page.slug}]`,
        message:
          `Cannot verify: unknown business="${page.businessId}", ` +
          `service="${page.serviceId}", location="${page.locationId}".`,
      });
      continue;
    }

    const facts = buildGroundingFacts(business, service, {
      services: input.services,
      locations: input.locations,
    });

    for (const issue of collectGroundingIssues(page, facts)) {
      issues.push({
        path: `pages[${page.slug}].${issue.path}`,
        message: issue.message,
      });
    }
  }

  return issues;
}

/** Both halves, for a caller that has pages and a source but no input. */
export async function verifyPagePolicy(
  pages: GeneratedPage[],
  source: PolicySource,
): Promise<ValidationIssue[]> {
  return collectPolicyIssues(pages, await loadPolicyInput(source));
}

export { DEFAULT_CONTENT_PROFILE };
