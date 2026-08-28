import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  GeneratedPageSchema,
  type GeneratedPage,
  type Manifest,
} from "@staticforge/schemas";
import { noopHookBus, type HookBus } from "@staticforge/core";

import { ValidationError, type ValidationIssue } from "./errors.js";

/** Build a readable, dotted/bracketed path like `pages[slug].content.hero.heading`. */
function formatPath(
  path: ReadonlyArray<string | number>,
  prefix: string,
): string {
  let out = prefix;
  for (const segment of path) {
    out +=
      typeof segment === "number"
        ? `[${segment}]`
        : out.length > 0
          ? `.${segment}`
          : segment;
  }
  return out;
}

/** Map a `ZodError` from a single page into prefixed {@link ValidationIssue}s. */
function mapPageIssues(error: z.ZodError, slug: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path, `pages[${slug}]`),
    message: issue.message,
  }));
}

/** Context a page-write listener is told about. */
export interface SavePagesOptions {
  /** Lifecycle bus. Defaults to one with nothing installed. */
  hooks?: HookBus;
  /** Database project this run belongs to, or null in local file mode. */
  projectId?: string | null;
  /** Locale the pages carry. Read from the first page when omitted. */
  locale?: string;
}

/** Prefix for a directory being built. Dot-led, so it reads as internal. */
const STAGING_PREFIX = ".staging-";

/** Prefix for the previous `pages/`, kept only until the swap completes. */
const RETIRED_PREFIX = ".retired-";

/** Whether a filesystem error means "it was not there". */
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Remove a directory, ignoring the case where it is already gone. */
async function discard(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => {
    // Best effort. A leftover directory costs disk, not correctness, and
    // failing a completed run over cleanup would trade the cheap problem for
    // the expensive one.
  });
}

/**
 * Sweep staging and retired directories left by a run that did not finish.
 *
 * They are inert — the web app and the validate stage read `pages/` and
 * `manifest.json` and nothing else — so this is housekeeping, not recovery. It
 * runs before writing, so a repeatedly crashing run cannot accumulate copies of
 * a site on disk indefinitely.
 */
async function sweepLeftovers(outputDir: string): Promise<void> {
  const entries = await readdir(outputDir).catch((error: unknown) => {
    if (isMissing(error)) {
      return [] as string[];
    }
    throw error;
  });

  await Promise.all(
    entries
      .filter(
        (name) =>
          name.startsWith(STAGING_PREFIX) || name.startsWith(RETIRED_PREFIX),
      )
      .map((name) => discard(join(outputDir, name))),
  );
}

/**
 * Write generated pages to disk as individual JSON files plus a manifest.
 *
 * Output structure (all inside `outputDir`):
 * - `outputDir/pages/{slug}.json` — one pretty-printed page per file
 * - `outputDir/manifest.json` — summary index of every written page
 *
 * Every page is validated against {@link GeneratedPageSchema} *before* anything
 * is written; if any page is invalid a single {@link ValidationError} is thrown
 * and no files are touched.
 *
 * ## Why the write is staged
 *
 * The published site *is* this directory. The straightforward implementation —
 * delete every stale page, then write the new ones — leaves the site destroyed
 * for the whole duration of the write, and that span is the one long enough to
 * actually be interrupted: a crash, a killed job, a machine losing power. What
 * survives is an empty or half-populated directory, and the last good copy is
 * already gone.
 *
 * So the new site is built beside the old one and swapped in at the end:
 *
 * 1. Write every page and the manifest into a staging directory.
 * 2. Move the live `pages/` aside.
 * 3. Move staging's `pages/` into place.
 * 4. Move the manifest over the old one — a file rename replaces atomically.
 * 5. Discard what was moved aside.
 *
 * The exposure shrinks from "the length of the whole write" to the gap between
 * steps 2 and 3, which is two directory-entry renames. A failure before step 2
 * leaves the old site untouched; a failure between 2 and 3 is rolled back
 * explicitly; a failure after 3 leaves the new site live with stale
 * housekeeping, which the next run sweeps.
 *
 * This is not a true atomic directory swap. POSIX offers none portably, and
 * Windows refuses a rename onto an existing directory. It is the closest thing
 * that works on both, and it closes the window that actually gets hit.
 *
 * The only side effect is writing inside the requested `outputDir`.
 *
 * @param pages - The pages to persist.
 * @param outputDir - Directory to write into (created if missing).
 * @param options - Lifecycle bus and the context a listener needs.
 * @throws {ValidationError} If any page fails schema validation.
 */
