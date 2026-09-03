import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import {
  QuotaExceededError,
  USAGE_METRICS_IN_SYNC,
  checkQuota,
  recordUsage,
  requireQuota,
  setQuota,
  sumUsage,
} from "./quota.js";

/**
 * The quota gate.
 *
 * Two failure directions, and they are not symmetrical. A gate that wrongly
 * refuses stops a paying customer and produces a support ticket within the
 * hour. A gate that wrongly *permits* produces nothing at all until somebody
 * reconciles an invoice, which is why most of these tests are about the
 * permissive direction: an empty sum read as `null`, a limit that is absent, a
 * reset date that quietly counts nothing.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);

/**
 * The error a call produced.
 *
 * Also asserts that it produced one: a `.catch()` that quietly returned the
 * resolved value would let a test about refusing pass against code that
 * allowed.
 */
async function errorFrom<E extends Error>(call: Promise<unknown>): Promise<E> {
  try {
    await call;
  } catch (error: unknown) {
    return error as E;
  }

  throw new Error("Expected the call to reject, but it resolved.");
}


/** Arm the quota row. `null` means none configured. */
function armQuota(row: { limit: number; resetDate: Date } | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.organizationQuota.findUnique.mockResolvedValue(row as any);
}

/** Arm the usage sum. `null` is what Postgres returns for an empty SUM. */
function armUsage(sum: number | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.usageRecord.aggregate.mockResolvedValue({ _sum: { amount: sum } } as any);
}

describe("counting what has been used", () => {
  test("an empty period is zero, not null", async () => {
    armUsage(null);

    // `SUM` over no rows is `NULL` in SQL. A caller comparing `null > limit`
    // gets `false` and allows everything — the exact shape of a limit that
    // silently does not apply.
    expect(await sumUsage("org_1", "SYNC_OPERATIONS", HOUR_AGO, prisma)).toBe(0);
  });

  test("usage is summed from the reset date forward", async () => {
    armUsage(42);

    await sumUsage("org_1", "AI_GENERATED_PAGES", HOUR_AGO, prisma);

    expect(prisma.usageRecord.aggregate.mock.calls[0]?.[0]?.where).toEqual({
      organizationId: "org_1",
      metric: "AI_GENERATED_PAGES",
      recordedAt: { gte: HOUR_AGO },
    });
  });

  test("the sum is scoped to one organization and one metric", async () => {
    armUsage(0);

    await sumUsage("org_1", "SYNC_OPERATIONS", HOUR_AGO, prisma);

    const where = prisma.usageRecord.aggregate.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;

    // A sum that spanned metrics would let a project's page usage exhaust its
    // sync allowance, and vice versa.
    expect(where["organizationId"]).toBe("org_1");
    expect(where["metric"]).toBe("SYNC_OPERATIONS");
  });
});

describe("an organization with room", () => {
  test("is allowed, and told what is left", async () => {
    armQuota({ limit: 100, resetDate: HOUR_AGO });
    armUsage(30);

    const verdict = await checkQuota("org_1", "AI_GENERATED_PAGES", 10, prisma);

    expect(verdict.allowed).toBe(true);
    expect(verdict.used).toBe(30);
    expect(verdict.limit).toBe(100);
    expect(verdict.remaining).toBe(70);
  });

  test("consuming exactly the remainder is allowed", async () => {
    armQuota({ limit: 100, resetDate: HOUR_AGO });
    armUsage(90);

    // `<=`, not `<`. Off by one here makes the last unit of every plan
    // permanently unsellable.
    expect((await checkQuota("org_1", "AI_GENERATED_PAGES", 10, prisma)).allowed).toBe(
      true,
    );
  });

  test("one more than the remainder is refused", async () => {
    armQuota({ limit: 100, resetDate: HOUR_AGO });
    armUsage(90);

    expect((await checkQuota("org_1", "AI_GENERATED_PAGES", 11, prisma)).allowed).toBe(
      false,
    );
  });

  test("checking consumes nothing", async () => {
    armQuota({ limit: 100, resetDate: HOUR_AGO });
    armUsage(30);

    await checkQuota("org_1", "AI_GENERATED_PAGES", 10, prisma);

    // A gate that metered its own checks would charge a tenant for being
    // refused, and would inflate every bill by the size of the retry loop in
    // front of it.
    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
  });
});

