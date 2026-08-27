import { test, describe } from "vitest";
import assert from "node:assert/strict";
import type { Business, GeneratedPage, Location, Service } from "@staticforge/schemas";
import type { AuthoredContent, GenerationRequest } from "@staticforge/ai";

import { buildPages } from "./build-pages.js";
import {
  applyAiContent,
  computeSourceHash,
  type GenerateContentFn,
  type ResumableContent,
} from "./ai-content.js";
import type { StaticContentTemplate, ValidatedInputData } from "./types.js";

/**
 * Resuming an interrupted run.
 *
 * A five-hundred-page authoring run killed at page four hundred has four
 * hundred pages of paid content already in the database. Starting over buys
 * every one of them a second time, and the tenant is charged for the crash.
 *
 * The only question that decides reuse is whether the stored page was written
 * from the inputs this run is about to use. `sourceHash` answers exactly that,
 * which is why these tests are mostly about the cases where it does *not*
 * match — reusing prose that describes a page which no longer exists would be a
 * worse failure than paying twice.
 */

const business: Business = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
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
};

const services: Service[] = [
  {
    id: "svc-1",
    name: "Büroreinigung",
    slug: "bueroreinigung",
    description: "S".repeat(120),
    benefits: ["b1", "b2", "b3"],
  },
];