export async function savePages(
  pages: GeneratedPage[],
  outputDir: string,
  options: SavePagesOptions = {},
): Promise<void> {
  // Validate everything first so a bad page never produces partial output.
  const validated: GeneratedPage[] = [];
  const issues: ValidationIssue[] = [];
  for (const page of pages) {
    const result = GeneratedPageSchema.safeParse(page);
    if (result.success) {
      validated.push(result.data);
    } else {
      issues.push(...mapPageIssues(result.error, page.slug));
    }
  }
  if (issues.length > 0) {
    throw new ValidationError("pages", issues);
  }

  const hooks = options.hooks ?? noopHookBus();
  const context = {
    projectId: options.projectId ?? null,
    outputDir,
    locale: options.locale ?? validated[0]?.locale ?? "de",
    pageCount: validated.length,
    slugs: validated.map((page) => page.slug),
  };

  // Announced before the destructive part, and observational only: a listener
  // cannot stop this or change what is written. Offering a veto here would put
  // a plugin between validated content and the disk, which is precisely where
  // nothing third-party belongs.
  await hooks.emit("beforePagesWritten", context);

  await mkdir(outputDir, { recursive: true });
  await sweepLeftovers(outputDir);

  // Unique per run, so two processes writing the same directory stage into
  // different places rather than into each other.
  const token = `${process.pid}-${Date.now().toString(36)}`;
  const stagingDir = join(outputDir, `${STAGING_PREFIX}${token}`);
  const stagingPages = join(stagingDir, "pages");
  const stagingManifest = join(stagingDir, "manifest.json");
  const retiredPages = join(outputDir, `${RETIRED_PREFIX}${token}`);

  const pagesDir = join(outputDir, "pages");
  const manifestPath = join(outputDir, "manifest.json");

  try {
    await mkdir(stagingPages, { recursive: true });

    // One pretty-printed JSON file per page.
    await Promise.all(
      validated.map((page) =>
        writeFile(
          join(stagingPages, `${page.slug}.json`),
          `${JSON.stringify(page, null, 2)}\n`,
          "utf-8",
        ),
      ),
    );

    const manifest: Manifest = {
      count: validated.length,
      pages: validated.map((page) => ({
        slug: page.slug,
        locale: page.locale,
        title: page.title,
        metaDescription: page.metaDescription,
        templateId: page.templateId,
      })),
    };

    await writeFile(
      stagingManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );
  } catch (error: unknown) {
    // Nothing has been swapped, so the live site is still the previous one.
    await discard(stagingDir);
    throw error;
  }

  // --- The swap. Everything above is preparation; only this is destructive. ---

  let moved = false;

  try {
    try {
      await rename(pagesDir, retiredPages);
      moved = true;
    } catch (error: unknown) {
      // No previous run wrote here, so there is nothing to move aside.
      if (!isMissing(error)) {
        throw error;
      }
    }

    await rename(stagingPages, pagesDir);
  } catch (error: unknown) {
    // Put the old site back rather than leave no site at all.
    if (moved) {
      await rename(retiredPages, pagesDir).catch(() => {
        // The rollback itself failed. The retired copy is still on disk under a
        // known name, which is the most this layer can preserve.
      });
    }
    await discard(stagingDir);
    throw error;
  }

  // A file rename replaces the destination atomically on both platforms, so the
  // manifest is never absent and never half-written: it is the old one or the
  // new one. It moves last because the validate stage cross-checks it against
  // the pages directory, and a manifest ahead of its pages would read as
  // corruption rather than as progress.
  await rename(stagingManifest, manifestPath);

  await discard(retiredPages);
  await discard(stagingDir);

  // After the swap, so a listener told the pages are written can rely on a
  // reader seeing them.
  await hooks.emit("afterPagesWritten", {
    ...context,
    writtenAt: new Date().toISOString(),
  });
}
