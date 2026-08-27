import { describe, expect, test } from "vitest";

import {
  CONTENT_PROFILES,
  ContentContractError,
  ContentProfileSchema,
  DEFAULT_CONTENT_PROFILE,
  STRICT_SEO_PROFILE,
  assertValidPageContent,
  collectContentIssues,
  validatePageContent,
  type ContentIssue,
  type ContentProfile,
} from "./content-profile.js";
import { GeneratedPageSchema, type GeneratedPage } from "./page.schema.js";

/**
 * Fixtures are built to *pass* the strict profile, so each test can break one
 * rule and assert that exactly that rule fires. A fixture that only passed the
 * loose profile would make strict-profile failures ambiguous.
 */

const LONG_BODY = "Wir arbeiten in festen Intervallen. ".repeat(8); // ~280 chars
const LONG_ANSWER = "Ein Termin ist meist innerhalb weniger Tage möglich. ".repeat(2);

function section(overrides: Partial<GeneratedPage["content"]["sections"][number]> = {}) {
  return {
    heading: "Wie die Reinigung abläuft",
    body: LONG_BODY,
    kind: "process" as const,
    ...overrides,
  };
}

function faqItem(overrides: Record<string, string> = {}) {
  return {
    question: "Wie schnell ist ein Termin möglich?",
    answer: LONG_ANSWER,
    ...overrides,
  };
}

/** A page that satisfies both the structural contract and the strict profile. */
function page(overrides: Partial<GeneratedPage> = {}): GeneratedPage {
  return GeneratedPageSchema.parse({
    slug: "bueroreinigung-duisburg",
    locale: "de",
    title: "Büroreinigung in Duisburg – zuverlässig und gründlich",
    metaDescription:
      "Professionelle Büroreinigung in Duisburg für Praxen, Kanzleien und Agenturen. Feste Teams, flexible Zeiten und ein verbindliches Festpreisangebot.",
    h1: "Saubere Büros in Duisburg, ohne Aufwand",
    content: {
      hero: {
        heading: "Büroreinigung in Duisburg",
        subheading: "Feste Teams, flexible Zeiten, verbindliche Preise.",
      },
      sections: [
        section({ heading: "Was die Büroreinigung umfasst", kind: "overview" }),
        section({ heading: "Wie die Reinigung abläuft", kind: "process" }),
        section({ heading: "Was die Reinigung kostet", kind: "pricing" }),
      ],
      faq: [
        faqItem({ question: "Wie schnell ist ein Termin möglich?" }),
        faqItem({ question: "Sind die Reinigungsmittel umweltfreundlich?" }),
        faqItem({ question: "Erhalte ich ein Festpreisangebot?" }),
        faqItem({ question: "Ist das Reinigungspersonal versichert?" }),
      ],
      cta: {
        heading: "Kostenloses Angebot anfordern",
        buttonLabel: "Angebot anfordern",
        href: "mailto:kontakt@glanzfix.de",
      },
    },
    schemaOrg: { "@context": "https://schema.org", "@type": "Service" },
    templateId: "default",
    businessId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    serviceId: "svc-bueroreinigung",
    locationId: "loc-duisburg",
    ...overrides,
  });
}

/** Replace part of the content block without retyping the rest. */
function withContent(patch: Record<string, unknown>): GeneratedPage {
  const base = page();
  return { ...base, content: { ...base.content, ...patch } };
}

/** Paths of every issue raised, for concise assertions. */
function paths(issues: ContentIssue[]): string[] {
  return issues.map((issue) => issue.path);
}

// ---------------------------------------------------------------------------
// Structural contract — GeneratedPageSchema
// ---------------------------------------------------------------------------

