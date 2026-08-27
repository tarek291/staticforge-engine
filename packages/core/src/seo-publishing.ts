import { z } from "zod";
import type { GeneratedPage } from "@staticforge/schemas";

/**
 * The publishing layer: what a crawler is told about this site.
 *
 * Everything here is **derived**, not stored. A canonical URL is the site's
 * base plus the page's slug; an OpenGraph title is the page's title. Storing
 * them would freeze a computation into the data and leave it stale the moment
 * the domain changes — which is exactly the moment it matters most.
 *
 * The one thing that is not derivable is intent: whether a page should be
 * indexed at all. That lives on the page as `seo`, because it is a decision
 * rather than a consequence.
 */

/** Where the site lives, and how it presents itself. */
export const SiteConfigSchema = z.object({
  /** Absolute origin, no trailing slash — e.g. `https://www.example.de`. */
  url: z
    .string()
    .min(1)
    .regex(/^https?:\/\/[^\s/]+$/, "Must be an absolute origin with no path"),
  /** Shown as `og:site_name`. Falls back to the host when absent. */
  name: z.string().min(1).optional(),
  /** Paths crawlers must not visit — e.g. the preview routes. */
  disallow: z.array(z.string().min(1)).default(["/preview/"]),
});
export type SiteConfig = z.infer<typeof SiteConfigSchema>;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Join the site origin with a path, without doubling or dropping the slash. */
export function absoluteUrl(site: SiteConfig, path: string): string {
  const origin = site.url.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${suffix}`;
}

/** The URL a generated page is published at. */
export function pageUrl(site: SiteConfig, page: GeneratedPage): string {
  return absoluteUrl(site, `/${page.slug}`);
}

// ---------------------------------------------------------------------------
// Per-page metadata
// ---------------------------------------------------------------------------

/** One `hreflang` alternate. */
export interface Alternate {
  hreflang: string;
  href: string;
}

/** Everything a page's `<head>` needs, derived once. */
export interface PageMetadata {
  canonical: string;
  robots: { index: boolean; follow: boolean };
  openGraph: {
    title: string;
    description: string;
    url: string;
    type: "website";
    locale: string;
    siteName: string;
  };
  /**
   * Same page in another locale, plus `x-default`.
   *
   * Empty when the build has only one locale: a lone `hreflang` pointing at
   * itself tells a crawler nothing and is noise in the head.
   */
  alternates: Alternate[];
}

/**
 * Derive a page's publishing metadata.
 *
 * @param page - The page being published.
 * @param site - Where the site lives.
 * @param allPages - Every page in the build, used to find locale alternates.
 * A page is an alternate of this one when it covers the same service in the
 * same place in a different locale.
 */
export function buildPageMetadata(
  page: GeneratedPage,
  site: SiteConfig,
  allPages: GeneratedPage[] = [],
): PageMetadata {
  const self = pageUrl(site, page);
  const host = site.url.replace(/^https?:\/\//, "");

  const translations = allPages.filter(
    (other) =>
      other.slug !== page.slug &&
      other.serviceId === page.serviceId &&
      other.locationId === page.locationId &&
      other.locale !== page.locale,
  );

  const alternates: Alternate[] =
    translations.length === 0
      ? []
      : [
          { hreflang: page.locale, href: self },
          ...translations.map((other) => ({
            hreflang: other.locale,
            href: pageUrl(site, other),
          })),
          { hreflang: "x-default", href: self },
        ];

  return {
    canonical: page.seo?.canonical ?? self,
    robots: {
      index: page.seo?.index ?? true,
      follow: page.seo?.follow ?? true,
    },
    openGraph: {
      title: page.title,
      description: page.metaDescription,
      url: self,
      type: "website",
      locale: page.locale,
      siteName: site.name ?? host,
    },
    alternates,
  };
}

/** Whether a page belongs in the sitemap. */
export function isIndexable(page: GeneratedPage): boolean {
  return page.seo?.index ?? true;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * Escape the five characters XML reserves.
 *
 * Slugs are already restricted to `[a-z0-9-]`, but a canonical override is free
 * text — and an unescaped `&` in a URL is the classic way a sitemap silently
 * becomes malformed and is dropped whole.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The protocol's hard ceiling on URLs in one sitemap file. */
export const SITEMAP_URL_LIMIT = 50_000;

/** Options for sitemap generation. */
export interface SitemapOptions {
  /** URLs per file. Defaults to the protocol limit; lowered in tests. */
  urlsPerFile?: number;
}

/** Split a list into fixed-size chunks. */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** One `<url>` entry. */
function urlEntry(page: GeneratedPage, site: SiteConfig, allPages: GeneratedPage[]): string {
  const metadata = buildPageMetadata(page, site, allPages);
  const lines = [`    <loc>${escapeXml(metadata.canonical)}</loc>`];

  if (page.generation?.generatedAt !== undefined) {
    lines.push(`    <lastmod>${escapeXml(page.generation.generatedAt)}</lastmod>`);
  }

  for (const alternate of metadata.alternates) {
    lines.push(
      `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}" href="${escapeXml(alternate.href)}" />`,
    );
  }

  return `  <url>\n${lines.join("\n")}\n  </url>`;
}