const locations: Location[] = [
  { id: "loc-1", city: "Duisburg", state: "NRW", country: "DE" },
  { id: "loc-2", city: "Essen", state: "NRW", country: "DE" },
  { id: "loc-3", city: "Bochum", state: "NRW", country: "DE" },
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

function baseline(): GeneratedPage[] {
  return buildPages(input, { locale: "de" });
}

/** The fingerprint the run will compute for a given city. */
function sourceHashFor(city: string): string {
  const location = locations.find((item) => item.city === city);
  assert.ok(location !== undefined);
  assert.ok(services[0] !== undefined);

  return computeSourceHash(business, services[0], location, content);
}

/** Stored content standing in for what a previous attempt wrote. */
function stored(city: string, sourceHash: string): ResumableContent {
  return {
    title: `Stored title for ${city}`,
    metaDescription: `Stored meta description for ${city}, long enough to pass.`,
    h1: `Stored heading for ${city}`,
    content: {
      hero: { heading: `Stored hero ${city}` },
      sections: [{ heading: "Stored section", body: "Stored body." }],
      faq: [{ question: "Stored q?", answer: "Stored a." }],
      cta: { heading: "Stored cta", buttonLabel: "Go", href: "#contact" },
    },
    generation: {
      promptVersion: "1.0.0",
      modelVersion: "claude-opus-5",
      profileId: "default",
      sourceHash,
      contentHash: "abc123",
      generatedAt: "2026-08-27T10:00:00.000Z",
    },
  };
}

/** A generator that records which pages it was actually asked to author. */
function countingStub(): { fn: GenerateContentFn; asked: string[] } {
  const asked: string[] = [];

  const fn: GenerateContentFn = (request: GenerationRequest) => {
    asked.push(request.cityName);

    const result: AuthoredContent = {
      content: {
        title: `Fresh title for ${request.cityName}`,
        metaDescription: `Fresh meta for ${request.cityName}, long enough to pass.`,
        h1: `Fresh heading for ${request.cityName}`,
        content: {
          hero: { heading: `Fresh hero ${request.cityName}` },
          sections: [{ heading: "Fresh section", body: "Fresh body." }],
          faq: [{ question: "Fresh q?", answer: "Fresh a." }],
          cta: { heading: "Fresh cta", buttonLabel: "Go", href: "#contact" },
        },
      },
      provenance: {
        promptVersion: "1.0.0",
        modelVersion: "claude-opus-5",
        profileId: "default",
        sourceHash: undefined,
        cacheHit: false,
      },
    };

    return Promise.resolve(result);
  };

  return { fn, asked };
}

const noDelay = { delayMs: 0 } as const;

describe("applyAiContent resumes an interrupted attempt", () => {
  test("does not re-author a page a previous attempt already wrote", async () => {
    const { fn, asked } = countingStub();
    const resumeFrom = new Map<string, ResumableContent>([
      ["bueroreinigung-duisburg", stored("Duisburg", sourceHashFor("Duisburg"))],
    ]);

    const pages = await applyAiContent(baseline(), input, fn, {
      ...noDelay,
      resumeFrom,
    });

    // The whole point: the model is not asked about a page that already exists.
    assert.ok(!asked.includes("Duisburg"), "re-bought a page it already had");
    assert.deepEqual(asked.sort(), ["Bochum", "Essen"]);
    assert.equal(pages.length, 3);
  });

  test("the resumed page carries the stored content, not fresh prose", async () => {
    const { fn } = countingStub();
    const resumeFrom = new Map<string, ResumableContent>([
      ["bueroreinigung-duisburg", stored("Duisburg", sourceHashFor("Duisburg"))],
    ]);

    const pages = await applyAiContent(baseline(), input, fn, {
      ...noDelay,
      resumeFrom,
    });

    const resumed = pages.find((page) => page.slug === "bueroreinigung-duisburg");

    assert.equal(resumed?.title, "Stored title for Duisburg");
    assert.equal(resumed?.h1, "Stored heading for Duisburg");
  });

  test("a resumed page still gets structured data matching its content", async () => {
    const { fn } = countingStub();
    const resumeFrom = new Map<string, ResumableContent>([
      ["bueroreinigung-duisburg", stored("Duisburg", sourceHashFor("Duisburg"))],
    ]);

    const pages = await applyAiContent(baseline(), input, fn, {
      ...noDelay,
      resumeFrom,
    });

    const resumed = pages.find((page) => page.slug === "bueroreinigung-duisburg");

    // Reuse must not reintroduce the drift the realignment fixed.
    assert.equal(resumed?.schemaOrg.name, resumed?.h1);
    assert.equal(resumed?.schemaOrg.description, resumed?.metaDescription);
  });

  test("a whole finished run costs nothing to repeat", async () => {
    const { fn, asked } = countingStub();
    const resumeFrom = new Map<string, ResumableContent>(
      baseline().map((page) => {
        const city =
          page.locationId === "loc-1"
            ? "Duisburg"
            : page.locationId === "loc-2"
              ? "Essen"
              : "Bochum";
        return [page.slug, stored(city, sourceHashFor(city))];
      }),
    );

    await applyAiContent(baseline(), input, fn, { ...noDelay, resumeFrom });

    assert.deepEqual(asked, []);
  });

  test("reports which pages were resumed", async () => {
    const { fn } = countingStub();
    const resumeFrom = new Map<string, ResumableContent>([
      ["bueroreinigung-duisburg", stored("Duisburg", sourceHashFor("Duisburg"))],
    ]);
    const resumedSlugs: string[] = [];

    await applyAiContent(baseline(), input, fn, {
      ...noDelay,
      resumeFrom,
      onProgress: ({ slug, resumed }) => {
        if (resumed) resumedSlugs.push(slug);
      },
    });

    assert.deepEqual(resumedSlugs, ["bueroreinigung-duisburg"]);
  });
});

describe("applyAiContent refuses to reuse content it cannot vouch for", () => {
  test("stale content is re-authored when the inputs have moved", async () => {
    const { fn, asked } = countingStub();
    const resumeFrom = new Map<string, ResumableContent>([
      ["bueroreinigung-duisburg", stored("Duisburg", "a-hash-from-older-inputs")],
    ]);

    await applyAiContent(baseline(), input, fn, { ...noDelay, resumeFrom });

    // A renamed service or an edited description moves the fingerprint, and the
    // stored prose is then about a page that no longer exists.
    assert.ok(asked.includes("Duisburg"));
  });

  test("content with no provenance is not reusable", async () => {
    const { fn, asked } = countingStub();
    const orphan = stored("Duisburg", sourceHashFor("Duisburg"));
    const resumeFrom = new Map<string, ResumableContent>([
      ["bueroreinigung-duisburg", { ...orphan, generation: undefined }],
    ]);

    await applyAiContent(baseline(), input, fn, { ...noDelay, resumeFrom });

    // A page that cannot say what produced it cannot be shown to be current.
    assert.ok(asked.includes("Duisburg"));
  });

  test("content whose stored shape is broken is re-authored, not fatal", async () => {
    const { fn, asked } = countingStub();
    const broken = stored("Duisburg", sourceHashFor("Duisburg"));
    const resumeFrom = new Map<string, ResumableContent>([
      ["bueroreinigung-duisburg", { ...broken, content: { hero: {} } }],
    ]);

    const pages = await applyAiContent(baseline(), input, fn, {
      ...noDelay,
      resumeFrom,
    });

    // Unusable stored content is no worse than no stored content: the page is
    // simply authored, which is what would have happened anyway.
    assert.ok(asked.includes("Duisburg"));
    assert.equal(pages.length, 3);
  });

  test("an empty resume map behaves exactly as no resume at all", async () => {
    const { fn, asked } = countingStub();

    await applyAiContent(baseline(), input, fn, {
      ...noDelay,
      resumeFrom: new Map(),
    });

    assert.equal(asked.length, 3);
  });
});

describe("applyAiContent reports progress as it goes", () => {
  test("counts every page, in order, against the total", async () => {
    const { fn } = countingStub();
    const seen: Array<{ completed: number; total: number }> = [];

    await applyAiContent(baseline(), input, fn, {
      ...noDelay,
      onCount: (counts) => {
        seen.push(counts);
        return Promise.resolve();
      },
    });

    assert.deepEqual(seen, [
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
  });

  test("a resumed page advances the count like any other", async () => {
    const { fn } = countingStub();
    const seen: number[] = [];
    const resumeFrom = new Map<string, ResumableContent>([
      ["bueroreinigung-duisburg", stored("Duisburg", sourceHashFor("Duisburg"))],
    ]);

    await applyAiContent(baseline(), input, fn, {
      ...noDelay,
      resumeFrom,
      onCount: ({ completed }) => {
        seen.push(completed);
        return Promise.resolve();
      },
    });

    // A run that resumes most of its pages must still look like it is moving.
    assert.deepEqual(seen, [1, 2, 3]);
  });

  test("the count is awaited, so it cannot land out of order", async () => {
    const { fn } = countingStub();
    const order: string[] = [];

    await applyAiContent(baseline(), input, fn, {
      ...noDelay,
      onCount: async ({ completed }) => {
        order.push(`start-${completed}`);
        await Promise.resolve();
        order.push(`end-${completed}`);
      },
    });

    // A progress write that races the next page is a bar that jumps backwards.
    assert.deepEqual(order, [
      "start-1",
      "end-1",
      "start-2",
      "end-2",
      "start-3",
      "end-3",
    ]);
  });
});