describe("structural contract", () => {
  test("accepts a well-formed page", () => {
    expect(() => page()).not.toThrow();
  });

  test("rejects a slug that is not routable", () => {
    for (const slug of ["Bueroreinigung", "büro reinigung", "-leading", "trailing-", "a--b"]) {
      const result = GeneratedPageSchema.safeParse({ ...page(), slug });
      expect(result.success, `expected "${slug}" to be rejected`).toBe(false);
    }
  });

  test("rejects an empty title and one past the search-result ceiling", () => {
    expect(GeneratedPageSchema.safeParse({ ...page(), title: "" }).success).toBe(false);
    expect(
      GeneratedPageSchema.safeParse({ ...page(), title: "T".repeat(71) }).success,
    ).toBe(false);
  });

  test("rejects a meta description past 160 characters", () => {
    expect(
      GeneratedPageSchema.safeParse({ ...page(), metaDescription: "M".repeat(161) })
        .success,
    ).toBe(false);
  });

  test("rejects a page with no sections", () => {
    const result = GeneratedPageSchema.safeParse(withContent({ sections: [] }));
    expect(result.success).toBe(false);
  });

  test("rejects a page with no FAQ entries", () => {
    const result = GeneratedPageSchema.safeParse(withContent({ faq: [] }));
    expect(result.success).toBe(false);
  });

  test("rejects a CTA href that goes nowhere", () => {
    for (const href of ["contact", "javascript:alert(1)", " ", "#"]) {
      const broken = withContent({ cta: { ...page().content.cta, href } });
      expect(
        GeneratedPageSchema.safeParse(broken).success,
        `expected "${href}" to be rejected`,
      ).toBe(false);
    }
  });

  test("accepts every link form a generated page actually uses", () => {
    for (const href of [
      "#contact",
      "/kontakt",
      "mailto:kontakt@glanzfix.de",
      "tel:+492031234567",
      "https://example.com/angebot",
    ]) {
      const ok = withContent({ cta: { ...page().content.cta, href } });
      expect(
        GeneratedPageSchema.safeParse(ok).success,
        `expected "${href}" to be accepted`,
      ).toBe(true);
    }
  });

  test("rejects an unknown section kind", () => {
    const broken = withContent({ sections: [section({ kind: "testimonial" as never })] });
    expect(GeneratedPageSchema.safeParse(broken).success).toBe(false);
  });

  test("leaves section kind optional, so existing payloads still parse", () => {
    const { kind, ...withoutKind } = section();
    void kind;
    const result = GeneratedPageSchema.safeParse(
      withContent({ sections: [withoutKind] }),
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.content.sections[0]?.kind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Profile definitions
// ---------------------------------------------------------------------------

describe("profile definitions", () => {
  test("both shipped profiles are internally valid", () => {
    expect(() => ContentProfileSchema.parse(DEFAULT_CONTENT_PROFILE)).not.toThrow();
    expect(() => ContentProfileSchema.parse(STRICT_SEO_PROFILE)).not.toThrow();
  });

  test("rejects a profile whose range is inverted", () => {
    const result = ContentProfileSchema.safeParse({
      ...DEFAULT_CONTENT_PROFILE,
      title: { min: 70, max: 10 },
    });

    expect(result.success).toBe(false);
  });

  test("the registry exposes both profiles by id", () => {
    expect(Object.keys(CONTENT_PROFILES).sort()).toEqual(["default", "strictSeo"]);
    expect(CONTENT_PROFILES.strictSeo).toBe(STRICT_SEO_PROFILE);
  });

  test("the strict profile is tighter than the default on every axis", () => {
    expect(STRICT_SEO_PROFILE.title.min).toBeGreaterThan(DEFAULT_CONTENT_PROFILE.title.min);
    expect(STRICT_SEO_PROFILE.sections.count.min).toBeGreaterThan(
      DEFAULT_CONTENT_PROFILE.sections.count.min,
    );
    expect(STRICT_SEO_PROFILE.faq.count.min).toBeGreaterThan(
      DEFAULT_CONTENT_PROFILE.faq.count.min,
    );
    expect(STRICT_SEO_PROFILE.sections.requireKind).toBe(true);
    expect(DEFAULT_CONTENT_PROFILE.sections.requireKind).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Profile enforcement
// ---------------------------------------------------------------------------

describe("profile enforcement", () => {
  test("a compliant page raises no issues under either profile", () => {
    expect(collectContentIssues(page(), DEFAULT_CONTENT_PROFILE)).toEqual([]);
    expect(collectContentIssues(page(), STRICT_SEO_PROFILE)).toEqual([]);
  });

  test("flags a title below the profile floor, naming the actual length", () => {
    const issues = collectContentIssues(page({ title: "Zu kurz" }), STRICT_SEO_PROFILE);

    expect(paths(issues)).toContain("title");
    expect(issues[0]?.message).toMatch(/Too short: 7 characters, minimum 30/);
  });

  test("flags a title above the profile ceiling", () => {
    const issues = collectContentIssues(page({ title: "T".repeat(66) }), STRICT_SEO_PROFILE);

    expect(issues[0]?.message).toMatch(/Too long: 66 characters, maximum 65/);
  });

  test("flags a meta description outside the profile range", () => {
    const issues = collectContentIssues(
      page({ metaDescription: "Kurz." }),
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toContain("metaDescription");
  });

  test("flags too few sections", () => {
    const issues = collectContentIssues(
      withContent({ sections: [section()] }),
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toContain("content.sections");
    expect(issues[0]?.message).toMatch(/Too few sections: 1, minimum 3/);
  });

  test("flags too many sections", () => {
    const many = Array.from({ length: 6 }, (_unused, index) =>
      section({ heading: `Abschnitt Nummer ${index + 1}` }),
    );
    const issues = collectContentIssues(
      withContent({ sections: many }),
      STRICT_SEO_PROFILE,
    );

    expect(issues[0]?.message).toMatch(/Too many sections: 6, maximum 5/);
  });

  test("flags a section body below the profile floor, by index", () => {
    const sections = page().content.sections;
    const issues = collectContentIssues(
      withContent({
        sections: [sections[0]!, section({ heading: "Kurzer Abschnitt hier", body: "Zu kurz." }), sections[2]!],
      }),
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toContain("content.sections[1].body");
  });

  test("flags a missing section kind when the profile requires one", () => {
    const { kind, ...withoutKind } = section();
    void kind;
    const sections = page().content.sections;
    const issues = collectContentIssues(
      withContent({ sections: [withoutKind, sections[1]!, sections[2]!] }),
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toContain("content.sections[0].kind");
    expect(issues[0]?.message).toMatch(/Missing section kind/);
  });

  test("accepts a missing kind under a profile that does not require one", () => {
    const { kind, ...withoutKind } = section({ heading: "Abschnitt ohne Kind" });
    void kind;
    const sections = page().content.sections;

    const issues = collectContentIssues(
      withContent({ sections: [withoutKind, sections[1]!] }),
      DEFAULT_CONTENT_PROFILE,
    );

    expect(issues).toEqual([]);
  });

  test("flags a section kind the profile does not permit", () => {
    const sections = page().content.sections;
    const restricted: ContentProfile = ContentProfileSchema.parse({
      ...STRICT_SEO_PROFILE,
      sections: { ...STRICT_SEO_PROFILE.sections, allowedKinds: ["overview", "process"] },
    });

    const issues = collectContentIssues(withContent({ sections }), restricted);

    expect(paths(issues)).toContain("content.sections[2].kind");
    expect(issues[0]?.message).toMatch(/"pricing" is not allowed/);
  });

  test("flags duplicate section headings", () => {
    const issues = collectContentIssues(
      withContent({
        sections: [
          section({ heading: "Was die Büroreinigung umfasst", kind: "overview" }),
          section({ heading: "Was die Büroreinigung umfasst", kind: "process" }),
          section({ heading: "Was die Reinigung kostet", kind: "pricing" }),
        ],
      }),
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toContain("content.sections[1]");
    expect(issues[0]?.message).toMatch(/Duplicate section heading/);
  });

  test("flags too few FAQ entries", () => {
    const issues = collectContentIssues(
      withContent({ faq: [faqItem()] }),
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toContain("content.faq");
    expect(issues[0]?.message).toMatch(/Too few FAQ entries: 1, minimum 4/);
  });

  test("flags a thin FAQ answer, by index", () => {
    const faq = page().content.faq;
    const issues = collectContentIssues(
      withContent({
        faq: [faq[0]!, faq[1]!, faq[2]!, faqItem({ question: "Und die Kosten?", answer: "Ja." })],
      }),
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toContain("content.faq[3].answer");
  });

  test("flags duplicate questions", () => {
    const faq = page().content.faq;
    const issues = collectContentIssues(
      withContent({ faq: [faq[0]!, faq[1]!, faq[2]!, faq[0]!] }),
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toContain("content.faq[3]");
    expect(issues[0]?.message).toMatch(/Duplicate question/);
  });

  test("flags an h1 that merely repeats the title", () => {
    const title = "Büroreinigung in Duisburg – zuverlässig und gründlich";
    const issues = collectContentIssues(page({ title, h1: title }), STRICT_SEO_PROFILE);

    expect(paths(issues)).toContain("h1");
    expect(issues.some((issue) => issue.message.includes("duplicates the title"))).toBe(
      true,
    );
  });

  test("allows an identical h1 when the profile does not forbid it", () => {
    const title = "Büroreinigung in Duisburg – zuverlässig und gründlich";

    expect(
      collectContentIssues(page({ title, h1: title }), DEFAULT_CONTENT_PROFILE),
    ).toEqual([]);
  });

  test("flags a missing hero subheading when the profile requires it", () => {
    const issues = collectContentIssues(
      withContent({ hero: { heading: "Büroreinigung in Duisburg" } }),
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toContain("content.heroSubheading");
  });

  test("flags empty schemaOrg when the profile requires it", () => {
    const issues = collectContentIssues(page({ schemaOrg: {} }), STRICT_SEO_PROFILE);

    expect(paths(issues)).toContain("content.schemaOrg");
  });

  test("flags a missing secondary CTA only for a profile that demands one", () => {
    const demanding: ContentProfile = ContentProfileSchema.parse({
      ...STRICT_SEO_PROFILE,
      requiredBlocks: [...STRICT_SEO_PROFILE.requiredBlocks, "ctaSecondary"],
    });

    expect(paths(collectContentIssues(page(), demanding))).toContain(
      "content.ctaSecondary",
    );
    expect(collectContentIssues(page(), STRICT_SEO_PROFILE)).toEqual([]);
  });

  test("reports every violation in one pass rather than stopping at the first", () => {
    const issues = collectContentIssues(
      { ...page({ title: "Kurz", metaDescription: "Auch kurz." }), h1: "Mini" },
      STRICT_SEO_PROFILE,
    );

    expect(paths(issues)).toEqual(
      expect.arrayContaining(["title", "metaDescription", "h1"]),
    );
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Untrusted input
// ---------------------------------------------------------------------------

describe("validatePageContent", () => {
  test("returns the parsed page when everything passes", () => {
    const result = validatePageContent(page(), STRICT_SEO_PROFILE);

    expect(result.ok).toBe(true);
    expect(result.ok && result.page.slug).toBe("bueroreinigung-duisburg");
  });

  test("reports schema issues and skips profile checks when the shape is wrong", () => {
    const result = validatePageContent({ slug: "x", nonsense: true }, STRICT_SEO_PROFILE);

    expect(result.ok).toBe(false);
    // Structural failures, not quality ones: a non-page cannot be judged for
    // section counts or title length.
    expect(result.ok === false && paths(result.issues)).toEqual(
      expect.arrayContaining(["locale", "title", "content"]),
    );
    expect(result.ok === false && paths(result.issues)).not.toContain("content.sections");
  });

  test("rejects a non-object outright", () => {
    for (const input of [null, undefined, 42, "page", []]) {
      expect(validatePageContent(input).ok).toBe(false);
    }
  });

  test("defaults to the default profile", () => {
    // Two sections pass the default profile but not the strict one.
    const twoSections = withContent({ sections: page().content.sections.slice(0, 2) });

    expect(validatePageContent(twoSections).ok).toBe(true);
    expect(validatePageContent(twoSections, STRICT_SEO_PROFILE).ok).toBe(false);
  });
});

describe("assertValidPageContent", () => {
  test("returns the page when it passes", () => {
    expect(assertValidPageContent(page(), STRICT_SEO_PROFILE).slug).toBe(
      "bueroreinigung-duisburg",
    );
  });

  test("throws ContentContractError carrying every issue and the profile id", () => {
    try {
      assertValidPageContent(page({ title: "Kurz" }), STRICT_SEO_PROFILE);
      throw new Error("expected assertValidPageContent to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContentContractError);
      const contractError = error as ContentContractError;
      expect(contractError.profileId).toBe("strictSeo");
      expect(paths(contractError.issues)).toContain("title");
      expect(contractError.message).toMatch(/Content contract "strictSeo" violated/);
    }
  });

  test("the error message states how many issues were found", () => {
    try {
      assertValidPageContent({ slug: "not-a-page" });
      throw new Error("expected assertValidPageContent to throw");
    } catch (error) {
      expect((error as ContentContractError).message).toMatch(/\d+ issue\(s\)/);
    }
  });
});
