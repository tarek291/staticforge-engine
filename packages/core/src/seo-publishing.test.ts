import { GeneratedPageSchema, type GeneratedPage } from "@staticforge/schemas";
import { describe, expect, test } from "vitest";

import {
  SITEMAP_URL_LIMIT,
  SiteConfigSchema,
  absoluteUrl,
  buildPageMetadata,
  buildPublishArtifacts,
  buildRobotsTxt,
  buildSitemapArtifacts,
  buildSitemapIndexXml,
  buildSitemapXml,
  escapeXml,
  isIndexable,
  pageUrl,
  type SiteConfig,
} from "./seo-publishing.js";

const SITE: SiteConfig = SiteConfigSchema.parse({
  url: "https://www.glanzfix.de",
  name: "GlanzFix",
});

function page(overrides: Partial<GeneratedPage> = {}): GeneratedPage {
  return GeneratedPageSchema.parse({
    slug: "bueroreinigung-duisburg",
    locale: "de",
    title: "Büroreinigung in Duisburg",
    metaDescription: "Professionelle Büroreinigung in Duisburg für Unternehmen.",
    h1: "Saubere Büros in Duisburg",
    content: {
      hero: { heading: "Büroreinigung in Duisburg" },
      sections: [{ heading: "Ablauf", body: "B".repeat(200) }],
      faq: [{ question: "Wie schnell?", answer: "Wenige Tage." }],
      cta: { heading: "Angebot", buttonLabel: "Anfragen", href: "#contact" },
    },
    schemaOrg: { "@type": "Service" },
    templateId: "default",
    businessId: "biz-1",
    serviceId: "svc-office",
    locationId: "loc-duisburg",
    ...overrides,
  });
}

