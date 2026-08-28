import { describe, expect, test } from "vitest";
import type { Business, GeneratedPage, Location, Service } from "@staticforge/schemas";

import { patchPageContent } from "./patch-page.js";
import { computeContentHash } from "./refresh-page.js";
import type { StaticContentTemplate, ValidatedInputData } from "./types.js";

/**
 * A partial edit is more dangerous than a whole rewrite, not less.
 *
 * A rewrite arrives as a complete page and is judged as one. A patch arrives as
 * a fragment and looks too small to check — but an editor that clears a
 * required heading sends a perfectly well-formed request, and a person typing a
 * phone number into a text box is exactly as unverified as a model inventing
 * one.
 *
 * So the tests that matter are the refusals, and the property underneath all of
 * them: a refused patch leaves the caller holding the page it started with.
 */

const business: Business = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Reinigung",
  slug: "acme",
  niche: "cleaning",
  description: "D".repeat(80),
  contactEmail: "kontakt@acme.de",
  contactPhone: "+49 203 1234567",
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

/** A page that satisfies the schema and the default profile. */
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
      sections: [{ heading: "Was dazugehoert", body: "B".repeat(120) }],
      faq: [
        { question: "Wie lange dauert es?", answer: "A".repeat(40) },
        { question: "Was kostet es ungefaehr?", answer: "B".repeat(40) },
        { question: "Was muss vorbereitet werden?", answer: "C".repeat(40) },
      ],
      cta: { heading: "Jetzt anfragen", buttonLabel: "Anfragen", href: "#contact" },
    },
    schemaOrg: { "@type": "Service", name: "old name", description: "old description" },
    templateId: "default",
    contentProfileId: "default",
    businessId: business.id,
    serviceId: "svc-buero",
    locationId: "loc-duisburg",
    links: [{ slug: "bueroreinigung-essen", anchor: "Essen", relation: "sameService" }],
    ...over,
  };
}

