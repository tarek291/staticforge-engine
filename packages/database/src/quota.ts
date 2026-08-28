import type { PrismaClient, UsageMetric } from "@prisma/client";

import { withDbRetry } from "./retry.js";

/**
 * Metering, and the quota gate in front of it.
 *
 * ## The asymmetry this phase turns on
 *
 * Usage is recorded **after** an operation finishes, by a lifecycle listener
 * the bus is free to abandon. Quotas are checked **before** one starts, by a
 * gate that throws. Those are opposite guarantees on purpose.
 *
 * Metering after the fact is the only way to count what actually happened: a
 * run's real page count is not knowable when it is queued, and charging for
 * work that was never done is worse than charging late. Checking before is the
 * only way a limit protects anything: a quota discovered at the end is an
 * invoice, not a ceiling.
 *
 * ## What that costs, stated plainly
 *
 * The number this gate reads is a lower bound. Work already queued has not been
 * metered yet, and a meter write lost to an unreachable database is never
 * metered at all — so a tenant can exceed its limit, by roughly the volume of
 * work in flight when it crossed the line.
 *
 * The gate is also not atomic. Two callers arriving together both read the same
 * total and both pass, exactly as a read-then-write token bucket would. That is
 * accepted here and was not accepted in Phase 24, and the difference is what is
 * being protected: the rate limiter guards someone else's hard ceiling, where
 * overshooting produces 429s in the middle of a paid run, so it is a single
 * atomic statement. A quota guards a commercial agreement, where overshooting
 * produces a conversation. Paying for atomicity twice would be paying for the
 * wrong thing.
 */

/** The metrics this engine counts. Mirrors the Prisma enum. */
export type UsageMetricName = "AI_GENERATED_PAGES" | "SYNC_OPERATIONS";

/**
 * Compile-time proof that the union above and the Prisma enum are the same set.
 *
 * A metric added to the schema and not here would be silently unmeterable —
 * every quota lookup for it would miss, which fails *open*. Found by a build
 * rather than by an unbilled customer.
 */
export type UsageMetricParity = [UsageMetricName] extends [UsageMetric]
  ? [UsageMetric] extends [UsageMetricName]
    ? true
    : never
  : never;

/** See {@link UsageMetricParity}. */
export const USAGE_METRICS_IN_SYNC: UsageMetricParity = true;

/** What the gate decided, and the numbers behind it. */
export interface QuotaVerdict {
  /** Whether the operation may proceed. */
  allowed: boolean;
  /** The metric that was checked. */
  metric: UsageMetricName;
  /** Units already consumed this period. */
  used: number;
  /** The ceiling, or `null` when no quota is configured. */
  limit: number | null;
  /** Units the caller asked to consume. */
  requested: number;
  /** What would be left afterwards. `null` when unlimited. */
  remaining: number | null;
  /** The instant the counter was last zeroed, when a quota exists. */
  resetDate: string | null;
  /** One line for an operator, when the answer is no. */
  reason?: string;
}

/** Raised when an operation would exceed an organization's quota. */
export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";

  readonly organizationId: string;
  readonly verdict: QuotaVerdict;

  constructor(organizationId: string, verdict: QuotaVerdict) {
    super(
      verdict.reason ??
        `Quota exceeded for ${verdict.metric}: ${verdict.used} of ` +
          `${verdict.limit ?? "unlimited"} used, ${verdict.requested} requested.`,
    );
    this.organizationId = organizationId;
    this.verdict = verdict;
  }
}

/**
 * How much of a metric an organization has consumed since an instant.
 *
 * A `SUM` rather than a running total on a row. A running total is one number
 * two writers race to update; a sum over an append-only table is a number
 * nobody has to lock, and it can be recomputed from the records if it is ever
 * doubted — which is what makes it defensible on an invoice.
 *
 * @returns Units consumed. Zero when nothing was recorded, and never `null`:
 * an empty `SUM` is `NULL` in SQL and a caller comparing `null > limit` would
 * silently allow everything.
 */
export async function sumUsage(
  organizationId: string,
  metric: UsageMetricName,
  since: Date,
  prisma: PrismaClient,
): Promise<number> {
  const total = await withDbRetry(() =>
    prisma.usageRecord.aggregate({
      where: { organizationId, metric, recordedAt: { gte: since } },
      _sum: { amount: true },
    }),
  );

  return total._sum.amount ?? 0;
}

/**
 * Decide whether an organization may consume more of a metric.
 *
 * Read-only. It records nothing — a gate that metered its own checks would
 * charge a tenant for being refused.
 *
 * @param organizationId - The tenant.
 * @param metric - What is being consumed.
 * @param requestedAmount - How much this operation would consume.
 * @param prisma - The client to read with.
 */
