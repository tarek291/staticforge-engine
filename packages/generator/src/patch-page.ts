import {
  buildGroundingFacts,
  GeneratedPageContentSchema,
  type GeneratedPageContent,
} from "@staticforge/ai";
import { collectGroundingIssues } from "@staticforge/ai";
import {
  getAtPath,
  parseBlockPath,
  setAtPath,
  type PatchIssue,
} from "@staticforge/core";
import {
  CONTENT_PROFILES,
  DEFAULT_CONTENT_PROFILE,
  collectContentIssues,
  type GeneratedPage,
} from "@staticforge/schemas";

import { computeContentHash } from "./refresh-page.js";
import type { ValidatedInputData } from "./types.js";

/**
 * Patching one block of a published page.
 *
 * The operation a visual editor needs, and the one the engine has spent every
 * previous phase making safe to offer. A partial edit is more dangerous than a
 * whole rewrite, not less: a rewrite arrives as a complete page and is judged
 * as one, while a patch arrives as a fragment and *looks* too small to check.
 *
 * So it is checked exactly as hard. The merged page goes through the same three
 * gates a model's answer does — the structural contract, the quality profile,
 * and the verified record — and a failure at any of them discards the patch
 * whole. There is no partial application: the page an editor was looking at is
 * the page that stays published.
 *
 * ## What a patch may touch
 *
 * The authored slice, and nothing else: `title`, `metaDescription`, `h1`, and
 * anything inside `content`. That is the same boundary the model is held to,
 * for the same reason — `slug` is a published URL and every inbound link to it,
 * `links` is a graph computed over the whole build, and the entity ids are what
 * the page *is*. None of those are an editor's to move, and freezing them here
 * means a bug in the editor cannot move them either.
 *
 * `schemaOrg` is not patchable but is not frozen either: it is *derived*. A
 * patch that changes the heading realigns it, because structured data
 * describing copy that was just replaced is the drift this engine already fixed
 * once and should not reintroduce through a new door.
 */

/** Fields a patch may address, as path prefixes. */
const PATCHABLE_ROOTS = new Set(["title", "metaDescription", "h1", "content"]);

/** Which gate refused a patch. */
export type PatchRejectionStage = "path" | "schema" | "profile" | "grounding";

/** A patch that was refused, and why. */
export interface PatchRejected {
  ok: false;
  stage: PatchRejectionStage;
  issues: PatchIssue[];
}

/** A patch that passed every gate. */
export interface PatchAccepted {
  ok: true;
  page: GeneratedPage;
  /** Fingerprint of the authored slice before the patch. */
  previousContentHash: string;
  contentHash: string;
  /** Whether the patch actually altered anything. */
  changed: boolean;
}

export type PatchResult = PatchAccepted | PatchRejected;

/** Refuse, in the shape every caller handles. */
function reject(
  stage: PatchRejectionStage,
  issues: PatchIssue[],
): PatchRejected {
  return { ok: false, stage, issues };
}

/**
 * Apply one block patch to a page and run every gate over the result.
 *
 * Pure: it reads nothing and writes nothing. The caller loads the page, decides
 * what to do with the verdict, and persists only on success — which is what
 * makes the whole decision testable without a database.
 *
 * @param page - The page as it stands.
 * @param input - The validated input the page was built from, for grounding.
 * @param blockPath - What to replace, e.g. `content.faq.0.answer`.
 * @param value - What to replace it with.
 * @returns The accepted page, or the gate that refused it.
 */
export function patchPageContent(
  page: GeneratedPage,
  input: ValidatedInputData,
  blockPath: string,
  value: unknown,
): PatchResult {
  const parsed = parseBlockPath(blockPath);

  if (!parsed.ok) {
    return reject("path", [parsed.issue]);
  }

  const [root] = parsed.segments;

  if (root === undefined || !PATCHABLE_ROOTS.has(root)) {
    return reject("path", [
      {
        path: blockPath,
        message:
          `"${root ?? ""}" is not editable. A patch may change ` +
          `${[...PATCHABLE_ROOTS].join(", ")} — a slug is a published URL and ` +
          `every link pointing at it, and the link graph is computed over the ` +
          `whole build.`,
      },
    ]);
  }

  // The authored slice, on its own. Patching the whole page would let a path
  // reach a field the boundary above just refused.
  const current: GeneratedPageContent = {
    title: page.title,
    metaDescription: page.metaDescription,
    h1: page.h1,
    content: page.content,
  };

  const previousContentHash = computeContentHash(current);

  if (getAtPath(current, parsed.segments) === undefined) {
    return reject("path", [
      {
        path: blockPath,
        message:
          "That path does not address anything on this page. Patching replaces " +
          "existing content; it does not create fields or list entries.",
      },
    ]);
  }

  const applied = setAtPath(current, parsed.segments, value);

  if (!applied.ok) {
    return reject("path", [applied.issue]);
  }

  // --- Gate 1: the structural contract ---
  const structural = GeneratedPageContentSchema.safeParse(applied.value);

  if (!structural.success) {
    // The common case, and the reason this gate cannot be skipped: an editor
    // that clears a required heading sends a perfectly well-formed patch.
    return reject(
      "schema",
      structural.error.issues.map((issue) => ({
        path: issue.path.join(".") || blockPath,
        message: issue.message,
      })),
    );
  }

  const patched = structural.data;

  // --- Gate 2: the quality profile this page is held to ---
  const profile = Object.hasOwn(CONTENT_PROFILES, page.contentProfileId)
    ? (CONTENT_PROFILES[page.contentProfileId] ?? DEFAULT_CONTENT_PROFILE)
    : undefined;

  if (profile === undefined) {
    return reject("profile", [
      {
        path: "contentProfileId",
        message:
          `This page names an unregistered content profile ` +
          `"${page.contentProfileId}", so there is no standard to hold the ` +
          `edit to. Falling back to a default would judge it by rules nobody chose.`,
      },
    ]);
  }

  const probe: GeneratedPage = { ...page, ...patched };
  const profileIssues = collectContentIssues(probe, profile);

  if (profileIssues.length > 0) {
    return reject("profile", profileIssues);
  }

  // --- Gate 3: the verified record ---
  const business = input.businesses.find((item) => item.id === page.businessId);
  const service = input.services.find((item) => item.id === page.serviceId);
  const location = input.locations.find((item) => item.id === page.locationId);

  if (business === undefined || service === undefined || location === undefined) {
    // No record can be built, so no claim can be checked. Publishing an
    // unverifiable edit is the one outcome worse than refusing a valid one.
    return reject("grounding", [
      {
        path: blockPath,
        message:
          `Cannot verify this edit: the page names business ` +
          `"${page.businessId}", service "${page.serviceId}", location ` +
          `"${page.locationId}", and the project no longer has all three.`,
      },
    ]);
  }

  const groundingIssues = collectGroundingIssues(
    patched,
    buildGroundingFacts(business, service, {
      services: input.services,
      locations: input.locations,
    }),
  );

  if (groundingIssues.length > 0) {
    // A human typing a phone number into an editor is exactly as unverified as
    // a model inventing one, and the page is exactly as wrong.
    return reject("grounding", groundingIssues);
  }

  const contentHash = computeContentHash(patched);

  return {
    ok: true,
    page: {
      ...page,
      ...patched,
      // Derived, not carried over: structured data describing the copy this
      // patch just replaced is the drift the engine already fixed once.
      schemaOrg: { ...page.schemaOrg, name: patched.h1, description: patched.metaDescription },
    },
    previousContentHash,
    contentHash,
    changed: contentHash !== previousContentHash,
  };
}