describe("a valid edit is accepted", () => {
  test("replaces the addressed block and nothing else", () => {
    const before = page();
    const result = patchPageContent(
      before,
      input,
      "content.faq.0.answer",
      "Ein typischer Einsatz dauert zwei bis drei Stunden je Etage.",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.page.content.faq[0]?.answer).toMatch(/zwei bis drei Stunden/);
    expect(result.page.content.faq[1]?.answer).toBe(before.content.faq[1]?.answer);
    expect(result.page.content.sections).toEqual(before.content.sections);
  });

  test("moves the content fingerprint", () => {
    const before = page();
    const result = patchPageContent(
      before,
      input,
      "content.hero.heading",
      "Büroreinigung für Duisburger Gewerbeflächen",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.previousContentHash).toBe(computeContentHash(before));
    expect(result.contentHash).not.toBe(result.previousContentHash);
    expect(result.changed).toBe(true);
  });

  test("an edit that changes nothing reports so rather than pretending", () => {
    const before = page();
    const result = patchPageContent(
      before,
      input,
      "content.hero.heading",
      before.content.hero.heading,
    );

    // An editor showing "saved" for a no-op teaches the wrong thing about what
    // the button does.
    expect(result.ok && result.changed).toBe(false);
    expect(result.ok && result.contentHash).toBe(result.ok && result.previousContentHash);
  });

  test("realigns structured data with the copy that just changed", () => {
    const result = patchPageContent(
      page(),
      input,
      "h1",
      "Büroreinigung für Duisburger Gewerbeflächen",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Structured data describing replaced copy is drift this engine fixed once
    // already; a patch must not reintroduce it through a new door.
    expect(result.page.schemaOrg.name).toBe(result.page.h1);
    expect(result.page.schemaOrg.description).toBe(result.page.metaDescription);
  });
});

describe("what a patch may not touch", () => {
  test("the slug is frozen", () => {
    const result = patchPageContent(page(), input, "slug", "a-different-url");

    // A slug is a published URL and every inbound link pointing at it.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe("path");
  });

  test("the link graph is frozen", () => {
    const result = patchPageContent(page(), input, "links", []);

    expect(result.ok).toBe(false);
  });

  test("entity ids, template and profile are frozen", () => {
    for (const path of [
      "businessId",
      "serviceId",
      "locationId",
      "templateId",
      "contentProfileId",
      "locale",
      "schemaOrg.name",
      "generation.contentHash",
    ]) {
      const result = patchPageContent(page(), input, path, "anything");

      expect(result.ok, path).toBe(false);
    }
  });

  test("the refusal names what is editable, rather than saying nothing was found", () => {
    // Two things stop a frozen field being written, and they are not the same
    // thing. The authored slice simply does not contain `slug`, so a path
    // addressing it finds nothing — which refuses the edit but tells an editor
    // only that its path was wrong. The explicit freeze fires first and says
    // *why*, which is the difference between a message a UI can render and a
    // dead end. Removing the freeze leaves the behaviour correct and the
    // explanation gone, so this pins the explanation.
    const result = patchPageContent(page(), input, "slug", "a-different-url");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.issues[0]?.message).toMatch(/is not editable/);
    expect(result.issues[0]?.message).toMatch(/title, metaDescription, h1, content/);
  });

  test("a frozen field is untouched even when the patch is refused", () => {
    const before = page();
    patchPageContent(before, input, "slug", "a-different-url");

    expect(before.slug).toBe("bueroreinigung-duisburg");
  });

  test("prototype paths are refused before any gate runs", () => {
    const result = patchPageContent(page(), input, "__proto__.polluted", "yes");

    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("the schema gate", () => {
  test("clearing a required heading is refused", () => {
    // The case that makes this gate non-optional: a perfectly well-formed
    // request that empties a field the contract requires.
    const result = patchPageContent(page(), input, "content.hero.heading", "");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe("schema");
  });

  test("replacing a block with the wrong type is refused", () => {
    for (const value of [42, null, [], { unexpected: true }]) {
      const result = patchPageContent(page(), input, "content.hero.heading", value);

      expect(result.ok, JSON.stringify(value)).toBe(false);
    }
  });

  test("emptying the sections list is refused", () => {
    const result = patchPageContent(page(), input, "content.sections", []);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe("schema");
  });

  test("a cta href that is not a link target is refused", () => {
    const result = patchPageContent(page(), input, "content.cta.href", "contact");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe("schema");
  });
});

describe("the profile gate", () => {
  test("a title under the profile floor is refused", () => {
    // Schema-valid — a non-empty string under 70 characters — and far below
    // what the profile requires.
    const result = patchPageContent(page(), input, "title", "Cheap!");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe("profile");
  });

  test("an answer under the profile floor is refused", () => {
    const result = patchPageContent(page(), input, "content.faq.0.answer", "Ja.");

    expect(result.ok === false && result.stage).toBe("profile");
  });

  test("a page naming an unregistered profile is refused rather than defaulted", () => {
    const result = patchPageContent(
      page({ contentProfileId: "invented" }),
      input,
      "content.faq.0.answer",
      "A".repeat(60),
    );

    // Falling back to a default would judge the edit by rules nobody chose.
    expect(result.ok === false && result.stage).toBe("profile");
  });

  test("a prototype name is not a registered profile", () => {
    const result = patchPageContent(
      page({ contentProfileId: "constructor" }),
      input,
      "content.faq.0.answer",
      "A".repeat(60),
    );

    expect(result.ok === false && result.stage).toBe("profile");
  });
});

describe("the grounding gate", () => {
  test("a phone number nobody verified is refused", () => {
    // A person typing this into an editor is exactly as unverified as a model
    // inventing it, and the published page is exactly as wrong.
    const result = patchPageContent(
      page(),
      input,
      "content.faq.0.answer",
      "Rufen Sie uns an unter 0800 9999999, wir beraten Sie gerne dazu.",
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe("grounding");
    expect(
      result.ok === false && result.issues.some((i) => /phone/i.test(i.message)),
    ).toBe(true);
  });

  test("a price nobody quoted is refused, in the German form", () => {
    const result = patchPageContent(
      page(),
      input,
      "content.faq.1.answer",
      "Ein Einsatz kostet ab 49 € pro Termin, je nach Flaeche und Aufwand.",
    );

    expect(result.ok === false && result.stage).toBe("grounding");
  });

  test("a service the business does not sell is refused", () => {
    const result = patchPageContent(
      page(),
      input,
      "content.faq.2.answer",
      "Wir uebernehmen auch Gartenpflege fuer Ihr Objekt, sprechen Sie uns an.",
    );

    expect(result.ok === false && result.stage).toBe("grounding");
  });

  test("a statistic nobody supplied is refused", () => {
    const result = patchPageContent(
      page(),
      input,
      "content.faq.0.answer",
      "98 % unserer Kunden buchen uns erneut, das freut uns jedes Mal sehr.",
    );

    expect(result.ok === false && result.stage).toBe("grounding");
  });

  test("the business's own phone number is accepted", () => {
    // The guard must not make the editor useless: a verified fact still passes.
    const result = patchPageContent(
      page(),
      input,
      "content.faq.0.answer",
      "Erreichbar unter +49 203 1234567, werktags von acht bis achtzehn Uhr.",
    );

    expect(result.ok).toBe(true);
  });

  test("an edit is refused when no record can be built for the page", () => {
    const orphan = page({ serviceId: "svc-gone" });
    const result = patchPageContent(
      orphan,
      input,
      "content.faq.0.answer",
      "A".repeat(60),
    );

    // Publishing an unverifiable edit is the one outcome worse than refusing a
    // valid one.
    expect(result.ok === false && result.stage).toBe("grounding");
  });
});

describe("a refused patch leaves nothing behind", () => {
  test("the page handed in is never modified, whichever gate refuses", () => {
    const before = page();
    const snapshot = JSON.stringify(before);

    for (const [path, value] of [
      ["content.hero.heading", ""],
      ["title", "Cheap!"],
      ["content.faq.0.answer", "Rufen Sie 0800 9999999 an, wir helfen Ihnen."],
      ["slug", "other"],
      ["__proto__.x", "y"],
    ] as const) {
      const result = patchPageContent(before, input, path, value);

      expect(result.ok, path).toBe(false);
    }

    // The property the whole endpoint rests on: a rejection means the caller
    // still holds exactly the page it started with, so there is nothing to
    // roll back and nothing half-applied to publish.
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("a refusal names the gate, so an editor can say what to fix", () => {
    const result = patchPageContent(page(), input, "title", "Cheap!");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(["path", "schema", "profile", "grounding"]).toContain(result.stage);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.message.length).toBeGreaterThan(0);
  });
});
