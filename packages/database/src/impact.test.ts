import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import {
  REGENERABLE_PAGE_SOURCES,
  affectedSlugs,
  findAffectedPages,
  type AffectedPage,
} from "./impact.js";

/**
 * Impact analysis, which decides what an incremental run is allowed to touch.
 *
 * Two properties carry the whole feature, and each is asserted from more than
 * one direction because each fails silently:
 *
 * 1. A change reaches the pages it reaches, and no others. Getting this wrong
 *    in the generous direction re-authors a project and charges for it; nothing
 *    breaks, and the only evidence is an invoice.
 * 2. A hand-edited page is never in the list. Getting *this* wrong destroys
 *    work an operator did deliberately, and the page still renders afterwards,
 *    so nothing reports it either.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

/** A stored page as the query returns it. */
function page(over: Partial<AffectedPage> = {}): AffectedPage {
  return {
    id: "pg_1",
    slug: "bueroreinigung-duisburg",
    serviceId: "svc-1",
    locationId: "loc-1",
    source: "AI",
    ...over,
  };
}

/** Arm the page read with a fixed result. */
function armPages(rows: AffectedPage[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.generatedPage.findMany.mockResolvedValue(rows as any);
}

/** The `where` the query was built with. */
function whereClause(): Record<string, unknown> {
  const call = prisma.generatedPage.findMany.mock.calls[0]?.[0] as
    | { where: Record<string, unknown> }
    | undefined;

  if (call === undefined) {
    throw new Error("findMany was never called.");
  }

  return call.where;
}

describe("a change reaches only the pages it reaches", () => {
  test("a changed service returns its pages", async () => {
    armPages([page()]);

    const found = await findAffectedPages("prj_1", "u1", ["svc-1"], [], prisma);

    expect(affectedSlugs(found)).toEqual(["bueroreinigung-duisburg"]);
    expect(whereClause()["OR"]).toEqual([
      { serviceId: { in: ["svc-1"] } },
      { locationId: { in: [] } },
    ]);
  });

  test("a changed location returns its pages", async () => {
    armPages([page({ slug: "grundreinigung-essen", locationId: "loc-2" })]);

    const found = await findAffectedPages("prj_1", "u1", [], ["loc-2"], prisma);

    expect(affectedSlugs(found)).toEqual(["grundreinigung-essen"]);
    expect(whereClause()["OR"]).toEqual([
      { serviceId: { in: [] } },
      { locationId: { in: ["loc-2"] } },
    ]);
  });

  test("a service and a location are matched with OR, not AND", async () => {
    // The distinction is not academic. Under AND, a sync that edited one
    // service and one unrelated city would return only the single page that
    // sits at their intersection, and every other page either of them reaches
    // would silently stay stale.
    armPages([]);

    await findAffectedPages("prj_1", "u1", ["svc-1"], ["loc-2"], prisma);

    const where = whereClause();

    expect(where).toHaveProperty("OR");
    expect(where).not.toHaveProperty("AND");
  });

  test("the query is scoped to the owner as well as the project", async () => {
    armPages([]);

    await findAffectedPages("prj_1", "u1", ["svc-1"], [], prisma);

    const where = whereClause();

    expect(where["projectId"]).toBe("prj_1");
    // Nothing else enforces tenant isolation here — there is no row-level
    // security behind this — so the scope in the query is the boundary.
    expect(where["project"]).toEqual({ userId: "u1" });
  });

  test("results are ordered by slug, so a caller's scope is stable", async () => {
    armPages([]);

    await findAffectedPages("prj_1", "u1", ["svc-1"], [], prisma);

    const call = prisma.generatedPage.findMany.mock.calls[0]?.[0] as {
      orderBy: unknown;
    };

    expect(call.orderBy).toEqual({ slug: "asc" });
  });
});

describe("nothing changed means nothing is asked", () => {
  test("two empty lists return nothing without touching the database", async () => {
    const found = await findAffectedPages("prj_1", "u1", [], [], prisma);

    expect(found).toEqual([]);
    // Not merely "returned empty". A query built from two empty `in` filters is
    // one refactor away from being a query with no filter at all, at which
    // point every page in the project is affected and an empty sync re-authors
    // the account.
    expect(prisma.generatedPage.findMany).not.toHaveBeenCalled();
  });

  test("a project with no matching pages returns an empty list", async () => {
    armPages([]);

    expect(await findAffectedPages("prj_1", "u1", ["svc-9"], [], prisma)).toEqual(
      [],
    );
  });
});

describe("a hand-edited page is never returned", () => {
  test("MANUAL is not a regenerable source", () => {
    expect(REGENERABLE_PAGE_SOURCES).not.toContain("MANUAL");
  });

  test("the exclusion is an allowlist, not a negation", () => {
    // A `not: MANUAL` filter would admit any PageSource added to the schema
    // later, and the first anyone would know is a customer's page being
    // overwritten. An allowlist fails the other way.
    expect([...REGENERABLE_PAGE_SOURCES].sort()).toEqual(["AI", "TEMPLATE"]);
  });

  test("the filter is in the query, not applied afterwards", async () => {
    armPages([]);

    await findAffectedPages("prj_1", "u1", ["svc-1"], ["loc-1"], prisma);

    // Asserted on the query rather than on the result, because a result-side
    // filter is one `.map()` away from being bypassed by a caller who only
    // wanted the slugs — and because a MANUAL row that reaches this process at
    // all has already been in a list it should never have been in.
    expect(whereClause()["source"]).toEqual({ in: ["TEMPLATE", "AI"] });
  });

  test("the exclusion survives every combination of arguments", async () => {
    const cases: Array<[string[], string[]]> = [
      [["svc-1"], []],
      [[], ["loc-1"]],
      [["svc-1"], ["loc-1"]],
      [["svc-1", "svc-2"], ["loc-1", "loc-2"]],
    ];

    for (const [services, locations] of cases) {
      prisma = mockDeep<PrismaClient>();
      armPages([]);

      await findAffectedPages("prj_1", "u1", services, locations, prisma);

      expect(whereClause()["source"]).toEqual({ in: ["TEMPLATE", "AI"] });
    }
  });
});
