import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  GeneratedPageSchema,
  type GeneratedPage,
  type Manifest,
} from "@staticforge/schemas";
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

/**
 * Write generated pages to disk as individual JSON files plus a manifest.
 *
 * Output structure (all inside `outputDir`):
 * - `outputDir/pages/{slug}.json` — one pretty-printed page per file
 * - `outputDir/manifest.json` — summary index of every written page
 *
 * Every page is validated against {@link GeneratedPageSchema} *before* anything
 * is written; if any page is invalid a single {@link ValidationError} is thrown
 * and no files are touched. The output directory is never deleted — only stale
 * `.json` files inside `outputDir/pages/` are removed before writing.
 *
 * The only side effect is writing inside the requested `outputDir`.
 *
 * @param pages - The pages to persist.
 * @param outputDir - Directory to write into (created if missing).
 * @throws {ValidationError} If any page fails schema validation.
 */
export async function savePages(
  pages: GeneratedPage[],
  outputDir: string,
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

  const pagesDir = join(outputDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  // Remove only stale page JSON files; never delete the directory itself.
  const existing = await readdir(pagesDir);
  await Promise.all(
    existing
      .filter((name) => name.endsWith(".json"))
      .map((name) => unlink(join(pagesDir, name))),
  );

  // Write one pretty-printed JSON file per page.
  await Promise.all(
    validated.map((page) =>
      writeFile(
        join(pagesDir, `${page.slug}.json`),
        `${JSON.stringify(page, null, 2)}\n`,
        "utf-8",
      ),
    ),
  );

  // Write the manifest summarizing every page.
  const manifest: Manifest = {
    count: validated.length,
    pages: validated.map((page) => ({
      slug: page.slug,
      locale: page.locale,
      title: page.title,
      metaDescription: page.metaDescription,
    })),
  };
  await writeFile(
    join(outputDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}
