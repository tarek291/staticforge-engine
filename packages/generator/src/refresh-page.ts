import {
  buildGroundingFacts,
  type AuthoredContent,
  type RefreshRequest,
} from "@staticforge/ai";
import { stableHash } from "@staticforge/core";
import { GeneratedPageSchema, type GeneratedPage } from "@staticforge/schemas";

import { computeSourceHash } from "./ai-content.js";
import { ValidationError, type ValidationIssue } from "./errors.js";
import type { ValidatedInputData } from "./types.js";

/**
 * Targeted revision of a single page.
 *
 * The engine's other paths build pages from inputs. This one takes a page that
 * already exists and changes part of it — which makes it the first place where
 * *not* changing things is the harder requirement.
 *
 * ## What a refresh may not touch
 *
 * `slug` and `links` are load-bearing beyond this page. A changed slug orphans
 * every inbound link and breaks a published URL; changed links break the graph
 * that Phase 05 guarantees is sound. Both are carried through untouched, and a
 * test asserts it, because the failure would be invisible until a crawler found
 * it.
 *
 * `templateId`, `contentProfileId`, `locale`, `schemaOrg` and the three entity
 * ids are equally not the model's to revise: they were resolved by rules, not
 * written by anyone.
 */

/** Authors a revision. Injected so the merge is testable without a provider. */
export type RefreshContentFn = (
  request: RefreshRequest,
) => Promise<AuthoredContent>;

/**
 * Fingerprint the authored slice, to tell a real revision from a no-op.
 *
 * Takes the slice rather than a whole page, so a refresh and a block patch
 * fingerprint the same content through the same function. Two hashes of "the
 * authored part of a page" that could disagree would make `changed` mean
 * different things depending on which path produced it.
 */
export function computeContentHash(page: {
  title: string;
  metaDescription: string;
  h1: string;
  content: unknown;
}): string {
  return stableHash({
    title: page.title,
    metaDescription: page.metaDescription,
    h1: page.h1,
    content: page.content,
  });
}

/** Outcome of one revision. */
export interface RefreshResult {
  page: GeneratedPage;
  /** Fingerprint before the revision. */
  previousContentHash: string;
  /** Fingerprint after it. */
  contentHash: string;
  /**
   * Whether anything actually changed.
   *
   * A revision that returns identical prose is a wasted call, not a failure —
   * the operator asked for something the model judged already done. Reporting
   * it is more useful than hiding it.
   */
  changed: boolean;
}

/**
 * Revise one page against operator feedback.
 *
 * @param page - The page as it stands.
 * @param input - The validated input the page was built from, for grounding.
 * @param feedback - What the operator asked to change.
 * @param refreshFn - Authors the revision.
 * @returns The revised page and what changed.
 * @throws {ValidationError} If the page references an unknown entity, or the
 * revision fails schema validation.
 */
export async function refreshPage(
  page: GeneratedPage,
  input: ValidatedInputData,
  feedback: string,
  refreshFn: RefreshContentFn,
): Promise<RefreshResult> {
  const business = input.businesses.find((item) => item.id === page.businessId);
  const service = input.services.find((item) => item.id === page.serviceId);
  const location = input.locations.find((item) => item.id === page.locationId);

  if (business === undefined || service === undefined || location === undefined) {
    const missing: ValidationIssue[] = [
      {
        path: `pages[${page.slug}]`,
        message:
          `Cannot revise: unknown business="${page.businessId}", ` +
          `service="${page.serviceId}", location="${page.locationId}".`,
      },
    ];
    throw new ValidationError("refresh", missing);
  }

  const previousContentHash = computeContentHash(page);
  const sourceHash = computeSourceHash(business, service, location, input.content);

  const { content, provenance } = await refreshFn({
    businessName: business.name,
    serviceName: service.name,
    cityName: location.city,
    contentProfileId: page.contentProfileId,
    // Grounding applies to a revision exactly as it does to a fresh page. If
    // anything, more so: the model has prose in front of it and an instruction
    // to change it, which is when an invention is easiest to slip in.
    facts: buildGroundingFacts(business, service, {
      services: input.services,
      locations: input.locations,
    }),
    current: {
      title: page.title,
      metaDescription: page.metaDescription,
      h1: page.h1,
      content: page.content,
    },
    feedback,
  });

  const merged = {
    ...page,
    // Only the authored slice moves.
    title: content.title,
    metaDescription: content.metaDescription,
    h1: content.h1,
    content: content.content,
    // Realigned, like the authoring pass and the block patch already do. This
    // path was the last one still leaving structured data describing the copy
    // it had just replaced — a crawler told one thing while the reader saw
    // another, which is a documented negative signal on a product that exists
    // to rank.
    schemaOrg: {
      ...page.schemaOrg,
      name: content.h1,
      description: content.metaDescription,
    },
    generation: {
      promptVersion: provenance.promptVersion,
      modelVersion: provenance.modelVersion,
      profileId: provenance.profileId,
      sourceHash,
      // contentHash is deliberately absent here. It describes the *accepted*
      // page, so it is computed after validation — and a placeholder would have
      // to be a value the contract accepts, which would make it a lie.
      refreshedFrom: feedback,
      generatedAt: new Date().toISOString(),
    },
  };

  const result = GeneratedPageSchema.safeParse(merged);

  if (!result.success) {
    throw new ValidationError(
      "refresh",
      result.error.issues.map((issue) => ({
        path: `pages[${page.slug}].${issue.path.join(".")}`,
        message: issue.message,
      })),
    );
  }

  // Computed after validation, over the accepted page, so the fingerprint
  // always describes content that actually passed the contract.
  const contentHash = computeContentHash(result.data);

  return {
    page: { ...result.data, generation: { ...result.data.generation!, contentHash } },
    previousContentHash,
    contentHash,
    changed: contentHash !== previousContentHash,
  };
}
