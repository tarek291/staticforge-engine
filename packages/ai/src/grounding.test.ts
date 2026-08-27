import type { Business, Location, Service } from "@staticforge/schemas";
import { describe, expect, test } from "vitest";

import {
  GroundingFactsSchema,
  buildGroundingFacts,
  collectGroundingIssues,
  containsTerm,
  renderGroundingFacts,
  type GroundingFacts,
} from "./grounding.js";
import type { GeneratedPageContent } from "./service.js";

/**
 * The fixture is deliberately clean: it states nothing checkable that the
 * record does not contain. Each test then plants one specific fabrication, so a
 * failure names the guard that fired rather than "something was wrong".
 */

const FILLER =
  "Wir arbeiten in festen Intervallen und dokumentieren jeden Einsatz sorgfältig. ".repeat(
    3,
  );

const FACTS: GroundingFacts = GroundingFactsSchema.parse({
  businessName: "GlanzFix Reinigungsservice",
  foundedYear: 2014,
  emails: ["kontakt@glanzfix.de"],
  phones: ["+49 203 1234567"],
  urls: [],
  approvedServices: ["Büroreinigung", "Grundreinigung"],
  approvedCities: ["Duisburg", "Essen"],
  unapprovedServices: ["Treppenhausreinigung", "Fensterreinigung"],
  unapprovedCities: ["Düsseldorf", "Köln"],
  prices: [{ from: 25, to: 45, currency: "EUR" }],
  allowedClaims: [],
});

/** Content with no checkable claim in it beyond what the record supports. */
function content(overrides: Partial<GeneratedPageContent> = {}): GeneratedPageContent {
  return {
    title: "Büroreinigung in Duisburg – zuverlässig und gründlich",
    metaDescription:
      "Professionelle Büroreinigung in Duisburg für Praxen, Kanzleien und Agenturen. Feste Teams, flexible Zeiten und ein verbindliches Angebot.",
    h1: "Saubere Büros in Duisburg, ohne Aufwand",
    content: {
      hero: {
        heading: "Büroreinigung in Duisburg",
        subheading: "Feste Teams, flexible Zeiten, verbindliche Angebote.",
      },
      sections: [
        { heading: "Was die Büroreinigung umfasst", body: FILLER, kind: "overview" },
        { heading: "Wie die Reinigung abläuft", body: FILLER, kind: "process" },
        { heading: "Was den Preis bestimmt", body: FILLER, kind: "pricing" },
      ],
      faq: [
        { question: "Wie schnell ist ein Termin möglich?", answer: FILLER },
        { question: "Welche Mittel werden verwendet?", answer: FILLER },
        { question: "Gibt es ein verbindliches Angebot?", answer: FILLER },
        { question: "Ist das Personal versichert?", answer: FILLER },
      ],
      cta: {
        heading: "Kostenloses Angebot anfordern",
        buttonLabel: "Angebot anfordern",
        href: "#contact",
      },
    },
    ...overrides,
  };
}

/** Plant a fabrication in the first section's body. */
function withClaim(claim: string): GeneratedPageContent {
  const base = content();
  const [first, ...rest] = base.content.sections;

  return {
    ...base,
    content: {
      ...base.content,
      sections: [{ ...first!, body: `${FILLER}${claim}` }, ...rest],
    },
  };
}

/** Messages of every issue raised. */
function messages(facts: GroundingFacts, page: GeneratedPageContent): string[] {
  return collectGroundingIssues(page, facts).map((issue) => issue.message);
}

describe("clean content", () => {
  test("passes when it states nothing the record does not support", () => {
    expect(collectGroundingIssues(content(), FACTS)).toEqual([]);
  });

  test("passes when it repeats the recorded contact details verbatim", () => {
    const page = withClaim(" Schreiben Sie an kontakt@glanzfix.de oder rufen Sie +49 203 1234567 an.");

    expect(collectGroundingIssues(page, FACTS)).toEqual([]);
  });

  test("passes when it quotes a price inside the recorded range", () => {
    expect(collectGroundingIssues(withClaim(" Ab 25 EUR pro Stunde."), FACTS)).toEqual([]);
    expect(collectGroundingIssues(withClaim(" Bis zu 45 EUR pro Stunde."), FACTS)).toEqual(
      [],
    );
  });

  test("passes when it states the recorded founding year", () => {
    expect(collectGroundingIssues(withClaim(" Seit 2014 im Ruhrgebiet."), FACTS)).toEqual(
      [],
    );
  });
});