/** Very small parse check: every opened tag is closed, in order. */
function tagsBalance(xml: string): boolean {
  const stack: string[] = [];
  for (const match of xml.matchAll(/<(\/?)([a-zA-Z:][\w:.-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match;
    if (name === undefined) continue;
    if (selfClosing === "/" || match[0].startsWith("<?")) continue;
    if (closing === "/") {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

describe("URL building", () => {
  test("joins origin and path without doubling the slash", () => {
    expect(absoluteUrl(SITE, "/robots.txt")).toBe(
      "https://www.glanzfix.de/robots.txt",
    );
    expect(absoluteUrl(SITE, "robots.txt")).toBe(
      "https://www.glanzfix.de/robots.txt",
    );
  });

  test("tolerates a trailing slash on the configured origin", () => {
    const sloppy = SiteConfigSchema.parse({ url: "https://www.glanzfix.de" });
    expect(absoluteUrl({ ...sloppy, url: "https://www.glanzfix.de/" }, "/x")).toBe(
      "https://www.glanzfix.de/x",
    );
  });

  test("a page's URL is the origin plus its slug", () => {
    expect(pageUrl(SITE, page())).toBe(
      "https://www.glanzfix.de/bueroreinigung-duisburg",
    );
  });

  test("rejects a base URL that carries a path", () => {
    expect(SiteConfigSchema.safeParse({ url: "https://x.de/de" }).success).toBe(false);
    expect(SiteConfigSchema.safeParse({ url: "www.glanzfix.de" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("page metadata", () => {
  test("derives the canonical from the site and the slug", () => {
    expect(buildPageMetadata(page(), SITE).canonical).toBe(
      "https://www.glanzfix.de/bueroreinigung-duisburg",
    );
  });

  test("an explicit canonical override wins", () => {
    const consolidated = page({ seo: { index: true, follow: true, canonical: "https://www.glanzfix.de/other" } });

    expect(buildPageMetadata(consolidated, SITE).canonical).toBe(
      "https://www.glanzfix.de/other",
    );
  });

  test("defaults to indexable and followable", () => {
    expect(buildPageMetadata(page(), SITE).robots).toEqual({
      index: true,
      follow: true,
    });
  });

  test("honours a noindex decision", () => {
    const hidden = page({ seo: { index: false, follow: true } });

    expect(buildPageMetadata(hidden, SITE).robots.index).toBe(false);
  });

  test("builds OpenGraph tags from the page's own fields", () => {
    expect(buildPageMetadata(page(), SITE).openGraph).toEqual({
      title: "Büroreinigung in Duisburg",
      description: "Professionelle Büroreinigung in Duisburg für Unternehmen.",
      url: "https://www.glanzfix.de/bueroreinigung-duisburg",
      type: "website",
      locale: "de",
      siteName: "GlanzFix",
    });
  });

  test("falls back to the host when no site name is configured", () => {
    const unnamed = SiteConfigSchema.parse({ url: "https://www.glanzfix.de" });

    expect(buildPageMetadata(page(), unnamed).openGraph.siteName).toBe(
      "www.glanzfix.de",
    );
  });

  test("emits no alternates for a single-locale build", () => {
    // A lone hreflang pointing at itself tells a crawler nothing.
    expect(buildPageMetadata(page(), SITE, [page()]).alternates).toEqual([]);
  });

  test("emits alternates and x-default when a translation exists", () => {
    const german = page();
    const english = page({ slug: "office-cleaning-duisburg", locale: "en" });

    const alternates = buildPageMetadata(german, SITE, [german, english]).alternates;

    expect(alternates).toEqual([
      { hreflang: "de", href: "https://www.glanzfix.de/bueroreinigung-duisburg" },
      { hreflang: "en", href: "https://www.glanzfix.de/office-cleaning-duisburg" },
      { hreflang: "x-default", href: "https://www.glanzfix.de/bueroreinigung-duisburg" },
    ]);
  });

  test("does not treat a different service as a translation", () => {
    const other = page({ slug: "grundreinigung-duisburg", serviceId: "svc-deep", locale: "en" });

    expect(buildPageMetadata(page(), SITE, [page(), other]).alternates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// XML correctness
// ---------------------------------------------------------------------------

describe("XML escaping", () => {
  test("escapes the five reserved characters", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  test("an ampersand in a canonical cannot break the document", () => {
    const tricky = page({
      seo: { index: true, follow: true, canonical: "https://x.de/a?b=1&c=2" },
    });

    const xml = buildSitemapXml([tricky], SITE);

    expect(xml).toContain("b=1&amp;c=2");
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(tagsBalance(xml)).toBe(true);
  });
});

describe("sitemap document", () => {
  test("declares the XML prolog and the sitemap namespace", () => {
    const xml = buildSitemapXml([page()], SITE);

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(
      'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    );
  });

  test("is well-formed", () => {
    expect(tagsBalance(buildSitemapXml([page(), page({ slug: "a-b" })], SITE))).toBe(
      true,
    );
  });

  test("lists one loc per page, absolute", () => {
    const xml = buildSitemapXml([page(), page({ slug: "grundreinigung-essen" })], SITE);

    expect(xml).toContain("<loc>https://www.glanzfix.de/bueroreinigung-duisburg</loc>");
    expect(xml).toContain("<loc>https://www.glanzfix.de/grundreinigung-essen</loc>");
    expect([...xml.matchAll(/<loc>/g)]).toHaveLength(2);
  });

  test("omits pages marked noindex", () => {
    const hidden = page({ slug: "hidden-page", seo: { index: false, follow: true } });
    const xml = buildSitemapXml([page(), hidden], SITE);

    // Submitting a URL while asking a crawler not to index it is a
    // contradiction, and crawlers report it as one.
    expect(xml).not.toContain("hidden-page");
    expect([...xml.matchAll(/<loc>/g)]).toHaveLength(1);
  });

  test("includes lastmod when the page records when it was written", () => {
    const dated = page({
      generation: {
        promptVersion: "1.0.0",
        modelVersion: "claude-opus-5",
        profileId: "default",
        sourceHash: "abc123",
        generatedAt: "2026-08-27T10:00:00.000Z",
      },
    });

    expect(buildSitemapXml([dated], SITE)).toContain(
      "<lastmod>2026-08-27T10:00:00.000Z</lastmod>",
    );
  });

  test("omits lastmod when nothing recorded it", () => {
    expect(buildSitemapXml([page()], SITE)).not.toContain("<lastmod>");
  });

  test("carries hreflang alternates into the entry", () => {
    const german = page();
    const english = page({ slug: "office-cleaning-duisburg", locale: "en" });

    const xml = buildSitemapXml([german, english], SITE, [german, english]);

    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain('hreflang="x-default"');
  });

  test("handles an empty build without emitting a broken document", () => {
    const xml = buildSitemapXml([], SITE);

    expect(tagsBalance(xml)).toBe(true);
    expect(xml).not.toContain("<loc>");
  });
});

describe("sitemap splitting", () => {
  function manyPages(count: number): GeneratedPage[] {
    return Array.from({ length: count }, (_unused, index) =>
      page({ slug: `page-${index}` }),
    );
  }

  test("emits a single file when the pages fit", () => {
    const artifacts = buildSitemapArtifacts(manyPages(5), SITE);

    expect(artifacts.map((a) => a.fileName)).toEqual(["sitemap.xml"]);
  });

  test("emits an index plus parts when they do not", () => {
    const artifacts = buildSitemapArtifacts(manyPages(5), SITE, { urlsPerFile: 2 });

    expect(artifacts.map((a) => a.fileName)).toEqual([
      "sitemap.xml",
      "sitemap-1.xml",
      "sitemap-2.xml",
      "sitemap-3.xml",
    ]);
  });

  test("the index points at every part, absolutely", () => {
    const [index] = buildSitemapArtifacts(manyPages(3), SITE, { urlsPerFile: 1 });

    expect(index?.contents).toContain("<sitemapindex");
    expect(index?.contents).toContain(
      "<loc>https://www.glanzfix.de/sitemap-1.xml</loc>",
    );
    expect(tagsBalance(index?.contents ?? "")).toBe(true);
  });

  test("every URL appears exactly once across the parts", () => {
    const artifacts = buildSitemapArtifacts(manyPages(5), SITE, { urlsPerFile: 2 });
    const locs = artifacts
      .slice(1)
      .flatMap((artifact) => [...artifact.contents.matchAll(/<loc>(.*?)<\/loc>/g)])
      .map((match) => match[1]);

    expect(locs).toHaveLength(5);
    expect(new Set(locs).size).toBe(5);
  });

  test("splits at the protocol ceiling by default", () => {
    expect(SITEMAP_URL_LIMIT).toBe(50_000);
  });

  test("noindex pages are excluded before splitting", () => {
    const pages = [
      ...manyPages(2),
      page({ slug: "hidden", seo: { index: false, follow: true } }),
    ];

    const artifacts = buildSitemapArtifacts(pages, SITE, { urlsPerFile: 2 });

    expect(artifacts.map((a) => a.fileName)).toEqual(["sitemap.xml"]);
  });

  test("buildSitemapIndexXml is well-formed", () => {
    expect(tagsBalance(buildSitemapIndexXml(["a.xml", "b.xml"], SITE))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

describe("robots.txt", () => {
  test("allows crawling and points at the sitemap", () => {
    const robots = buildRobotsTxt(SITE);

    expect(robots).toContain("User-agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Sitemap: https://www.glanzfix.de/sitemap.xml");
  });

  test("disallows the preview routes by default", () => {
    // They render real content under a URL that is not the canonical one.
    expect(buildRobotsTxt(SITE)).toContain("Disallow: /preview/");
  });

  test("respects a configured disallow list", () => {
    const site = SiteConfigSchema.parse({
      url: "https://www.glanzfix.de",
      disallow: ["/intern/", "draft/"],
    });

    const robots = buildRobotsTxt(site);

    expect(robots).toContain("Disallow: /intern/");
    // A missing leading slash is normalised rather than emitted as-is.
    expect(robots).toContain("Disallow: /draft/");
  });

  test("emits no Disallow line when nothing is disallowed", () => {
    const open = SiteConfigSchema.parse({
      url: "https://www.glanzfix.de",
      disallow: [],
    });

    expect(buildRobotsTxt(open)).not.toContain("Disallow:");
  });

  test("ends with a newline, as the format expects", () => {
    expect(buildRobotsTxt(SITE).endsWith("\n")).toBe(true);
  });
});

describe("buildPublishArtifacts", () => {
  test("produces the sitemap and robots.txt together", () => {
    const artifacts = buildPublishArtifacts([page()], SITE);

    expect(artifacts.map((a) => a.fileName)).toEqual(["sitemap.xml", "robots.txt"]);
  });

  test("every artifact carries content", () => {
    for (const artifact of buildPublishArtifacts([page()], SITE)) {
      expect(artifact.contents.length).toBeGreaterThan(0);
    }
  });
});

describe("isIndexable", () => {
  test("defaults to true", () => {
    expect(isIndexable(page())).toBe(true);
  });

  test("follows an explicit decision", () => {
    expect(isIndexable(page({ seo: { index: false, follow: true } }))).toBe(false);
  });
});
