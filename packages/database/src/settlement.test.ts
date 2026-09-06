import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import {
  reconcileStrandedHolds,
  settleJobHold,
  settleUsageEvent,
} from "./settlement.js";

/**
 * A quota hold that is always given back.
 *
 * The meter runs on the plugin bus, which absorbs listener failures on purpose
 * so a billing plugin can never abort a paid run. That trade leaves a hole: a
 * worker dying between finishing a job and writing the adjustment loses the
 * only record that anything was owed, and the hold stays charged for ever.
 *
 * These tests are about the two properties that close it — the settlement is
 * durable, and it happens exactly once.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
  prisma.$transaction.mockImplementation(((run: (tx: typeof prisma) => Promise<unknown>) =>
    run(prisma)) as unknown as typeof prisma.$transaction);
  // Unclaimed by default: this call is the one that settles it.
  prisma.generationJob.updateMany.mockResolvedValue({ count: 1 } as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.usageRecord.create.mockResolvedValue({ id: "usage_1" } as any);
});

/** The adjustment rows written, in order. */
function adjustments(): number[] {
  return prisma.usageRecord.create.mock.calls.map(
    (call) => (call[0] as { data: { amount: number } }).data.amount,
  );
}

describe("settling once, and only once", () => {
  test("a run that authored less than it held is credited the difference", async () => {
    await settleJobHold("job_1", 2, 10, "org_1", "AI_GENERATED_PAGES", prisma);

    // Append-only: the correction is a negative row beside the charge, not an
    // edit to it.
    expect(adjustments()).toEqual([-8]);
  });

  test("a failed run gives the whole hold back", async () => {
    await settleJobHold("job_1", 0, 4, "org_1", "AI_GENERATED_PAGES", prisma);

    expect(adjustments()).toEqual([-4]);
  });

  test("an exact estimate writes nothing", async () => {
    await settleJobHold("job_1", 3, 3, "org_1", "AI_GENERATED_PAGES", prisma);

    // A row that changes no total is noise in the one table a human reconciles
    // an invoice against.
    expect(adjustments()).toEqual([]);
  });

  test("a job already settled is not settled again", async () => {
    prisma.generationJob.updateMany.mockResolvedValue({ count: 0 } as never);

    const didSettle = await settleJobHold(
      "job_1",
      0,
      10,
      "org_1",
      "AI_GENERATED_PAGES",
      prisma,
    );

    // The whole reason the stamp exists. Settling twice would credit the tenant
    // ten units they were never charged — the reconciler racing the meter is
    // the ordinary case, not an error.
    expect(didSettle).toBe(false);
    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
  });

  test("the claim is a compare-and-set on the unsettled state", async () => {
    await settleJobHold("job_1", 1, 1, "org_1", "AI_GENERATED_PAGES", prisma);

    const where = (
      prisma.generationJob.updateMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      }
    ).where;

    // Without `settledAt: null` in the `where`, two callers both "claim" it and
    // both write, which is the double-credit this is built to prevent.
    expect(where).toEqual({ id: "job_1", settledAt: null });
  });

  test("the stamp and the adjustment share one transaction", async () => {
    await settleJobHold("job_1", 0, 5, "org_1", "AI_GENERATED_PAGES", prisma);

    // A stamp that committed without its row would silently swallow the refund;
    // a row without its stamp would be written again on the next pass.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("sweeping up holds whose event was lost", () => {
  /** Finished jobs still holding units. */
  function armStranded(
    rows: Array<{ id: string; status: string; reservedUnits: number; completedCount: number }>,
  ): void {
    prisma.generationJob.findMany.mockResolvedValue(
      rows.map((row) => ({
        ...row,
        project: { organizationId: "org_1" },
      })) as never,
    );
  }

  test("only finished jobs are looked at", async () => {
    armStranded([]);

    await reconcileStrandedHolds(prisma);

    const where = (
      prisma.generationJob.findMany.mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      }
    ).where;

    // A PENDING or RUNNING job is holding its units legitimately. Refunding one
    // mid-run would let a tenant exceed the ceiling by exactly the work in
    // flight, which is the race the hold exists to prevent.
    expect(where["status"]).toEqual({ in: ["COMPLETED", "FAILED"] });
    expect(where["settledAt"]).toBeNull();
    expect(where["reservedUnits"]).toEqual({ gt: 0 });
  });

  test("a failed job is refunded in full", async () => {
    armStranded([
      { id: "job_1", status: "FAILED", reservedUnits: 6, completedCount: 3 },
    ]);

    const result = await reconcileStrandedHolds(prisma);

    // Refunded whole, even though the counter says three pages: a failed run
    // produced nothing a customer can use. Same rule the live meter applies.
    expect(adjustments()).toEqual([-6]);
    expect(result).toEqual({ settled: 1, adjusted: -6 });
  });

  test("a completed job settles against what it actually wrote", async () => {
    armStranded([
      { id: "job_1", status: "COMPLETED", reservedUnits: 1, completedCount: 40 },
    ]);

    // Held one — an unscoped run cannot know its grid until it loads — and
    // authored forty. The tenant owes the other thirty-nine.
    expect((await reconcileStrandedHolds(prisma)).adjusted).toBe(39);
    expect(adjustments()).toEqual([39]);
  });

  test("one already claimed by the meter is not counted twice", async () => {
    armStranded([
      { id: "job_1", status: "FAILED", reservedUnits: 6, completedCount: 0 },
    ]);
    prisma.generationJob.updateMany.mockResolvedValue({ count: 0 } as never);

    // The reconciler and the meter both run, without either knowing about the
    // other. The stamp is what makes that safe.
    expect(await reconcileStrandedHolds(prisma)).toEqual({ settled: 0, adjusted: 0 });
    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
  });

  test("nothing stranded is not an error", async () => {
    armStranded([]);

    expect(await reconcileStrandedHolds(prisma)).toEqual({ settled: 0, adjusted: 0 });
  });
});

describe("routing an event to the right settlement", () => {
  test("a job event stamps the row", async () => {
    await settleUsageEvent(
      {
        organizationId: "org_1",
        metric: "AI_GENERATED_PAGES",
        amount: 5,
        reservedUnits: 9,
        resourceId: "job_7",
      },
      prisma,
    );

    expect(prisma.generationJob.updateMany).toHaveBeenCalledTimes(1);
    expect(adjustments()).toEqual([-4]);
  });

  test("a sync event does not, because there is no job to stamp", async () => {
    await settleUsageEvent(
      {
        organizationId: "org_1",
        metric: "SYNC_OPERATIONS",
        amount: 1,
        reservedUnits: 1,
        resourceId: "prj_1",
      },
      prisma,
    );

    // A sync holds and settles the same single unit, so its adjustment is
    // always zero and there is nothing to make idempotent.
    expect(prisma.generationJob.updateMany).not.toHaveBeenCalled();
    expect(adjustments()).toEqual([]);
  });

  test("a job event with no job id falls back rather than throwing", async () => {
    await settleUsageEvent(
      {
        organizationId: "org_1",
        metric: "AI_GENERATED_PAGES",
        amount: 0,
        reservedUnits: 2,
        resourceId: null,
      },
      prisma,
    );

    // Losing the refund would be worse than writing it without a stamp: an
    // unsettled hold counts against a tenant's own ceiling.
    expect(adjustments()).toEqual([-2]);
  });
});
