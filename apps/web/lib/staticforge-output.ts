import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  GeneratedPageSchema,
  ManifestSchema,
  type GeneratedPage,
  type Manifest,
} from "@staticforge/schemas";
import { SiteConfigSchema, type SiteConfig } from "@staticforge/core";

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
 * @throws {Error} If the manifest exists but fails schema validation.
 */
export async function getOutputManifest(): Promise<Manifest | null> {
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

  const parsed = ManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid manifest.json: ${summary}`);
  }
  return parsed.data;
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

/**
 * Read every generated page.
 *
 * Used where a decision needs the whole build rather than one page — locale
 * alternates, for instance, exist only relative to their siblings.
 */
export async function getGeneratedPages(): Promise<GeneratedPage[]> {
  const slugs = await getGeneratedPageSlugs();
  const pages = await Promise.all(
    slugs.map((slug) => getGeneratedPageBySlug(slug)),
  );
  return pages.filter((page): page is GeneratedPage => page !== null);
}

/**
 * Read the site configuration the generator published with.
 *
 * Derived from `robots.txt`, which the generator writes only when a base URL
 * was resolved — so its presence is exactly the signal "this build has a
 * domain". Returns `null` otherwise, and callers then emit no canonical rather
 * than inventing an origin.
 */
export async function getSiteConfig(): Promise<SiteConfig | null> {
  try {
    const robots = await readFile(
      join(resolveOutputDir(), "robots.txt"),
      "utf8",
    );

    const sitemap = /^Sitemap:\s*(\S+)$/m.exec(robots)?.[1];
    if (sitemap === undefined) {
      return null;
    }

    const parsed = SiteConfigSchema.safeParse({
      url: new URL(sitemap).origin,
    });

    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Read a published artifact verbatim.
 *
 * The generator is the single source of these files; the route handlers only
 * hand them back, so the XML a crawler sees is byte-identical to the artifact
 * on disk.
 */
export async function readPublishedArtifact(
  fileName: string,
): Promise<string | null> {
  try {
    return await readFile(join(resolveOutputDir(), fileName), "utf8");
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
