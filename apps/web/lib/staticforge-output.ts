import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GeneratedPageSchema, type GeneratedPage } from "@staticforge/schemas";

/** A single entry in the generator's output manifest. */
export interface OutputManifestEntry {
  slug: string;
  locale: string;
  title: string;
  metaDescription: string;
}

/** Shape of `data/output/manifest.json` produced by @staticforge/generator. */
export interface OutputManifest {
  count: number;
  pages: OutputManifestEntry[];
}

/** Narrow an unknown error to a Node system error carrying a `code`. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Resolve the generator output directory.
 *
 * Prefers `STATICFORGE_OUTPUT_DIR` when set; otherwise falls back to the
 * repo's `data/output` relative to the web app's working directory
 * (`apps/web`), since app scripts run from there.
 */
function resolveOutputDir(): string {
  return (
    process.env.STATICFORGE_OUTPUT_DIR ??
    resolve(process.cwd(), "../../data/output")
  );
}

/**
 * Read the generator output manifest at build time.
 *
 * Reads strictly from `<outputDir>/manifest.json`. Returns `null` (rather than
 * throwing) when the manifest does not exist yet, so the UI can render a
 * neutral fallback. Other read/parse errors are propagated.
 *
 * @returns The parsed manifest, or `null` if it is missing.
 */
export async function getOutputManifest(): Promise<OutputManifest | null> {
  const manifestPath = join(resolveOutputDir(), "manifest.json");

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  return JSON.parse(raw) as OutputManifest;
}

/**
 * Read the list of generated page slugs from the manifest.
 *
 * @returns Every slug present in the manifest (empty array if no manifest yet).
 */
export async function getGeneratedPageSlugs(): Promise<string[]> {
  const manifest = await getOutputManifest();
  if (manifest === null) {
    return [];
  }
  return manifest.pages.map((page) => page.slug);
}

/**
 * Read and validate a single generated page by slug.
 *
 * Reads `<outputDir>/pages/<slug>.json` and validates it against
 * {@link GeneratedPageSchema}. Returns `null` when the file does not exist, so
 * callers can render a 404. Throws a clear error if the file exists but does
 * not conform to the schema.
 *
 * @param slug - The page slug to load.
 * @returns The validated page, or `null` if no file exists for the slug.
 */
export async function getGeneratedPageBySlug(
  slug: string,
): Promise<GeneratedPage | null> {
  const pagePath = join(resolveOutputDir(), "pages", `${slug}.json`);

  let raw: string;
  try {
    raw = await readFile(pagePath, "utf-8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const parsed = GeneratedPageSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Invalid generated page JSON for slug "${slug}": ${summary}`,
    );
  }
  return parsed.data;
}
