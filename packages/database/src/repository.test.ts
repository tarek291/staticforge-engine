import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import { ProjectPayloadError, getProjectPayload } from "./repository.js";

/**
 * Every test runs against a deep mock of PrismaClient. Nothing here opens a
 * connection, reads DATABASE_URL, or touches a real database — the suite is
 * pure mapping verification and runs anywhere.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

/** The `findUnique(... include ...)` row shape, with sensible defaults. */
function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "prj_1",
    name: "GlanzFix Website",
    slug: "glanzfix",
    description: null,
    locale: "de",
    templateId: "default",
    workspaceId: "ws_1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),

    workspace: {
      id: "ws_1",
      name: "GlanzFix GmbH",
      slug: "glanzfix-gmbh",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },

    business: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "GlanzFix Reinigungsservice",
      slug: "glanzfix",
      description: "D".repeat(80),
      niche: "cleaning",
      foundedYear: null,
      contactEmail: "kontakt@glanzfix.de",
      contactPhone: "+49 203 1234567",
      addressStreet: "Musterstraße 1",
      addressCity: "Duisburg",
      addressState: "Nordrhein-Westfalen",
      addressPostalCode: "47051",
      addressCountry: "DE",
      projectId: "prj_1",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },

    content: {
      id: "ct_1",
      heroTitleTemplate: "{{service}} in {{city}}",
      heroSubtitleTemplate: "{{service}} in {{city}} von {{business}}.",
      ctaPrimary: "Jetzt anfragen",
      ctaSecondary: "Anrufen",
      faqs: [
        { q: "Q1", a: "A1" },
        { q: "Q2", a: "A2" },
        { q: "Q3", a: "A3" },
      ],
      projectId: "prj_1",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },

    services: [serviceRow()],
    locations: [locationRow()],

    ...overrides,
  };
}

function serviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "svc_1",
    name: "Büroreinigung",
    slug: "bueroreinigung",
    description: "S".repeat(120),
    benefits: ["b1", "b2", "b3"],
    priceFrom: 25,
    priceTo: 45,
    priceCurrency: "EUR",
    templateId: null,
    projectId: "prj_1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function locationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "loc_1",
    name: "Duisburg",
    slug: "duisburg",
    city: "Duisburg",
    state: "Nordrhein-Westfalen",
    country: "DE",
    postalCode: "47051",
    latitude: 51.4344,
    longitude: 6.7623,
    projectId: "prj_1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

/** Point the mocked client at a row (or `null`) and return the payload. */
function resolveWith(row: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.project.findUnique.mockResolvedValue(row as any);
  return getProjectPayload("prj_1", prisma);
}

describe("query shape", () => {
  test("fetches the project with workspace, business, content, services and locations", async () => {
    await resolveWith(projectRow());

    expect(prisma.project.findUnique).toHaveBeenCalledTimes(1);

    const arg = prisma.project.findUnique.mock.calls[0]?.[0];
    expect(arg?.where).toEqual({ id: "prj_1" });
    expect(arg?.include).toMatchObject({
      workspace: true,
      business: true,
      content: true,
    });
    // Services and locations are ordered, so generated page order is stable
    // between runs rather than left to the database.
    expect(arg?.include?.services).toEqual({ orderBy: { createdAt: "asc" } });
    expect(arg?.include?.locations).toEqual({ orderBy: { createdAt: "asc" } });
  });

  test("never opens a connection", async () => {
    await resolveWith(projectRow());

    expect(prisma.$connect).not.toHaveBeenCalled();
  });
});

describe("business mapping", () => {
  test("maps identity and flattened address into the engine's shape", async () => {
    const payload = await resolveWith(projectRow());

    expect(payload.businesses).toHaveLength(1);
    expect(payload.businesses[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      name: "GlanzFix Reinigungsservice",
      slug: "glanzfix",
      niche: "cleaning",
      contactEmail: "kontakt@glanzfix.de",
      address: {
        street: "Musterstraße 1",
        city: "Duisburg",
        state: "Nordrhein-Westfalen",
        postalCode: "47051",
        country: "DE",
      },
    });
  });

  test("omits foundedYear rather than passing null, which Zod would reject", async () => {
    const payload = await resolveWith(projectRow());

    expect("foundedYear" in payload.businesses[0]!).toBe(false);
  });

  test("includes foundedYear when the column is set", async () => {
    const row = projectRow();
    row.business.foundedYear = 2011 as never;

    const payload = await resolveWith(row);

    expect(payload.businesses[0]?.foundedYear).toBe(2011);
  });

  test("leaves eligibility unconstrained so the full product applies", async () => {
    const payload = await resolveWith(projectRow());

    expect(payload.businesses[0]?.serviceIds).toBeUndefined();
    expect(payload.businesses[0]?.locationIds).toBeUndefined();
  });
});

