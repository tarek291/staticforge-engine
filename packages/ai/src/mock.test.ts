import {
  DEFAULT_CONTENT_PROFILE,
  STRICT_SEO_PROFILE,
  collectContentIssues,
  GeneratedPageSchema,
  type ContentProfile,
} from "@staticforge/schemas";
import { describe, expect, test, vi } from "vitest";

import {
  buildMockContent,
  createMockService,
  isMockAiEnabled,
} from "./mock.js";
import { GeneratedPageContentSchema } from "./service.js";

/**
 * The mock is only worth having if content it produces would survive the real
 * gates. A mock that passes checks the live service would fail turns a load test
 * into a measurement of nothing.
 */

const REQUEST = {
  businessName: "ScaleClean Gebaeudeservice",
  serviceName: "Bueroreinigung",
  cityName: "Duisburg",
};

/** Complete the authored slice into a whole page, as the service's probe does. */
function asPage(content: ReturnType<typeof buildMockContent>) {
  return GeneratedPageSchema.parse({
    ...content,
    slug: "bueroreinigung-duisburg",
    locale: "de",
    schemaOrg: { "@type": "Service" },
    templateId: "default",
    businessId: "b0000000-0000-4000-8000-000000000001",
    serviceId: "svc-1",
    locationId: "loc-1",
  });
}

describe("mock content satisfies the real contracts", () => {
  for (const profile of [DEFAULT_CONTENT_PROFILE, STRICT_SEO_PROFILE]) {
    test(`parses against the structural schema under "${profile.id}"`, () => {
      expect(
        GeneratedPageContentSchema.safeParse(buildMockContent(REQUEST, profile)).success,
      ).toBe(true);
    });

    test(`clears the "${profile.id}" quality profile`, () => {
      // The gate the live service would apply, applied here.
      expect(collectContentIssues(asPage(buildMockContent(REQUEST, profile)), profile)).toEqual(
        [],
      );
    });
  }

  test("sizes itself from the profile rather than from constants", () => {
    const loose = buildMockContent(REQUEST, DEFAULT_CONTENT_PROFILE);
    const strict = buildMockContent(REQUEST, STRICT_SEO_PROFILE);

    // The strict profile demands more sections and longer bodies, so the mock
    // must produce more. A fixed-size mock would fail one of the two.
    expect(strict.content.sections.length).toBeGreaterThan(
      loose.content.sections.length,
    );
    expect(strict.content.sections[0]!.body.length).toBeGreaterThan(
      loose.content.sections[0]!.body.length,
    );
  });

  test("tracks a profile it has never seen", () => {
    const demanding: ContentProfile = {
      ...STRICT_SEO_PROFILE,
      sections: { ...STRICT_SEO_PROFILE.sections, count: { min: 5, max: 5 } },
    };

    const content = buildMockContent(REQUEST, demanding);

    expect(content.content.sections).toHaveLength(5);
    expect(collectContentIssues(asPage(content), demanding)).toEqual([]);
  });

  test("declares a section kind when the profile requires one", () => {
    const content = buildMockContent(REQUEST, STRICT_SEO_PROFILE);

    for (const section of content.content.sections) {
      expect(section.kind).toBeDefined();
      expect(STRICT_SEO_PROFILE.sections.allowedKinds).toContain(section.kind);
    }
  });

  test("gives each section a distinct heading", () => {
    const headings = buildMockContent(REQUEST, STRICT_SEO_PROFILE).content.sections.map(
      (section) => section.heading,
    );

    // The linking rules reject duplicate headings; the mock must not create them.
    expect(new Set(headings).size).toBe(headings.length);
  });

  test("keeps the h1 distinct from the title", () => {
    const content = buildMockContent(REQUEST, STRICT_SEO_PROFILE);

    expect(content.h1).not.toBe(content.title);
  });

  test("varies with the service and city, so pages are not identical", () => {
    const a = buildMockContent(REQUEST);
    const b = buildMockContent({ ...REQUEST, cityName: "Essen" });

    expect(a.title).not.toBe(b.title);
  });
});

describe("mock service", () => {
  test("simulates latency rather than resolving instantly", async () => {
    const sleepFn = vi.fn((_ms: number) => Promise.resolve());
    const service = createMockService({ sleepFn, random: () => 0.5, latencyMs: 10 });

    await service.authorPage(REQUEST);

    // Pacing and progress paths must behave as they would against a provider.
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn.mock.calls[0]?.[0]).toBe(10);
  });

  test("jitters the latency", async () => {
    const sleepFn = vi.fn((_ms: number) => Promise.resolve());

    await createMockService({ sleepFn, random: () => 0, latencyMs: 10 }).authorPage(
      REQUEST,
    );
    await createMockService({ sleepFn, random: () => 1, latencyMs: 10 }).authorPage(
      REQUEST,
    );

    expect(sleepFn.mock.calls[0]?.[0]).toBe(5);
    expect(sleepFn.mock.calls[1]?.[0]).toBe(15);
  });

  test("never sleeps a negative duration", async () => {
    const sleepFn = vi.fn((_ms: number) => Promise.resolve());

    await createMockService({ sleepFn, random: () => 0, latencyMs: 0 }).authorPage(
      REQUEST,
    );

    expect(sleepFn.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(0);
  });

  test("marks its provenance unmistakably", async () => {
    const { provenance } = await createMockService({
      sleepFn: () => Promise.resolve(),
    }).authorPage(REQUEST);

    // A page produced this way must never be mistaken for real output.
    expect(provenance.modelVersion).toBe("mock");
    expect(provenance.cacheHit).toBe(false);
  });

  test("carries the source fingerprint through", async () => {
    const { provenance } = await createMockService({
      sleepFn: () => Promise.resolve(),
    }).authorPage({
      ...REQUEST,
      cacheIdentity: {
        businessId: "b",
        serviceId: "s",
        locationId: "l",
        sourceHash: "fingerprint",
      },
    });

    expect(provenance.sourceHash).toBe("fingerprint");
  });

  test("reports the profile it generated for", async () => {
    const { provenance } = await createMockService({
      profile: STRICT_SEO_PROFILE,
      sleepFn: () => Promise.resolve(),
    }).authorPage(REQUEST);

    expect(provenance.profileId).toBe("strictSeo");
  });
});

describe("isMockAiEnabled", () => {
  test("requires the exact string, so a stray value cannot switch it on", () => {
    const before = process.env.AI_MOCK;

    try {
      for (const value of ["1", "yes", "TRUE", ""]) {
        process.env.AI_MOCK = value;
        expect(isMockAiEnabled(), `AI_MOCK=${value}`).toBe(false);
      }

      process.env.AI_MOCK = "true";
      expect(isMockAiEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.AI_MOCK;
      else process.env.AI_MOCK = before;
    }
  });

  test("is off when unset", () => {
    const before = process.env.AI_MOCK;
    delete process.env.AI_MOCK;

    try {
      expect(isMockAiEnabled()).toBe(false);
    } finally {
      if (before !== undefined) process.env.AI_MOCK = before;
    }
  });
});
