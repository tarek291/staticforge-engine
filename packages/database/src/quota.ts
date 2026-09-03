import type { PrismaClient, UsageMetric } from "@prisma/client";

import { requirePlatformOperator } from "./platform.js";
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
 * Refuse a quota row that cannot honestly be counted against.
 *
 * Both gates share it so the two cannot drift — and a misconfiguration that
 * one refused and the other allowed would be worse than either behaviour on
 * its own, because which one you hit would depend on the code path.
 *
 * @returns A refusal verdict, or `null` when the row is usable.
 */
function refuseUnusableQuota(
  quota: { limit: number; resetDate: Date },
  metric: UsageMetricName,
  requestedAmount: number,
): QuotaVerdict | null {
  if (quota.resetDate > new Date()) {
    // A reset date in the future means "nothing counts yet", which is a quota
    // that silently permits everything — the failure mode a quota exists to
    // prevent. Refused rather than allowed, so a typo surfaces as a blocked
    // operation with an explanation instead of as an unlimited account.
    return {
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

  return null;
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

  const refusal = refuseUnusableQuota(quota, metric, requestedAmount);

  if (refusal !== null) {
    return refusal;
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
 * Refuse unless the organization has room. **Reads only — not a gate.**
 *
 * Kept for callers that want to *report* a limit: a dashboard showing how much
 * is left, a dry run explaining what a sync would cost. Those want an answer,
 * not a hold.
 *
 * Do not admit work on this. It reads a total that concurrent callers are all
 * reading at the same moment and all passing, which is the race Phase 31 found
 * — use {@link requireQuotaReservation}, which holds what it admits.
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
 *
 * ## Why this is not guarded by a tenant role
 *
 * Every tenant capability is held by OWNER, and OWNER is the person the quota
 * bills. Gating this with `member:manage` would let a customer raise their own
 * spending cap — worse than leaving it open, because it would look like a
 * control while being none. A plan's ceiling is sold, not self-served, so it is
 * guarded by a question no tenant role can answer: is this the platform?
 *
 * @param actingUserId - Who is setting it. Must be the platform operator.
 * @throws {UnauthorizedError} For any tenant principal or API key.
 */
export async function setQuota(
  setting: QuotaSetting,
  actingUserId: string,
  prisma: PrismaClient,
): Promise<QuotaVerdict> {
  requirePlatformOperator(actingUserId);

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

// ---------------------------------------------------------------------------
// The atomic gate
// ---------------------------------------------------------------------------

/**
 * A quota client that may be the base client or a transaction handle.
 *
 * The gate has to be able to run *inside* a caller's transaction — that is the
 * whole point of it — so it takes the narrow surface it actually uses rather
 * than a `PrismaClient`, and an interactive transaction handle satisfies it.
 */
export type QuotaExecutor = Pick<PrismaClient, "$queryRawUnsafe" | "usageRecord">;

/**
 * A hold placed on an organization's quota.
 *
 * `reserved` is what was actually taken, and it is not always `requested`: a
 * tenant with no quota configured has nothing to hold, and a refused operation
 * holds nothing either. Callers must refund exactly this number and never the
 * number they asked for.
 */
export interface QuotaReservation {
  /** The verdict, in the same shape `checkQuota` returns. */
  verdict: QuotaVerdict;
  /** Units held. Zero when nothing was written — unlimited, or refused. */
  reserved: number;
}

/**
 * The quota row, locked.
 *
 * `FOR UPDATE` is the entire mechanism. Concurrent callers for the same
 * organization and metric queue behind this row, and the sum that follows is a
 * separate statement — so under READ COMMITTED it takes a *fresh* snapshot once
 * the lock is granted, and therefore sees the reservation the caller ahead of
 * it just committed.
 *
 * Both halves are load-bearing. The lock without the second snapshot would
 * serialise two callers who then read the same stale total and both pass, which
 * is exactly the bug this replaces — and is why folding the sum into this
 * statement as a CTE would look tidier and fix nothing.
 *
 * `NOWAIT` is deliberately absent. A caller arriving during another's check
 * should wait its turn — milliseconds — rather than be refused for a quota it
 * may well have room in.
 */
const LOCK_QUOTA_SQL = `
  SELECT "limit", "resetDate"
  FROM "OrganizationQuota"
  WHERE "organizationId" = $1 AND "metric" = $2::"UsageMetric"
  FOR UPDATE
`;

/** Consumption since an instant, read *after* the lock. See {@link LOCK_QUOTA_SQL}. */
const SUM_USAGE_SQL = `
  SELECT COALESCE(SUM("amount"), 0)::bigint AS used
  FROM "UsageRecord"
  WHERE "organizationId" = $1 AND "metric" = $2::"UsageMetric" AND "recordedAt" >= $3
`;

/**
 * Check an organization's ceiling and hold the units, atomically.
 *
 * ## Why a check alone was not enough
 *
 * Usage is metered *retrospectively* — a row appears once work has finished. So
 * a gate that only reads is a gate every concurrent caller passes: ten requests
 * arriving together all sum the same zero, all find room, and all proceed.
 *
 * A lock does not fix that by itself, and this is the part worth being precise
 * about: ten *serialised* callers still read a total that nothing has written
 * to yet, and still all pass. Serialising the checks changes the order they
 * happen in and not their answer. The admission itself has to become visible,
 * which means writing at admission time.
 *
 * So this holds the units it admits. The hold is an ordinary `UsageRecord`, and
 * the next caller's sum includes it precisely because the lock forces that sum
 * to happen after this transaction commits.
 *
 * ## The hold is not the charge
 *
 * It is an estimate taken on credit, and it must be settled. When the work
 * finishes, the meter writes the *difference* between what actually happened
 * and what was held — a negative row when the run authored less than expected,
 * and the whole amount back when it failed or was never run. That is why
 * {@link QuotaReservation.reserved} is returned rather than assumed: refunding
 * the requested amount when a different amount was held would credit a tenant
 * for quota they never consumed.
 *
 * A hold that is never settled stays charged, and that direction is chosen. An
 * unsettled hold counts against a tenant's own ceiling, where they see it and
 * complain; the opposite failure lets a limit be exceeded silently and surfaces
 * as an invoice nobody can defend.
 *
 * @param organizationId - The tenant.
 * @param metric - What is being consumed.
 * @param requestedAmount - Units to hold. Non-positive holds nothing.
 * @param prisma - The client, or a transaction handle to join an existing one.
 * @param resourceId - What the hold is for, carried onto the row.
 */
export async function reserveQuota(
  organizationId: string,
  metric: UsageMetricName,
  requestedAmount: number,
  prisma: QuotaExecutor,
  resourceId?: string | null,
): Promise<QuotaReservation> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{ limit: number; resetDate: Date }>
  >(LOCK_QUOTA_SQL, organizationId, metric);

  const quota = rows[0];

  if (quota === undefined) {
    // No quota configured. The one deliberate fail-open in this module, carried
    // over from `checkQuota`: quotas are opt-in, and a default of zero would
    // have stopped every existing tenant the moment the table shipped.
    //
    // Nothing is held, so nothing must be refunded. There is also nothing to
    // serialise on — `FOR UPDATE` locked no row — which is right, because an
    // absent ceiling cannot be raced past.
    return {
      reserved: 0,
      verdict: {
        allowed: true,
        metric,
        used: 0,
        limit: null,
        requested: requestedAmount,
        remaining: null,
        resetDate: null,
      },
    };
  }

  const refusal = refuseUnusableQuota(quota, metric, requestedAmount);

  if (refusal !== null) {
    return { reserved: 0, verdict: refusal };
  }

  const [sum] = await prisma.$queryRawUnsafe<Array<{ used: bigint | number }>>(
    SUM_USAGE_SQL,
    organizationId,
    metric,
    quota.resetDate,
  );

  // A Postgres `SUM` arrives as a bigint through this driver and as a number
  // through some others. Coerced once, here, because `bigint + number` is a
  // TypeError rather than a wrong answer — and a gate that throws on a healthy
  // database refuses every tenant.
  const used = Number(sum?.used ?? 0);
  const wanted = Math.max(0, requestedAmount);
  const allowed = used + wanted <= quota.limit;

  const verdict: QuotaVerdict = {
    allowed,
    metric,
    used,
    limit: quota.limit,
    requested: requestedAmount,
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

  if (!allowed || wanted === 0) {
    // A refused operation writes nothing. A gate that metered its own refusals
    // would charge a tenant for being told no — and charge again on every retry.
    return { reserved: 0, verdict };
  }

  // Through the query builder rather than raw SQL, unlike the two reads above.
  // Only the lock needs raw SQL — `FOR UPDATE` has no expression in Prisma's
  // API — and an insert written by hand would also have to mint the id the
  // schema default supplies. It is inside the same transaction either way, so
  // it is inside the same lock.
  await prisma.usageRecord.create({
    data: {
      organizationId,
      metric,
      amount: wanted,
      resourceId: resourceId ?? null,
    },
    select: { id: true },
  });

  return { reserved: wanted, verdict };
}

/**
 * Hold quota or refuse, throwing.
 *
 * The form every gate should take, for the reason `requireRole` throws: a
 * verdict a caller can ignore is a verdict a caller eventually ignores.
 *
 * @throws {QuotaExceededError} When the operation would exceed the limit.
 */
export async function requireQuotaReservation(
  organizationId: string,
  metric: UsageMetricName,
  requestedAmount: number,
  prisma: QuotaExecutor,
  resourceId?: string | null,
): Promise<QuotaReservation> {
  const reservation = await reserveQuota(
    organizationId,
    metric,
    requestedAmount,
    prisma,
    resourceId,
  );

  if (!reservation.verdict.allowed) {
    throw new QuotaExceededError(organizationId, reservation.verdict);
  }

  return reservation;
}

/**
 * Settle a hold against what actually happened.
 *
 * Writes the difference, never a replacement: `actual - held`. A run that
 * authored fewer pages than were held writes a negative row, which is how this
 * table has always expressed a correction — the ledger is append-only, so a
 * charge stays readable next to its adjustment instead of being overwritten by
 * it.
 *
 * A difference of zero writes nothing, which is the ordinary case for a metric
 * whose estimate is exact. `SYNC_OPERATIONS` is always exactly one unit, so it
 * holds one, settles one, and leaves a single row — the same ledger the
 * retrospective meter produced before this gate existed.
 *
 * @param entry - The usage as it really was. `amount` is the true figure.
 * @param reservedAmount - What {@link reserveQuota} reported holding.
 * @returns The id of the adjustment row, or `null` when the hold was already right.
 */
export async function settleQuotaReservation(
  entry: UsageEntry,
  reservedAmount: number,
  prisma: PrismaClient,
): Promise<string | null> {
  return recordUsage(
    { ...entry, amount: entry.amount - Math.max(0, reservedAmount) },
    prisma,
  );
}