/**
 * Build one sitemap document.
 *
 * Non-indexable pages are omitted rather than listed: submitting a URL while
 * telling the crawler not to index it is a contradiction, and crawlers report
 * it as one.
 */
export function buildSitemapXml(
  pages: GeneratedPage[],
  site: SiteConfig,
  allPages: GeneratedPage[] = pages,
): string {
  const entries = pages
    .filter(isIndexable)
    .map((page) => urlEntry(page, site, allPages))
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    entries,
    "</urlset>",
    "",
  ]
    .filter((line) => line.length > 0 || entries.length === 0)
    .join("\n");
}

/** Build a sitemap index pointing at several sitemap files. */
export function buildSitemapIndexXml(fileNames: string[], site: SiteConfig): string {
  const entries = fileNames
    .map(
      (name) =>
        `  <sitemap>\n    <loc>${escapeXml(absoluteUrl(site, `/${name}`))}</loc>\n  </sitemap>`,
    )
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    "</sitemapindex>",
    "",
  ].join("\n");
}

/** One generated file, ready to be written. */
export interface PublishArtifact {
  fileName: string;
  contents: string;
}

/**
 * Build every sitemap file for a build.
 *
 * Returns a single `sitemap.xml` when the pages fit in one file, and a
 * `sitemap.xml` index plus numbered parts when they do not — the split the
 * protocol requires past its per-file ceiling.
 */
export function buildSitemapArtifacts(
  pages: GeneratedPage[],
  site: SiteConfig,
  options: SitemapOptions = {},
): PublishArtifact[] {
  const perFile = options.urlsPerFile ?? SITEMAP_URL_LIMIT;
  const indexable = pages.filter(isIndexable);
  const chunks = chunk(indexable, Math.max(1, perFile));

  if (chunks.length <= 1) {
    return [
      { fileName: "sitemap.xml", contents: buildSitemapXml(indexable, site, pages) },
    ];
  }

  const parts = chunks.map((part, index) => ({
    fileName: `sitemap-${index + 1}.xml`,
    contents: buildSitemapXml(part, site, pages),
  }));

  return [
    {
      fileName: "sitemap.xml",
      contents: buildSitemapIndexXml(
        parts.map((part) => part.fileName),
        site,
      ),
    },
    ...parts,
  ];
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/**
 * Build `robots.txt`.
 *
 * Points at the sitemap and closes off the paths that exist but must not be
 * indexed — the template preview routes above all, which render real content
 * under a URL that is not the canonical one.
 */
export function buildRobotsTxt(site: SiteConfig): string {
  const lines = ["User-agent: *", "Allow: /"];

  for (const path of site.disallow) {
    lines.push(`Disallow: ${path.startsWith("/") ? path : `/${path}`}`);
  }

  lines.push("", `Sitemap: ${absoluteUrl(site, "/sitemap.xml")}`, "");

  return lines.join("\n");
}

/** Build every publishing artifact for a build. */
export function buildPublishArtifacts(
  pages: GeneratedPage[],
  site: SiteConfig,
  options: SitemapOptions = {},
): PublishArtifact[] {
  return [
    ...buildSitemapArtifacts(pages, site, options),
    { fileName: "robots.txt", contents: buildRobotsTxt(site) },
  ];
}