describe("service mapping", () => {
  test("carries the stored slug through untouched", async () => {
    const payload = await resolveWith(projectRow());

    // Not re-derived from the name: derivation would turn "Büroreinigung"
    // into "buroreinigung" and rename the published route.
    expect(payload.services[0]?.slug).toBe("bueroreinigung");
  });

  test("maps a complete price into pricing", async () => {
    const payload = await resolveWith(projectRow());

    expect(payload.services[0]?.pricing).toEqual({
      from: 25,
      to: 45,
      currency: "EUR",
    });
  });

  test("omits pricing when only one bound is stored", async () => {
    const row = projectRow({ services: [serviceRow({ priceTo: null })] });

    const payload = await resolveWith(row);

    expect(payload.services[0]?.pricing).toBeUndefined();
  });

  test("defaults the currency to EUR when the column is empty", async () => {
    const row = projectRow({ services: [serviceRow({ priceCurrency: null })] });

    const payload = await resolveWith(row);

    expect(payload.services[0]?.pricing?.currency).toBe("EUR");
  });

  test("omits a null templateId instead of passing null", async () => {
    const payload = await resolveWith(projectRow());

    expect("templateId" in payload.services[0]!).toBe(false);
  });

  test("passes a service-level templateId through", async () => {
    const row = projectRow({
      services: [serviceRow({ templateId: "luxuryLanding" })],
    });

    const payload = await resolveWith(row);

    expect(payload.services[0]?.templateId).toBe("luxuryLanding");
  });

  test("preserves service order", async () => {
    const row = projectRow({
      services: [
        serviceRow({ id: "svc_1", name: "Erste", slug: "erste" }),
        serviceRow({ id: "svc_2", name: "Zweite", slug: "zweite" }),
      ],
    });

    const payload = await resolveWith(row);

    expect(payload.services.map((item) => item.name)).toEqual([
      "Erste",
      "Zweite",
    ]);
  });
});

describe("location mapping", () => {
  test("maps city, state, country and postal code", async () => {
    const payload = await resolveWith(projectRow());

    expect(payload.locations[0]).toMatchObject({
      id: "loc_1",
      city: "Duisburg",
      state: "Nordrhein-Westfalen",
      country: "DE",
      postalCode: "47051",
    });
  });

  test("maps latitude and longitude into coordinates", async () => {
    const payload = await resolveWith(projectRow());

    expect(payload.locations[0]?.coordinates).toEqual({
      lat: 51.4344,
      lng: 6.7623,
    });
  });

  test("omits coordinates when either value is missing", async () => {
    const row = projectRow({ locations: [locationRow({ longitude: null })] });

    const payload = await resolveWith(row);

    expect(payload.locations[0]?.coordinates).toBeUndefined();
  });

  test("omits an absent postal code", async () => {
    const row = projectRow({ locations: [locationRow({ postalCode: null })] });

    const payload = await resolveWith(row);

    expect("postalCode" in payload.locations[0]!).toBe(false);
  });

  test("drops the database-only name and slug columns", async () => {
    const payload = await resolveWith(projectRow());

    // LocationSchema has no such fields; carrying them would be dead weight.
    expect("slug" in payload.locations[0]!).toBe(false);
    expect("name" in payload.locations[0]!).toBe(false);
  });
});

describe("content mapping", () => {
  test("maps hero, cta and faqs into the template shape", async () => {
    const payload = await resolveWith(projectRow());

    expect(payload.content).toMatchObject({
      hero: {
        titleTemplate: "{{service}} in {{city}}",
        subtitleTemplate: "{{service}} in {{city}} von {{business}}.",
      },
      cta: { primary: "Jetzt anfragen", secondary: "Anrufen" },
    });
    expect(payload.content.faqs).toHaveLength(3);
  });

  test("carries the project templateId as the content-level default", async () => {
    const row = projectRow({ templateId: "luxuryLanding" });

    const payload = await resolveWith(row);

    // Precedence stays service → content → "default"; this is the middle rung.
    expect(payload.content.templateId).toBe("luxuryLanding");
  });

  test("a service templateId still outranks the project one", async () => {
    const row = projectRow({
      templateId: "luxuryLanding",
      services: [serviceRow({ templateId: "default" })],
    });

    const payload = await resolveWith(row);

    expect(payload.content.templateId).toBe("luxuryLanding");
    expect(payload.services[0]?.templateId).toBe("default");
  });
});

describe("workspace context", () => {
  test("returns the owning tenant", async () => {
    const payload = await resolveWith(projectRow());

    expect(payload.workspace).toEqual({
      id: "ws_1",
      name: "GlanzFix GmbH",
      slug: "glanzfix-gmbh",
    });
  });

  test("exposes the project's stored locale", async () => {
    const payload = await resolveWith(projectRow({ locale: "en" }));

    expect(payload.locale).toBe("en");
  });
});

describe("fail-loud cases", () => {
  test("throws when the project does not exist", async () => {
    await expect(resolveWith(null)).rejects.toBeInstanceOf(ProjectPayloadError);
  });

  test("throws when the project has no business record", async () => {
    await expect(
      resolveWith(projectRow({ business: null })),
    ).rejects.toThrow(/no business record/);
  });

  test("throws when the project has no content template", async () => {
    await expect(
      resolveWith(projectRow({ content: null })),
    ).rejects.toThrow(/no content template/);
  });

  test("names the project id in the error", async () => {
    await expect(resolveWith(null)).rejects.toThrow(/prj_1/);
  });
});

describe("empty collections", () => {
  test("returns empty services and locations without failing", async () => {
    const payload = await resolveWith(
      projectRow({ services: [], locations: [] }),
    );

    expect(payload.services).toEqual([]);
    expect(payload.locations).toEqual([]);
  });
});