describe("an organization out of room", () => {
  test("is refused", async () => {
    armQuota({ limit: 10, resetDate: HOUR_AGO });
    armUsage(10);

    const verdict = await checkQuota("org_1", "SYNC_OPERATIONS", 1, prisma);

    expect(verdict.allowed).toBe(false);
    expect(verdict.remaining).toBe(0);
  });

  test("the reason names the numbers, so an operator can act on it", async () => {
    armQuota({ limit: 10, resetDate: HOUR_AGO });
    armUsage(10);

    const verdict = await checkQuota("org_1", "SYNC_OPERATIONS", 1, prisma);

    expect(verdict.reason).toContain("10");
    expect(verdict.reason).toContain("SYNC_OPERATIONS");
  });

  test("remaining never goes negative", async () => {
    armQuota({ limit: 10, resetDate: HOUR_AGO });
    armUsage(25);

    // An overshoot is already visible in `used` against `limit`. A negative
    // "remaining" is a number nobody can act on and that every progress bar
    // renders wrong.
    expect((await checkQuota("org_1", "SYNC_OPERATIONS", 1, prisma)).remaining).toBe(0);
  });

  test("a zero limit blocks everything, which is how suspension is expressed", async () => {
    armQuota({ limit: 0, resetDate: HOUR_AGO });
    armUsage(0);

    expect((await checkQuota("org_1", "SYNC_OPERATIONS", 1, prisma)).allowed).toBe(false);
  });

  test("requireQuota throws rather than returning a verdict to ignore", async () => {
    armQuota({ limit: 10, resetDate: HOUR_AGO });
    armUsage(10);

    // `checkQuota` returns something a caller can drop on the floor.
    // `requireQuota` cannot be forgotten by accident, for the same reason
    // `requireRole` throws.
    await expect(
      requireQuota("org_1", "SYNC_OPERATIONS", 1, prisma),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  test("the thrown error carries the numbers, not just a message", async () => {
    armQuota({ limit: 10, resetDate: HOUR_AGO });
    armUsage(10);

    const error = await errorFrom<QuotaExceededError>(
      requireQuota("org_1", "SYNC_OPERATIONS", 1, prisma),
    );

    expect(error.organizationId).toBe("org_1");
    expect(error.verdict.used).toBe(10);
    expect(error.verdict.limit).toBe(10);
    // So a route can answer 402 with a body a customer can act on, without
    // parsing prose.
    expect(error.verdict.metric).toBe("SYNC_OPERATIONS");
  });
});

describe("a misconfigured quota fails closed", () => {
  test("a reset date in the future is refused, not ignored", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    armQuota({ limit: 100, resetDate: future });
    armUsage(0);

    const verdict = await checkQuota("org_1", "SYNC_OPERATIONS", 1, prisma);

    // Counting from a future instant sums nothing, which is a quota that
    // silently permits everything — the one failure a quota exists to prevent.
    // So it refuses and says why, rather than becoming an unlimited account.
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/future/i);
    expect(prisma.usageRecord.aggregate).not.toHaveBeenCalled();
  });

  test("a negative limit is refused", async () => {
    armQuota({ limit: -5, resetDate: HOUR_AGO });

    const verdict = await checkQuota("org_1", "SYNC_OPERATIONS", 1, prisma);

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/negative/i);
  });

  test("the metric union and the Prisma enum are the same set", () => {
    // A metric added to the schema and not to the union would be unmeterable:
    // every quota lookup for it would miss, which fails open. Caught by a build
    // rather than by an unbilled customer.
    expect(USAGE_METRICS_IN_SYNC).toBe(true);
  });
});

describe("no quota configured means no limit", () => {
  test("an organization with no row is allowed", async () => {
    armQuota(null);

    const verdict = await checkQuota("org_1", "AI_GENERATED_PAGES", 500, prisma);

    // The one deliberate fail-open. Quotas are opt-in, and a default of zero
    // would have stopped every existing tenant the moment the table shipped.
    expect(verdict.allowed).toBe(true);
    expect(verdict.limit).toBeNull();
    expect(verdict.remaining).toBeNull();
  });

  test("it does not even count usage, since nothing bounds it", async () => {
    armQuota(null);

    await checkQuota("org_1", "AI_GENERATED_PAGES", 500, prisma);

    expect(prisma.usageRecord.aggregate).not.toHaveBeenCalled();
  });
});

describe("recording usage", () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.usageRecord.create.mockResolvedValue({ id: "usage_1" } as any);
  });

  test("it inserts rather than updating a running total", async () => {
    await recordUsage(
      { organizationId: "org_1", metric: "AI_GENERATED_PAGES", amount: 9, resourceId: "job_1" },
      prisma,
    );

    // A running total is one number two writers race to update. A sum over an
    // append-only table needs no lock and can be recomputed from the records if
    // it is ever doubted, which is what makes it defensible on an invoice.
    expect(prisma.usageRecord.create.mock.calls[0]?.[0]?.data).toEqual({
      organizationId: "org_1",
      metric: "AI_GENERATED_PAGES",
      amount: 9,
      resourceId: "job_1",
    });
    expect(prisma.usageRecord.update).not.toHaveBeenCalled();
    expect(prisma.usageRecord.updateMany).not.toHaveBeenCalled();
  });

  test("nothing is written for a zero amount", async () => {
    expect(
      await recordUsage(
        { organizationId: "org_1", metric: "SYNC_OPERATIONS", amount: 0 },
        prisma,
      ),
    ).toBeNull();

    // A row that changes no total is noise in the one table a human has to read
    // when reconciling an invoice.
    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
  });

  test("a negative amount is allowed, because a credit is not an edit", async () => {
    await recordUsage(
      { organizationId: "org_1", metric: "AI_GENERATED_PAGES", amount: -5 },
      prisma,
    );

    expect(prisma.usageRecord.create).toHaveBeenCalledTimes(1);
  });
});

describe("setting a quota", () => {
  test("it upserts on the organization and metric pair", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.organizationQuota.upsert.mockResolvedValue({} as any);
    armQuota({ limit: 500, resetDate: HOUR_AGO });
    armUsage(0);

    await setQuota(
      { organizationId: "org_1", metric: "AI_GENERATED_PAGES", limit: 500 },
      "local-operator",
      prisma,
    );

    // Two rows for one metric would make the answer depend on which was read
    // first, and the generous one would win.
    expect(prisma.organizationQuota.upsert.mock.calls[0]?.[0]?.where).toEqual({
      organizationId_metric: {
        organizationId: "org_1",
        metric: "AI_GENERATED_PAGES",
      },
    });
  });
});
