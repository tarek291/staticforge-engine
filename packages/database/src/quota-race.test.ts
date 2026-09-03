import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import { reserveQuota } from "./quota.js";

/**
 * The quota race, and why the obvious fixes do not close it.
 *
 * ## What the audit found
 *
 * Usage was metered *retrospectively* — a row appeared when work finished — and
 * the gate only read. So between a check passing and the work being counted,
 * nothing existed for any other caller to see. Ten requests arriving together
 * summed the same zero, all found room, and all proceeded. A tenant with ten
 * pages of allowance could queue a hundred.
 *
 * ## Why this file exists rather than another test in `quota.test.ts`
 *
 * Because the interesting assertions here are about *what the gate writes*, and
 * they are the ones that would go on passing if somebody replaced the whole
 * mechanism with a lock and no write. Serialising ten checks that each read
 * zero produces ten passes, in order — which is the failure this must not be
 * able to regress to, and which no amount of "did it refuse when full" testing
 * would catch.
 *
 * So the simulation below gives the mock a *real* running total. That is the
 * only way a mocked test can say anything about a race: it models the
 * database's visibility rule — a committed write is seen by the next reader —
 * and then asserts the gate behaves correctly under it.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

const RESET = new Date(Date.now() - 3_600_000);

/**
 * A quota row with a running total that the gate's own writes move.
 *
 * The lock is modelled as what it actually buys: the sum is answered from state
 * that includes every hold committed before it. Under `READ COMMITTED` that is
 * exactly what `FOR UPDATE` followed by a *separate* sum statement gives you —
 * the second statement takes a fresh snapshot after the lock is granted.
 */
function armLedger(limit: number | null): { used: () => number } {
  const ledger = { used: 0 };

  prisma.$queryRawUnsafe.mockImplementation((sql: unknown) => {
    const text = String(sql);

    if (text.includes("OrganizationQuota")) {
      return Promise.resolve(
        limit === null ? [] : [{ limit, resetDate: RESET }],
      ) as never;
    }

    return Promise.resolve([{ used: BigInt(ledger.used) }]) as never;
  });

  prisma.usageRecord.create.mockImplementation(((args: {
    data: { amount: number };
  }) => {
    ledger.used += args.data.amount;

    return Promise.resolve({ id: `usage_${String(ledger.used)}` });
  }) as never);

  return { used: () => ledger.used };
}

describe("admissions are visible to the caller behind them", () => {
  test("ten callers against an allowance of ten admit ten, not a hundred", async () => {
    const ledger = armLedger(10);
    const verdicts: boolean[] = [];

    for (let i = 0; i < 100; i += 1) {
      const reservation = await reserveQuota("org_1", "AI_GENERATED_PAGES", 1, prisma);

      verdicts.push(reservation.verdict.allowed);
    }

    // Before Phase 31 every one of these passed, because nothing was written
    // between the check and the work finishing and each caller summed the same
    // zero. The count is the whole assertion.
    expect(verdicts.filter(Boolean)).toHaveLength(10);
    expect(ledger.used()).toBe(10);
  });

  test("a hold is written at admission, not after the work", async () => {
    armLedger(10);

    await reserveQuota("org_1", "AI_GENERATED_PAGES", 4, prisma);

    // The write *is* the fix. A lock without it would serialise the callers and
    // change nothing about what they read — all ten would still see zero and
    // all ten would still pass. Deleting this write is the mutation that must
    // fail, and it fails the test above rather than this one.
    expect(prisma.usageRecord.create).toHaveBeenCalledTimes(1);
    expect(
      (prisma.usageRecord.create.mock.calls[0]?.[0] as { data: { amount: number } })
        .data.amount,
    ).toBe(4);
  });

  test("the quota row is locked before the total is read", async () => {
    armLedger(10);

    await reserveQuota("org_1", "AI_GENERATED_PAGES", 1, prisma);

    const [first, second] = prisma.$queryRawUnsafe.mock.calls.map((call) =>
      String(call[0]),
    );

    // Order carries the guarantee. Lock, then sum — because the sum must be a
    // separate statement taken *after* the lock is granted, so its snapshot
    // includes the hold committed by whoever was ahead. Reversed, or folded
    // into one statement as a CTE, both callers read the same stale total.
    expect(first).toContain("FOR UPDATE");
    expect(first).toContain("OrganizationQuota");
    expect(second).toContain("SUM");
    expect(second).toContain("UsageRecord");
  });

  test("a partly-full allowance admits exactly what is left", async () => {
    const ledger = armLedger(10);

    // Seven taken by work already in flight.
    await reserveQuota("org_1", "AI_GENERATED_PAGES", 7, prisma);

    const fits = await reserveQuota("org_1", "AI_GENERATED_PAGES", 3, prisma);
    const overshoots = await reserveQuota("org_1", "AI_GENERATED_PAGES", 1, prisma);

    expect(fits.verdict.allowed).toBe(true);
    expect(overshoots.verdict.allowed).toBe(false);
    expect(ledger.used()).toBe(10);
  });

  test("a large request is refused whole rather than admitted in part", async () => {
    const ledger = armLedger(10);

    const tooBig = await reserveQuota("org_1", "AI_GENERATED_PAGES", 11, prisma);

    // Nothing is a partial admission. A run scoped to eleven pages that was let
    // through "for ten of them" would author eleven and bill for eleven.
    expect(tooBig.verdict.allowed).toBe(false);
    expect(tooBig.reserved).toBe(0);
    expect(ledger.used()).toBe(0);
  });
});