describe("fabricated contact details", () => {
  test("rejects an invented email address", () => {
    const found = messages(FACTS, withClaim(" Schreiben Sie an info@glanzfix-duisburg.de."));

    expect(found.some((m) => m.includes("Unverified email"))).toBe(true);
  });

  test("rejects an invented phone number", () => {
    const found = messages(FACTS, withClaim(" Rufen Sie +49 211 9876543 an."));

    expect(found.some((m) => m.includes("Unverified phone"))).toBe(true);
  });

  test("rejects an invented website", () => {
    const found = messages(FACTS, withClaim(" Mehr auf https://glanzfix-duisburg.example."));

    expect(found.some((m) => m.includes("Unverified URL"))).toBe(true);
  });

  test("does not mistake a short number sequence for a phone number", () => {
    // "3 bis 5 Stunden" and similar must not trip the phone detector.
    expect(collectGroundingIssues(withClaim(" Dauer: 3 bis 5 Stunden."), FACTS)).toEqual(
      [],
    );
  });

  test("names what the known contact actually is, so the fix is obvious", () => {
    const found = messages(FACTS, withClaim(" Schreiben Sie an fake@example.com."));

    expect(found.some((m) => m.includes("kontakt@glanzfix.de"))).toBe(true);
  });
});

describe("fabricated prices", () => {
  test("rejects a price above the recorded range", () => {
    const found = messages(FACTS, withClaim(" Schon ab 120 EUR pro Einsatz."));

    expect(found.some((m) => m.includes("outside every quoted range"))).toBe(true);
  });

  test("rejects a price below the recorded range", () => {
    const found = messages(FACTS, withClaim(" Bereits ab 9 EUR."));

    expect(found.some((m) => m.includes("outside every quoted range"))).toBe(true);
  });

  test("rejects any price at all when none was supplied", () => {
    const priceless = GroundingFactsSchema.parse({ ...FACTS, prices: [] });
    const found = messages(priceless, withClaim(" Ab 30 EUR pro Stunde."));

    expect(found.some((m) => m.includes("no pricing was supplied"))).toBe(true);
  });

  test("recognises a leading currency symbol", () => {
    const found = messages(FACTS, withClaim(" Nur €99 pro Monat."));

    expect(found.some((m) => m.includes("outside every quoted range"))).toBe(true);
  });

  test("reads both decimal conventions", () => {
    // "1.234,56" is German grouping; the amount is well outside the range.
    const found = messages(FACTS, withClaim(" Pauschal 1.234,56 EUR."));

    expect(found.some((m) => m.includes("outside every quoted range"))).toBe(true);
  });
});

describe("fabricated history", () => {
  test("rejects a founding year that does not match the record", () => {
    const found = messages(FACTS, withClaim(" Seit 2008 für Sie da."));

    expect(found.some((m) => m.includes("does not match the recorded founding year"))).toBe(
      true,
    );
  });

  test("rejects any year when none was supplied", () => {
    const undated = GroundingFactsSchema.parse({ ...FACTS, foundedYear: undefined });
    const found = messages(undated, withClaim(" Seit 2014 im Einsatz."));

    expect(found.some((m) => m.includes("no founding year was supplied"))).toBe(true);
  });

  test("ignores numbers that are not plausible years", () => {
    expect(collectGroundingIssues(withClaim(" In 48 Stunden erledigt."), FACTS)).toEqual(
      [],
    );
  });
});

describe("fabricated scope", () => {
  test("rejects naming a service the business does not sell", () => {
    const found = messages(FACTS, withClaim(" Wir übernehmen auch die Fensterreinigung."));

    expect(found.some((m) => m.includes("does not offer"))).toBe(true);
  });

  test("rejects naming a city the business does not serve", () => {
    const found = messages(FACTS, withClaim(" Auch in Köln im Einsatz."));

    expect(found.some((m) => m.includes("does not serve"))).toBe(true);
  });

  test("accepts naming an approved service or city", () => {
    expect(
      collectGroundingIssues(
        withClaim(" Auch die Grundreinigung in Essen bieten wir an."),
        FACTS,
      ),
    ).toEqual([]);
  });

  test("does not fire on a word that merely contains an unapproved name", () => {
    // "Fensterreinigung" is unapproved, but "Fensterbank" is an ordinary word
    // and must not be mistaken for it.
    expect(
      collectGroundingIssues(withClaim(" Auch Fensterbänke werden gewischt."), FACTS),
    ).toEqual([]);
  });
});

