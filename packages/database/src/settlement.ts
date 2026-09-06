import type { PrismaClient } from "@prisma/client";

import { recordUsage, type UsageMetricName } from "./quota.js";
import { withDbRetry } from "./retry.js";

/**
 * Making sure a quota hold is always given back.
 *
 * ## The gap this closes
 *
 * The quota gate holds an estimate when work is admitted, and the meter writes
 * the difference when the work finishes. The meter runs on the plugin bus —
 * which is best-effort **on purpose**: it absorbs listener failures so that a
 * billing plugin can never abort a paid, hour-long build.
 *
 * That trade is right, and it leaves a hole. A worker that dies between
 * finishing a job and writing the adjustment loses the event, and with it the
 * only record that anything was owed back. The hold stays charged against the
 * tenant's ceiling for ever, and nothing anywhere knows.
 *
 * "Retry the write" does not fix it either: a retry loop lives in the same
 * process that just died.
 *
 * ## Why this needs no new table
 *
 * The hold is already durable — it is a `UsageRecord` — and the amount is
 * already on the job row as `reservedUnits`. What was missing was a way to tell
 * a settled job from an unsettled one, which is one nullable column rather than
 * an outbox, a queue and a second worker.
 *
 * So `settledAt` is stamped **in the same transaction** as the adjustment. The
 * pair commits together or not at all, which makes the stamp both the durable
 * record and the idempotency key: a job that already carries one is skipped,
 * because settling twice would double-count the correction it was meant to fix.
 *
 * ## What the reconciler is for
 *
 * Finished jobs holding units with no stamp. It runs on the worker's idle tick,
 * where there is by definition nothing more urgent to do, and it is the thing
 * that turns "the event was lost" from permanent into late.
 */

/** A job whose hold outlived the event that should have settled it. */
export interface StrandedHold {
  jobId: string;
  organizationId: string;
  /** Units held at admission. */
  reservedUnits: number;
  /** Pages the run actually authored, or `0` when it failed. */
  actualUnits: number;
}

/** What a settlement pass did. */
export interface SettlementResult {
  /** Jobs whose hold was reconciled. */
  settled: number;
  /** Net units returned to tenants. Negative is a refund. */
  adjusted: number;
}

/**
 * Settle one job's hold, once.
 *
 * @param jobId - The job.
 * @param actualUnits - What it really produced. Zero for a failed run.
 * @param reservedUnits - What was held. Zero means nothing to settle.
 * @param organizationId - Whose ledger the adjustment belongs to.
 * @param prisma - The client.
 * @returns Whether this call is the one that settled it. `false` means it was
 * already settled, which is the ordinary outcome of a reconciler racing the
 * meter and is not an error.
 */
export async function settleJobHold(
  jobId: string,
  actualUnits: number,
  reservedUnits: number,
  organizationId: string,
  metric: UsageMetricName,
  prisma: PrismaClient,
): Promise<boolean> {
  const delta = actualUnits - Math.max(0, reservedUnits);

  return withDbRetry(() =>
    prisma.$transaction(async (tx) => {
      // The claim and the write, together. `updateMany` with the null check is
      // a compare-and-set: exactly one caller can move the row from unsettled
      // to settled, so the meter and the reconciler can both run without either
      // needing to know about the other.
      //
      // Claimed *before* the adjustment is written, so the failure mode is a
      // stamp with no row rather than a row with no stamp — the first
      // under-refunds a tenant once and is visible in the ledger, the second
      // would let the reconciler write the correction again on its next pass.
      const { count } = await tx.generationJob.updateMany({
        where: { id: jobId, settledAt: null },
        data: { settledAt: new Date() },
      });

      if (count === 0) {
        return false;
      }

      if (delta !== 0) {
        await tx.usageRecord.create({
          data: {
            organizationId,
            metric,
            amount: delta,
            resourceId: jobId,
          },
        });
      }

      return true;
    }),
  );
}

/** How many stranded holds one pass will look at. */
export const RECONCILE_BATCH = 50;

/**
 * Find and settle holds whose lifecycle event never arrived.
 *
 * Only **finished** jobs: a `PENDING` or `RUNNING` job is holding its units
 * legitimately, and refunding one mid-run would let a tenant exceed the ceiling
 * by exactly the work in flight — which is the race the hold exists to prevent.
 *
 * A failed job settles to zero, refunding the whole hold. That matches what the
 * meter does on the live path, and it has to: a customer must not be charged an
 * estimate for a run that produced nothing they can use.
 *
 * @param prisma - The client.
 * @param limit - How many to take in one pass.
 * @returns What was reconciled, so a worker can log it.
 */
export async function reconcileStrandedHolds(
  prisma: PrismaClient,
  limit: number = RECONCILE_BATCH,
): Promise<SettlementResult> {
  const stranded = await withDbRetry(() =>
    prisma.generationJob.findMany({
      where: {
        status: { in: ["COMPLETED", "FAILED"] },
        reservedUnits: { gt: 0 },
        settledAt: null,
      },
      select: {
        id: true,
        status: true,
        reservedUnits: true,
        completedCount: true,
        project: { select: { organizationId: true } },
      },
      // Oldest first. A hold that has been outstanding longest is the one most
      // likely to be genuinely lost rather than merely in flight.
      orderBy: { completedAt: "asc" },
      take: limit,
    }),
  );

  let settled = 0;
  let adjusted = 0;

  for (const job of stranded) {
    // A failed run produced nothing a customer can use, whatever its counter
    // says — the same rule the meter applies on the live path.
    const actual = job.status === "COMPLETED" ? Math.max(0, job.completedCount) : 0;

    const didSettle = await settleJobHold(
      job.id,
      actual,
      job.reservedUnits,
      job.project.organizationId,
      "AI_GENERATED_PAGES",
      prisma,
    );

    if (didSettle) {
      settled += 1;
      adjusted += actual - job.reservedUnits;
    }
  }

  return { settled, adjusted };
}

/**
 * The settlement a lifecycle event asks for.
 *
 * Routes to {@link settleJobHold} when there is a job to stamp, and to a plain
 * usage row when there is not — a sync holds and settles the same single unit,
 * so its adjustment is always zero and there is nothing to make idempotent.
 *
 * @returns Whether anything was written or claimed.
 */
export async function settleUsageEvent(
  event: {
    organizationId: string;
    metric: UsageMetricName;
    amount: number;
    reservedUnits: number;
    resourceId: string | null;
  },
  prisma: PrismaClient,
  isJob = event.metric === "AI_GENERATED_PAGES",
): Promise<boolean> {
  if (isJob && event.resourceId !== null) {
    return settleJobHold(
      event.resourceId,
      event.amount,
      event.reservedUnits,
      event.organizationId,
      event.metric,
      prisma,
    );
  }

  const written = await recordUsage(
    {
      organizationId: event.organizationId,
      metric: event.metric,
      amount: event.amount - Math.max(0, event.reservedUnits),
      resourceId: event.resourceId ?? null,
    },
    prisma,
  );

  return written !== null;
}
