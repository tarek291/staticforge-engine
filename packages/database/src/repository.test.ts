import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import {
  ProjectPayloadError,
  getProjectPayload,
  saveGeneratedPages,
} from "./repository.js";

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
function resolveWith(row: unknown, userId = "local-operator") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.project.findFirst.mockResolvedValue(row as any);
  return getProjectPayload("prj_1", userId, prisma);
}

describe("query shape", () => {
  test("fetches the project with workspace, business, content, services and locations", async () => {
    await resolveWith(projectRow());

    expect(prisma.project.findFirst).toHaveBeenCalledTimes(1);

    const arg = prisma.project.findFirst.mock.calls[0]?.[0];
    // Scoped in the query, not checked after it: the owner is part of finding
    // the project at all.
    expect(arg?.where).toEqual({ id: "prj_1", userId: "local-operator" });
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

  test("carries the caller's own id into the where clause", async () => {
    await resolveWith(projectRow(), "user_other");

    expect(prisma.project.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "prj_1",
      userId: "user_other",
    });
  });

  test("a foreign project is indistinguishable from a missing one", async () => {
    // The scoped query returns null in both cases, and the message must not
    // separate them, or this becomes a way to discover which ids are real.
    await expect(resolveWith(null, "user_other")).rejects.toThrow(
      "Project \"prj_1\": not found.",
    );
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

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/** A validated engine page, as `buildPages` hands it over. */
function enginePage(overrides: Record<string, unknown> = {}) {
  return {
    slug: "bueroreinigung-duisburg",
    locale: "de",
    title: "Büroreinigung in Duisburg",
    metaDescription: "Professionelle Büroreinigung in Duisburg.",
    h1: "Büroreinigung in Duisburg",
    content: {
      hero: { heading: "Büroreinigung in Duisburg", subheading: "Zuverlässig." },
      sections: [{ heading: "Ablauf", body: "Wir reinigen gründlich." }],
      faq: [{ question: "Wie schnell?", answer: "Wenige Tage." }],
      cta: {
        heading: "Jetzt anfragen",
        buttonLabel: "Angebot",
        href: "mailto:kontakt@glanzfix.de",
      },
    },
    schemaOrg: { "@context": "https://schema.org", "@type": "Service" },
    templateId: "default",
    businessId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    serviceId: "svc-bueroreinigung",
    locationId: "loc-duisburg",
    ...overrides,
  };
}

/** Call the write path with loosely typed fixtures. */
function save(
  pages: ReturnType<typeof enginePage>[],
  options?: Parameters<typeof saveGeneratedPages>[4],
  userId = "local-operator",
) {
  return saveGeneratedPages(
    "prj_1",
    userId,
    pages as unknown as Parameters<typeof saveGeneratedPages>[2],
    prisma,
    options,
  );
}

/**
 * Arm the interactive `$transaction` so its callback runs against the mock.
 *
 * The write path is a callback rather than an array because the ownership check
 * has to be *inside* the transaction: a check before it leaves a window in
 * which the project changes hands. Handing the callback the same mock keeps
 * every assertion below pointed at the calls it really makes.
 */
function armTransaction(
  removed = 0,
  owned = true,
  /** Slugs an operator has edited by hand, which the run must not overwrite. */
  manualSlugs: string[] = [],
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.project.findFirst.mockResolvedValue((owned ? { id: "prj_1" } : null) as any);
  prisma.generatedPage.findMany.mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    manualSlugs.map((slug) => ({ slug })) as any,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.generatedPage.deleteMany.mockResolvedValue({ count: removed } as any);
  prisma.$transaction.mockImplementation(((
    run: (tx: typeof prisma) => Promise<unknown>,
  ) => run(prisma)) as unknown as typeof prisma.$transaction);
}

/** The `create` payload of the nth upsert call. */
function createArg(index = 0): Record<string, unknown> {
  return prisma.generatedPage.upsert.mock.calls[index]?.[0]
    ?.create as unknown as Record<string, unknown>;
}

describe("saveGeneratedPages", () => {
  beforeEach(() => {
    armTransaction();
  });

  test("runs every write inside a single transaction", async () => {
    await save([enginePage(), enginePage({ slug: "grundreinigung-essen" })]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // The interactive form: one callback carrying the ownership check, the
    // stale deletion and every upsert, so a failure part-way rolls all of it
    // back rather than leaving the project half-updated.
    expect(typeof prisma.$transaction.mock.calls[0]?.[0]).toBe("function");
    expect(prisma.generatedPage.upsert).toHaveBeenCalledTimes(2);
  });

  test("proves ownership inside the transaction, before any write", async () => {
    await save([enginePage()]);

    const ownershipOrder =
      prisma.project.findFirst.mock.invocationCallOrder[0] ?? 0;
    const deleteOrder =
      prisma.generatedPage.deleteMany.mock.invocationCallOrder[0] ?? 0;

    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { id: "prj_1", userId: "local-operator" },
      select: { id: true },
    });
    expect(ownershipOrder).toBeLessThan(deleteOrder);
  });

  test("writes nothing at all into a project the caller does not own", async () => {
    armTransaction(0, false);

    await expect(save([enginePage()], undefined, "user_other")).rejects.toThrow(
      "Project \"prj_1\": not found.",
    );

    // Not "deletes but does not write", and not "writes then rolls back":
    // neither statement is ever reached.
    expect(prisma.generatedPage.deleteMany).not.toHaveBeenCalled();
    expect(prisma.generatedPage.upsert).not.toHaveBeenCalled();
  });

  test("deletes stale pages before writing, not after", async () => {
    await save([enginePage(), enginePage({ slug: "grundreinigung-essen" })]);

    // The unique (projectId, serviceId, locationId) constraint means a renamed
    // service's old row must be gone before the new one is inserted.
    const deleteOrder =
      prisma.generatedPage.deleteMany.mock.invocationCallOrder[0] ?? 0;
    const firstUpsertOrder =
      prisma.generatedPage.upsert.mock.invocationCallOrder[0] ?? 0;

    expect(deleteOrder).toBeLessThan(firstUpsertOrder);
  });

  test("scopes stale deletion to the project and the slugs it did not produce", async () => {
    await save([enginePage(), enginePage({ slug: "grundreinigung-essen" })]);

    expect(prisma.generatedPage.deleteMany).toHaveBeenCalledWith({
      where: {
        projectId: "prj_1",
        // Scoped through the relation as well as by id, so a refactor that
        // drops the ownership check still cannot reach another tenant's rows.
        project: { userId: "local-operator" },
        slug: { notIn: ["bueroreinigung-duisburg", "grundreinigung-essen"] },
      },
    });
  });

  test("keys the upsert on (projectId, slug)", async () => {
    await save([enginePage()]);

    expect(prisma.generatedPage.upsert.mock.calls[0]?.[0]?.where).toEqual({
      projectId_slug: { projectId: "prj_1", slug: "bueroreinigung-duisburg" },
    });
  });

  test("stores content and schemaOrg as the JSON objects they are", async () => {
    await save([enginePage()]);

    // Passed through structurally — not stringified, not flattened.
    expect(createArg().content).toEqual(enginePage().content);
    expect(createArg().schemaOrg).toEqual({
      "@context": "https://schema.org",
      "@type": "Service",
    });
    expect(typeof createArg().content).toBe("object");
    expect(typeof createArg().schemaOrg).toBe("object");
  });

  test("writes the same fields on create and update", async () => {
    await save([enginePage()]);

    const { projectId, slug, ...created } = createArg();

    expect(projectId).toBe("prj_1");
    expect(slug).toBe("bueroreinigung-duisburg");
    // A re-run must refresh every field, not merely insert new rows.
    expect(prisma.generatedPage.upsert.mock.calls[0]?.[0]?.update).toEqual(
      created,
    );
  });

  test("carries the service and location foreign keys", async () => {
    await save([enginePage()]);

    expect(createArg()).toMatchObject({
      serviceId: "svc-bueroreinigung",
      locationId: "loc-duisburg",
    });
  });

  test("defaults the source to TEMPLATE", async () => {
    await save([enginePage()]);

    expect(createArg()).toMatchObject({ source: "TEMPLATE" });
  });

  test("records AI provenance when the authoring pass ran", async () => {
    await save([enginePage()], { source: "AI" });

    expect(createArg()).toMatchObject({ source: "AI" });
  });

  test("preserves the templateId the generator resolved", async () => {
    await save([enginePage({ templateId: "luxuryLanding" })]);

    expect(createArg()).toMatchObject({ templateId: "luxuryLanding" });
  });

  test("does not store businessId, which the project already implies", async () => {
    await save([enginePage()]);

    expect("businessId" in createArg()).toBe(false);
  });

  test("upserts one row per page", async () => {
    await save([
      enginePage(),
      enginePage({ slug: "grundreinigung-essen" }),
      enginePage({ slug: "treppenhausreinigung-essen" }),
    ]);

    expect(prisma.generatedPage.upsert).toHaveBeenCalledTimes(3);
  });

  test("reports how many pages were saved and stale rows removed", async () => {
    armTransaction(4);

    const result = await save([
      enginePage(),
      enginePage({ slug: "grundreinigung-essen" }),
    ]);

    expect(result).toEqual({ saved: 2, removed: 4, preserved: 0 });
  });

  test("an empty run clears the project's pages, as file mode does", async () => {
    armTransaction(9);

    const result = await save([]);

    expect(prisma.generatedPage.deleteMany).toHaveBeenCalledWith({
      where: {
        projectId: "prj_1",
        project: { userId: "local-operator" },
        slug: { notIn: [] },
      },
    });
    expect(prisma.generatedPage.upsert).not.toHaveBeenCalled();
    expect(result).toEqual({ saved: 0, removed: 9, preserved: 0 });
  });

  test("never opens a connection", async () => {
    await save([enginePage()]);

    expect(prisma.$connect).not.toHaveBeenCalled();
  });
});

describe("manual edits survive a generation run", () => {
  beforeEach(() => {
    armTransaction();
  });

  test("a page an operator edited is not overwritten", async () => {
    armTransaction(0, true, ["bueroreinigung-duisburg"]);

    const result = await save([
      enginePage(),
      enginePage({ slug: "grundreinigung-essen" }),
    ]);

    // A refresh records source: MANUAL. This pass used to overwrite every slug
    // it produced, so several revision passes of human work vanished the next
    // time anyone pressed Generate, with no warning.
    const written = prisma.generatedPage.upsert.mock.calls.map(
      (call) => call[0]?.where?.projectId_slug?.slug,
    );

    expect(written).toEqual(["grundreinigung-essen"]);
    expect(result).toEqual({ saved: 1, removed: 0, preserved: 1 });
  });

  test("an edited page is not deleted as stale either", async () => {
    // Removing hand-edited work because a service was renamed is the same loss
    // by a different route.
    armTransaction(0, true, ["hand-written-page"]);

    await save([enginePage()]);

    expect(prisma.generatedPage.deleteMany).toHaveBeenCalledWith({
      where: {
        projectId: "prj_1",
        project: { userId: "local-operator" },
        slug: { notIn: ["bueroreinigung-duisburg", "hand-written-page"] },
      },
    });
  });

  test("looks for edits inside the transaction, before deciding anything", async () => {
    armTransaction(0, true, []);

    await save([enginePage()]);

    // Read inside the transaction, so a refresh landing mid-run is either fully
    // visible here or not yet applied.
    expect(prisma.generatedPage.findMany).toHaveBeenCalledWith({
      where: { projectId: "prj_1", source: "MANUAL" },
      select: { slug: true },
    });

    const lookupOrder = prisma.generatedPage.findMany.mock.invocationCallOrder[0] ?? 0;
    const deleteOrder = prisma.generatedPage.deleteMany.mock.invocationCallOrder[0] ?? 0;

    expect(lookupOrder).toBeLessThan(deleteOrder);
  });

  test("a run with no manual pages behaves exactly as before", async () => {
    armTransaction(2, true, []);

    const result = await save([enginePage()]);

    expect(prisma.generatedPage.upsert).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ saved: 1, removed: 2, preserved: 0 });
  });
});