describe("fabricated statistics", () => {
  test("rejects a satisfaction percentage nobody measured", () => {
    const found = messages(FACTS, withClaim(" 98% unserer Kunden sind zufrieden."));

    expect(found.some((m) => m.includes("Unsupported statistic"))).toBe(true);
  });

  test("can be switched off for tenants who supply their own figures", () => {
    const page = withClaim(" 98% Zufriedenheit.");

    expect(
      collectGroundingIssues(page, FACTS, { rejectPercentages: false }),
    ).toEqual([]);
  });
});

describe("allowed claims", () => {
  test("permits a claim the operator pre-approved", () => {
    const approved = GroundingFactsSchema.parse({
      ...FACTS,
      allowedClaims: ["98% Zufriedenheit laut Kundenumfrage 2023"],
    });

    expect(
      collectGroundingIssues(withClaim(" 98% Zufriedenheit."), approved),
    ).toEqual([]);
  });

  test("permits a whitelisted year", () => {
    const approved = GroundingFactsSchema.parse({
      ...FACTS,
      allowedClaims: ["DIN 77400 seit 2019"],
    });

    expect(collectGroundingIssues(withClaim(" Nach DIN 77400 seit 2019."), approved)).toEqual(
      [],
    );
  });
});

describe("scanning coverage", () => {
  test("scans the title, not only the body", () => {
    const found = messages(FACTS, content({ title: "Büroreinigung seit 1999 in Duisburg" }));

    expect(found).toHaveLength(1);
  });

  test("scans FAQ answers", () => {
    const base = content();
    const page = {
      ...base,
      content: {
        ...base.content,
        faq: [
          { question: base.content.faq[0]!.question, answer: `${FILLER} Ab 500 EUR.` },
          ...base.content.faq.slice(1),
        ],
      },
    };

    expect(messages(FACTS, page).some((m) => m.includes("outside every quoted range"))).toBe(
      true,
    );
  });

  test("addresses each finding to the field that carries it", () => {
    const issues = collectGroundingIssues(
      content({ h1: "Büroreinigung ab 900 EUR" }),
      FACTS,
    );

    expect(issues[0]?.path).toBe("h1");
  });

  test("reports every fabrication in one pass", () => {
    const page = withClaim(" Seit 2001, ab 900 EUR, auch in Köln, info@fake.de, 95% zufrieden.");

    expect(collectGroundingIssues(page, FACTS).length).toBeGreaterThanOrEqual(5);
  });
});