describe("what the caller is told to give back", () => {
  test("`reserved` is what was held, not what was asked for", async () => {
    armLedger(null);

    const reservation = await reserveQuota("org_1", "AI_GENERATED_PAGES", 5, prisma);

    // No quota configured, so nothing was held. A caller that refunded the
    // *requested* five would credit a tenant five units they never consumed —
    // which, on an unlimited plan, means inventing negative usage out of
    // nothing and putting it on an invoice.
    expect(reservation.verdict.allowed).toBe(true);
    expect(reservation.reserved).toBe(0);
    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
  });

  test("a refusal holds nothing, so retrying is not charged for", async () => {
    const ledger = armLedger(1);

    await reserveQuota("org_1", "AI_GENERATED_PAGES", 1, prisma);

    for (let i = 0; i < 5; i += 1) {
      const refused = await reserveQuota("org_1", "AI_GENERATED_PAGES", 1, prisma);

      expect(refused.reserved).toBe(0);
    }

    // A gate that metered its own refusals would charge for being told no, and
    // charge again on every retry — so a tenant at their limit would be billed
    // for the act of discovering it.
    expect(ledger.used()).toBe(1);
  });

  test("a zero-unit request holds nothing and is allowed", async () => {
    armLedger(10);

    const reservation = await reserveQuota("org_1", "AI_GENERATED_PAGES", 0, prisma);

    expect(reservation.verdict.allowed).toBe(true);
    expect(reservation.reserved).toBe(0);
    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
  });
});

describe("a quota that cannot honestly be counted against refuses", () => {
  test("a reset date in the future is refused, and holds nothing", async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: unknown) =>
      String(sql).includes("OrganizationQuota")
        ? (Promise.resolve([
            { limit: 100, resetDate: new Date(Date.now() + 86_400_000) },
          ]) as never)
        : (Promise.resolve([{ used: BigInt(0) }]) as never),
    );

    const reservation = await reserveQuota("org_1", "AI_GENERATED_PAGES", 1, prisma);

    // "Nothing counts yet" is a quota that silently permits everything, which is
    // the failure a quota exists to prevent. Refused, so a typo surfaces as a
    // blocked operation rather than as an unlimited account.
    expect(reservation.verdict.allowed).toBe(false);
    expect(reservation.reserved).toBe(0);
    expect(reservation.verdict.reason).toMatch(/reset date in the future/i);
  });

  test("a negative limit is refused rather than treated as generous", async () => {
    armLedger(-1);

    const reservation = await reserveQuota("org_1", "AI_GENERATED_PAGES", 1, prisma);

    expect(reservation.verdict.allowed).toBe(false);
    expect(reservation.verdict.reason).toMatch(/negative/i);
  });
});

describe("the total is read as a number, whatever the driver returns", () => {
  test("a bigint sum does not become a string concatenation", async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: unknown) =>
      String(sql).includes("OrganizationQuota")
        ? (Promise.resolve([{ limit: 10, resetDate: RESET }]) as never)
        : // Postgres returns `SUM` as a bigint through this driver. Left
          // uncoerced, `used + wanted` is a TypeError and the gate throws on a
          // perfectly healthy database — refusing every tenant.
          (Promise.resolve([{ used: BigInt(9) }]) as never),
    );

    const reservation = await reserveQuota("org_1", "AI_GENERATED_PAGES", 1, prisma);

    expect(reservation.verdict.used).toBe(9);
    expect(reservation.verdict.allowed).toBe(true);
  });

  test("an empty ledger reads as zero rather than as null", async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: unknown) =>
      String(sql).includes("OrganizationQuota")
        ? (Promise.resolve([{ limit: 10, resetDate: RESET }]) as never)
        : // An empty `SUM` is `NULL` in SQL. A caller comparing `null > limit`
          // gets `false` and allows everything.
          (Promise.resolve([]) as never),
    );

    const reservation = await reserveQuota("org_1", "AI_GENERATED_PAGES", 1, prisma);

    expect(reservation.verdict.used).toBe(0);
  });
});