export async function checkQuota(
  organizationId: string,
  metric: UsageMetricName,
  requestedAmount: number,
  prisma: PrismaClient,
): Promise<QuotaVerdict> {
  const quota = await withDbRetry(() =>
    prisma.organizationQuota.findUnique({
      where: { organizationId_metric: { organizationId, metric } },
      select: { limit: true, resetDate: true },
    }),
  );

  if (quota === null || quota === undefined) {
    // The one deliberate fail-open in this module. Quotas are opt-in, and a
    // default of zero would have stopped every existing tenant the moment this
    // table shipped. A limit that must be configured before it applies is a
    // limit somebody chose.
    return {
      allowed: true,
      metric,
      used: 0,
      limit: null,
      requested: requestedAmount,
      remaining: null,
      resetDate: null,
    };
  }

  const now = new Date();

  if (quota.resetDate > now) {
    // A reset date in the future means "nothing counts yet", which is a quota
    // that silently permits everything — the failure mode a quota exists to
    // prevent. Refused rather than allowed, so a typo surfaces as a blocked
    // operation with an explanation instead of as an unlimited account.
    const verdict: QuotaVerdict = {
      allowed: false,
      metric,
      used: 0,
      limit: quota.limit,
      requested: requestedAmount,
      remaining: null,
      resetDate: quota.resetDate.toISOString(),
      reason:
        `The ${metric} quota for this organization has a reset date in the ` +
        `future (${quota.resetDate.toISOString()}), so no usage can be counted ` +
        `against it. Fix the quota rather than waiting: this will not clear ` +
        `on its own.`,
    };

    return verdict;
  }

  if (quota.limit < 0) {
    return {
      allowed: false,
      metric,
      used: 0,
      limit: quota.limit,
      requested: requestedAmount,
      remaining: null,
      resetDate: quota.resetDate.toISOString(),
      reason: `The ${metric} quota is negative (${quota.limit}), which is not a limit anyone meant to set.`,
    };
  }

  const used = await sumUsage(organizationId, metric, quota.resetDate, prisma);
  const wouldBe = used + Math.max(0, requestedAmount);
  const allowed = wouldBe <= quota.limit;

  return {
    allowed,
    metric,
    used,
    limit: quota.limit,
    requested: requestedAmount,
    // Clamped at zero: a negative "remaining" is a number nobody can act on,
    // and an overshoot is already visible in `used` against `limit`.
    remaining: Math.max(0, quota.limit - used),
    resetDate: quota.resetDate.toISOString(),
    ...(allowed
      ? {}
      : {
          reason:
            `${metric} quota exceeded: ${used} of ${quota.limit} used since ` +
            `${quota.resetDate.toISOString()}, and this operation needs ` +
            `${requestedAmount} more.`,
        }),
  };
}

/**
 * Refuse unless the organization has room.
 *
 * The form every gate should use. `checkQuota` returns a verdict a caller can
 * ignore; this one cannot be ignored by accident, which is the same reason
 * `requireRole` throws rather than returning a boolean.
 *
 * @throws {QuotaExceededError} When the operation would exceed the limit.
 */
export async function requireQuota(
  organizationId: string,
  metric: UsageMetricName,
  requestedAmount: number,
  prisma: PrismaClient,
): Promise<QuotaVerdict> {
  const verdict = await checkQuota(organizationId, metric, requestedAmount, prisma);

  if (!verdict.allowed) {
    throw new QuotaExceededError(organizationId, verdict);
  }

  return verdict;
}

/** One thing to meter. */
export interface UsageEntry {
  organizationId: string;
  metric: UsageMetricName;
  amount: number;
  /** What it happened to — a job id, a project id. */
  resourceId?: string | null;
}

/**
 * Record consumption.
 *
 * An insert, never an update. A usage table somebody can edit is a usage table
 * a customer is right to distrust, and two writers updating one running total
 * is precisely the race that made the rate limiter need raw SQL.
 *
 * Zero-amount entries are dropped rather than stored: a row that changes no
 * total is noise in the one table that has to stay readable by a human
 * reconciling an invoice.
 *
 * @returns The id of the row written, or `null` when there was nothing to record.
 */
export async function recordUsage(
  entry: UsageEntry,
  prisma: PrismaClient,
): Promise<string | null> {
  if (entry.amount === 0) {
    return null;
  }

  const row = await withDbRetry(() =>
    prisma.usageRecord.create({
      data: {
        organizationId: entry.organizationId,
        metric: entry.metric,
        amount: entry.amount,
        resourceId: entry.resourceId ?? null,
      },
      select: { id: true },
    }),
  );

  return row.id;
}

/** A quota as an operator sets it. */
export interface QuotaSetting {
  organizationId: string;
  metric: UsageMetricName;
  limit: number;
  /** When the counter is considered zeroed. Defaults to now. */
  resetDate?: Date;
}

/**
 * Set or replace an organization's ceiling for one metric.
 *
 * Upserted on the pair, because two rows for one metric would make the answer
 * depend on which was read first — and the generous one would win.
 */
export async function setQuota(
  setting: QuotaSetting,
  prisma: PrismaClient,
): Promise<QuotaVerdict> {
  const resetDate = setting.resetDate ?? new Date();

  await withDbRetry(() =>
    prisma.organizationQuota.upsert({
      where: {
        organizationId_metric: {
          organizationId: setting.organizationId,
          metric: setting.metric,
        },
      },
      create: {
        organizationId: setting.organizationId,
        metric: setting.metric,
        limit: setting.limit,
        resetDate,
      },
      update: { limit: setting.limit, resetDate },
    }),
  );

  return checkQuota(setting.organizationId, setting.metric, 0, prisma);
}