describe("containsTerm", () => {
  test("matches whole words regardless of case", () => {
    expect(containsTerm("Auch in Essen tätig", "essen")).toBe(true);
  });

  test("does not match inside a longer word", () => {
    expect(containsTerm("Büroreinigung in Duisburg", "Reinigung")).toBe(false);
  });

  test("handles non-ASCII neighbours", () => {
    expect(containsTerm("Wir sind in Düsseldorf", "Düsseldorf")).toBe(true);
    expect(containsTerm("Düsseldorfer Straße", "Düsseldorf")).toBe(false);
  });

  test("ignores an empty term", () => {
    expect(containsTerm("anything", "  ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Building the record from engine entities
// ---------------------------------------------------------------------------

const business: Business = {
  id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  name: "GlanzFix Reinigungsservice",
  slug: "glanzfix",
  niche: "cleaning",
  description: "D".repeat(80),
  foundedYear: 2014,
  contactEmail: "kontakt@glanzfix.de",
  contactPhone: "+49 203 1234567",
  address: {
    street: "Königstraße 12",
    city: "Duisburg",
    state: "Nordrhein-Westfalen",
    postalCode: "47051",
    country: "DE",
  },
};

const svcOffice: Service = {
  id: "svc-buero",
  name: "Büroreinigung",
  slug: "bueroreinigung",
  description: "S".repeat(120),
  benefits: ["a", "b", "c"],
  pricing: { from: 25, to: 45, currency: "EUR" },
};

const svcStairs: Service = {
  id: "svc-treppe",
  name: "Treppenhausreinigung",
  slug: "treppenhausreinigung",
  description: "S".repeat(120),
  benefits: ["a", "b", "c"],
};

const locDuisburg: Location = {
  id: "loc-duisburg",
  city: "Duisburg",
  state: "Nordrhein-Westfalen",
  country: "DE",
};

const locKoeln: Location = {
  id: "loc-koeln",
  city: "Köln",
  state: "Nordrhein-Westfalen",
  country: "DE",
};

const catalogue = {
  services: [svcOffice, svcStairs],
  locations: [locDuisburg, locKoeln],
};

describe("buildGroundingFacts", () => {
  test("takes contacts and founding year from the business record", () => {
    const facts = buildGroundingFacts(business, svcOffice, catalogue);

    expect(facts.emails).toEqual(["kontakt@glanzfix.de"]);
    expect(facts.phones).toEqual(["+49 203 1234567"]);
    expect(facts.foundedYear).toBe(2014);
  });

  test("omits the founding year when the business has none", () => {
    const { foundedYear, ...undated } = business;
    void foundedYear;

    expect(buildGroundingFacts(undated, svcOffice, catalogue).foundedYear).toBeUndefined();
  });

  test("treats everything as approved when the business declares no eligibility", () => {
    const facts = buildGroundingFacts(business, svcOffice, catalogue);

    expect(facts.approvedServices).toEqual(["Büroreinigung", "Treppenhausreinigung"]);
    expect(facts.unapprovedServices).toEqual([]);
  });

  test("marks the rest of the catalogue unapproved when eligibility narrows it", () => {
    const restricted: Business = {
      ...business,
      serviceIds: ["svc-buero"],
      locationIds: ["loc-duisburg"],
    };

    const facts = buildGroundingFacts(restricted, svcOffice, catalogue);

    expect(facts.approvedServices).toEqual(["Büroreinigung"]);
    expect(facts.unapprovedServices).toEqual(["Treppenhausreinigung"]);
    expect(facts.approvedCities).toEqual(["Duisburg"]);
    expect(facts.unapprovedCities).toEqual(["Köln"]);
  });

  test("carries only this service's pricing, never another's", () => {
    expect(buildGroundingFacts(business, svcOffice, catalogue).prices).toEqual([
      { from: 25, to: 45, currency: "EUR" },
    ]);
    // The stairs service has no price, so the page may state none.
    expect(buildGroundingFacts(business, svcStairs, catalogue).prices).toEqual([]);
  });

  test("passes operator-approved claims through", () => {
    const facts = buildGroundingFacts(business, svcOffice, catalogue, ["ISO 9001"]);

    expect(facts.allowedClaims).toEqual(["ISO 9001"]);
  });
});

describe("renderGroundingFacts", () => {
  test("states the recorded facts", () => {
    const rendered = renderGroundingFacts(FACTS);

    expect(rendered).toContain("kontakt@glanzfix.de");
    expect(rendered).toContain("2014");
    expect(rendered).toContain("25–45 EUR");
  });

  test("names what may not be mentioned", () => {
    const rendered = renderGroundingFacts(FACTS);

    expect(rendered).toContain("Treppenhausreinigung");
    expect(rendered).toContain("Köln");
    expect(rendered).toMatch(/does NOT offer/);
  });

  test("forbids a year outright when none was supplied", () => {
    const undated = GroundingFactsSchema.parse({ ...FACTS, foundedYear: undefined });

    expect(renderGroundingFacts(undated)).toContain("Do not state any year");
  });

  test("forbids prices outright when none were supplied", () => {
    const priceless = GroundingFactsSchema.parse({ ...FACTS, prices: [] });

    expect(renderGroundingFacts(priceless)).toContain("Do not state any price");
  });

  test("says plainly that unsupplied credentials may not be claimed", () => {
    expect(renderGroundingFacts(FACTS)).toMatch(
      /No certifications, awards, guarantees, review counts/,
    );
  });
});
