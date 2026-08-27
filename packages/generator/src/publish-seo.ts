import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SiteConfigSchema,
  buildPublishArtifacts,
  type PublishArtifact,
  type SiteConfig,
  type SitemapOptions,
} from "@staticforge/core";
import type { GeneratedPage } from "@staticforge/schemas";

/**
 * Writes the files a crawler asks for.
 *
 * The artifacts are built from the pages that were actually generated, so the
 * sitemap can never advertise a URL the build did not produce — the failure
 * mode of every hand-maintained sitemap.
 */

/** Where the site's base URL came from, for a legible log line. */
export type SiteUrlSource = "flag" | "env" | "content";

/** Resolved site configuration, or the reason there is none. */
export interface ResolvedSite {
  site: SiteConfig;
  source: SiteUrlSource;
}

/**
 * Resolve the site's base URL.
 *
 * Precedence runs from most specific to least: an explicit flag beats the
 * environment, which beats the committed content config. That ordering is what
 * lets one repository publish to a staging domain without editing input data.
 *
 * @returns The configuration, or `undefined` when no base URL is available —
 * a local build with no domain is an ordinary situation, not an error.
 */
export function resolveSite(options: {
  flag?: string | undefined;
  env?: string | undefined;
  contentSiteUrl?: string | undefined;
  name?: string | undefined;
  disallow?: string[];
}): ResolvedSite | undefined {
  const candidates: Array<[SiteUrlSource, string | undefined]> = [
    ["flag", options.flag],
    ["env", options.env],
    ["content", options.contentSiteUrl],
  ];

  for (const [source, value] of candidates) {
    if (value === undefined || value.trim().length === 0) {
      continue;
    }

    const parsed = SiteConfigSchema.safeParse({
      url: value.trim().replace(/\/+$/, ""),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.disallow !== undefined ? { disallow: options.disallow } : {}),
    });

    if (!parsed.success) {
      throw new Error(
        `Invalid site URL from ${source}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }

    return { site: parsed.data, source };
  }

  return undefined;
}

/**
 * Write every publishing artifact into the output directory.
 *
 * They land beside the generated pages rather than inside the web app, so the
 * generator never reaches across a package boundary; the web app reads them
 * back the same way it already reads the manifest.
 *
 * @returns The artifacts written, in order.
 */
export async function publishSeoArtifacts(
  pages: GeneratedPage[],
  site: SiteConfig,
  outputDir: string,
  options: SitemapOptions = {},
): Promise<PublishArtifact[]> {
  const artifacts = buildPublishArtifacts(pages, site, options);

  await Promise.all(
    artifacts.map((artifact) =>
      writeFile(join(outputDir, artifact.fileName), artifact.contents, "utf8"),
    ),
  );

  return artifacts;
}
