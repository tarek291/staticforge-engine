import { describe, expect, test } from "vitest";
import type { Business, GeneratedPage, Location, Service } from "@staticforge/schemas";

import { collectPolicyIssues } from "./verify-policy.js";
import type { StaticContentTemplate, ValidatedInputData } from "./types.js";

/**
 * What a cold read has to ask beyond "is this a page".
 *
 * Every gate that decides whether content may be published runs in memory, in
 * the process that authored it. A page can reach disk without passing them —
 * from the cache, from a mock run, from an editor — and still satisfy its
 * schema perfectly. These tests are about the difference between the two
 * questions.
 */

const business: Business = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Reinigung",
  slug: "acme",
  niche: "cleaning",
  description: "D".repeat(80),
  contactEmail: "kontakt@acme.de",
  contactPhone: "+49 211 4567890",
  address: {
    street: "Musterstr 1",
    city: "Duisburg",
    state: "NRW",
    postalCode: "47051",
    country: "DE",
  },
  serviceIds: ["svc-buero"],
  locationIds: ["loc-duisburg"],
};

const services: Service[] = [
  {
    id: "svc-buero",
    name: "Büroreinigung",
    slug: "bueroreinigung",
    description: "S".repeat(120),
    benefits: ["b1", "b2", "b3"],
  },
  {
    id: "svc-garten",
    name: "Gartenpflege",
    slug: "gartenpflege",
    description: "G".repeat(120),
    benefits: ["b1", "b2", "b3"],
  },
];

const locations: Location[] = [
  { id: "loc-duisburg", city: "Duisburg", state: "NRW", country: "DE" },
  { id: "loc-essen", city: "Essen", state: "NRW", country: "DE" },
];

const content: StaticContentTemplate = {
  hero: {
    titleTemplate: "{{service}} in {{city}}",
    subtitleTemplate: "{{service}} in {{city}} von {{business}}.",
  },
  cta: { primary: "Anfragen", secondary: "Anrufen" },
  faqs: [
    { q: "Q1", a: "A1" },
    { q: "Q2", a: "A2" },
    { q: "Q3", a: "A3" },
  ],
};

const input: ValidatedInputData = {
  businesses: [business],
  services,
  locations,
  content,
};

/** A page that satisfies both the schema and the default profile. */
function page(over: Partial<GeneratedPage> = {}): GeneratedPage {
  return {
    slug: "bueroreinigung-duisburg",
    locale: "de",
    title: "Büroreinigung in Duisburg von Acme",
    metaDescription:
      "Büroreinigung in Duisburg: Ablauf, Umfang und was den Preis bestimmt.",
    h1: "Büroreinigung in Duisburg",
    content: {
      hero: { heading: "Büroreinigung in Duisburg" },
      sections: [
        {
          heading: "Was dazugehoert",
          body: "B".repeat(120),
        },
      ],
      faq: [
        { question: "Wie lange dauert es?", answer: "A".repeat(40) },
        { question: "Was kostet es ungefaehr?", answer: "B".repeat(40) },
        { question: "Was muss vorbereitet werden?", answer: "C".repeat(40) },
      ],
      cta: { heading: "Jetzt anfragen", buttonLabel: "Anfragen", href: "#contact" },
    },
    schemaOrg: { "@type": "Service" },
    templateId: "default",
    contentProfileId: "default",
    businessId: business.id,
    serviceId: "svc-buero",
    locationId: "loc-duisburg",
    links: [],
    ...over,
  };
}

describe("collectPolicyIssues", () => {
  test("a page that earned its place reports nothing", () => {
    expect(collectPolicyIssues([page()], input)).toEqual([]);
  });

  test("catches a page that no longer meets its own profile", () => {
    // Schema-valid — title is a non-empty string under 70 characters — but far
    // under the floor the profile sets. Exactly what a hand-edited file, or a
    // cache entry written under a looser profile, looks like on disk.
    const issues = collectPolicyIssues([page({ title: "Cheap!" })], input);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("pages[bueroreinigung-duisburg].title");
    expect(issues[0]?.message).toMatch(/\[default\] Too short/);
  });

  test("catches a fabricated phone number that reached disk", () => {
    const issues = collectPolicyIssues(
      [
        page({
          content: {
            ...page().content,
            cta: {
              heading: "Jetzt anrufen",
              buttonLabel: "Anrufen",
              href: "#contact",
              secondary: { buttonLabel: "0800 1234567", href: "#call" },
            },
          },
        }),
      ],
      input,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/Unverified phone number/);
  });

  test("catches a city the business does not serve", () => {
    const issues = collectPolicyIssues(
      [
        page({
          metaDescription:
            "Büroreinigung in Duisburg und Essen: Ablauf, Umfang und Preise.",
        }),
      ],
      input,
    );

    expect(issues.some((issue) => /does not serve/.test(issue.message))).toBe(true);
  });

  test("catches a service the business does not sell", () => {
    const issues = collectPolicyIssues(
      [
        page({
          content: {
            ...page().content,
            sections: [
              { heading: "Auch Gartenpflege", body: "G".repeat(120) },
            ],
          },
        }),
      ],
      input,
    );

    expect(issues.some((issue) => /does not offer/.test(issue.message))).toBe(true);
  });

  test("refuses a page naming a profile that does not exist", () => {
    // Falling back to a default would judge it by rules nobody chose, and
    // reporting it clean would leave the one claim never verified.
    const issues = collectPolicyIssues(
      [page({ contentProfileId: "invented" })],
      input,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/Unknown contentProfileId "invented"/);
  });

  test("prototype keys do not resolve as profiles", () => {
    // `CONTENT_PROFILES` is an object literal, so a bare index lookup inherits
    // Object.prototype and "constructor" would not read as undefined.
    const issues = collectPolicyIssues(
      [page({ contentProfileId: "constructor" })],
      input,
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/Unknown contentProfileId/);
  });

  test("refuses a page whose entities the input no longer has", () => {
    const issues = collectPolicyIssues([page({ serviceId: "svc-gone" })], input);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/Cannot verify/);
  });

  test("reports every page, not just the first that fails", () => {
    const issues = collectPolicyIssues(
      [
        page({ title: "Short" }),
        page({ slug: "bueroreinigung-essen", h1: "x" }),
      ],
      input,
    );

    const slugs = new Set(
      issues.map((issue) => issue.path.slice("pages[".length).split("]")[0]),
    );

    expect(slugs).toEqual(
      new Set(["bueroreinigung-duisburg", "bueroreinigung-essen"]),
    );
  });

  test("an empty run has nothing to report", () => {
    expect(collectPolicyIssues([], input)).toEqual([]);
  });
});
