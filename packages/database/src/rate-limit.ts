import type { PrismaClient } from "@prisma/client";
import {
  planTokenConsumption,
  type RateLimiter,
  type TokenGrant,
} from "@staticforge/core";

import { withDbRetry } from "./retry.js";

/**
 * A token bucket shared by every process that draws from it.
 *
 * ## Why the decision is a single statement
 *
 * The obvious implementation reads the row, works out whether there are enough
 * tokens, and writes the new count back. Between that read and that write is a
 * window, and with two workers running — which Phase 14 made the normal
 * deployment — both read the same balance, both decide there is room, and both
 * spend it. The bucket goes negative, the provider returns 429s in the middle
 * of a paid run, and nothing in the code looks wrong.
 *
 * So the grant is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, and the
 * arithmetic lives in the statement rather than around it. Postgres takes a row
 * lock on the conflict and re-evaluates the `SET` expressions *and* the `WHERE`
 * against the current tuple, so a second caller arriving mid-flight sees the
 * first one's deduction. The database decides, not the gap between two queries.
 *
 * ## Why a denial writes nothing
 *
 * A refused caller leaves the row untouched, including `lastRefillAt`. The time
 * it then spends waiting is time the bucket is still filling; advancing the
 * clock on a denial would charge a caller for its own wait and, under a busy
 * queue, could hold a bucket permanently empty.
 *
 * ## The duplication, stated plainly
 *
 * The refill formula exists twice: in the SQL below, which is authoritative and
 * atomic, and in `planTokenConsumption`, which computes how long a denied
 * caller should sleep. That is a real drift risk. It is accepted because the
 * alternative is worse in both directions — doing the grant in TypeScript
 * reintroduces the race this module exists to close, and computing the wait in
 * SQL would leave the arithmetic with no test that runs without a database. The
 * two are kept literally parallel, and the live verification exercises both.
 */

/** How a bucket behaves, and what to charge it. */
export interface ConsumeTokensOptions {
  /** The most tokens the bucket holds — the burst ceiling. */
  maxCapacity: number;
  /** Tokens added per second — the sustained ceiling. */
  refillRatePerSec: number;
}

/**
 * The refill expression, written once and interpolated into both statements.
 *
 * Kept as a string constant rather than repeated inline because it appears
 * three times in the grant statement — in the `SET`, in the timestamp branch,
 * and in the `WHERE` — and three copies of an expression is three places for a
 * clamp to go missing.
 */
const REFILLED = `LEAST(
  $3::int,
  "RateLimitState"."availableTokens"
    + FLOOR(GREATEST(0, EXTRACT(EPOCH FROM (NOW() - "RateLimitState"."lastRefillAt"))) * $4::float8)::int
)`;

/** Whole tokens earned since the last refill. */
const EARNED = `FLOOR(GREATEST(0, EXTRACT(EPOCH FROM (NOW() - "RateLimitState"."lastRefillAt"))) * $4::float8)`;

/**
 * The grant. One statement, and the only statement that writes.
 *
 * `lastRefillAt` advances by the time the *whole* earned tokens represent
 * rather than to `NOW()`, so the fractional remainder is carried instead of
 * discarded — otherwise a caller polling faster than one token's worth of time
 * earns nothing at all. At capacity the remainder is meaningless, because a
 * full bucket has stopped accruing.
 *
 * Parameters: $1 key, $2 requested, $3 capacity, $4 refill rate per second.
 */
const GRANT_SQL = `INSERT INTO "RateLimitState" ("id", "availableTokens", "lastRefillAt")
VALUES ($1, $3::int - $2::int, NOW())
ON CONFLICT ("id") DO UPDATE SET
  "availableTokens" = ${REFILLED} - $2::int,
  "lastRefillAt" = CASE
    WHEN ${REFILLED} >= $3::int THEN NOW()
    ELSE "RateLimitState"."lastRefillAt"
         -- COALESCE over NULLIF, so a refill rate of zero — a hard quota that
         -- never tops up — advances the clock by nothing instead of dividing by
         -- it. Postgres raises 22012 on integer division by zero, which would
         -- turn a legitimate policy into a failed run.
         + make_interval(secs => COALESCE(${EARNED} / NULLIF($4::float8, 0), 0))
  END
WHERE ${REFILLED} >= $2::int
RETURNING "availableTokens"`;

/**
 * Spend tokens from a shared bucket, or find out how long to wait.
 *
 * Creates the bucket full on first use, which is what a new tenant should get:
 * starting empty would make the very first page of a project wait for a refill
 * it never asked to be charged for.
 *
 * @param key - The bucket's identity. Two processes computing the same key must
 * produce the same string — that is the entire coordination mechanism.
 * @param requestedTokens - What this call wants to spend.
 * @param maxCapacity - Burst ceiling.
 * @param refillRatePerSec - Sustained ceiling.
 * @param prisma - The client to run against. Injected, as everywhere here.
 * @returns Whether the spend was allowed, and how long to wait if not.
 */
export async function consumeApiTokens(
  key: string,
  requestedTokens: number,
  maxCapacity: number,
  refillRatePerSec: number,
  prisma: PrismaClient,
): Promise<TokenGrant> {
  // Refused before the database is touched. A request larger than the bucket
  // can ever hold is a configuration error, not a busy moment, and a caller
  // told to "wait" for it would wait for ever.
  if (requestedTokens > maxCapacity) {
    return {
      allowed: false,
      waitForMs: 0,
      remainingTokens: 0,
      unsatisfiable: true,
    };
  }

  // Nothing to spend. Answered without a round trip rather than treated as a
  // degenerate grant, so a caller that computes a zero cost by accident does
  // not silently bypass the limiter *and* pay for a query to do it.
  if (requestedTokens <= 0) {
    return { allowed: true, waitForMs: 0, remainingTokens: maxCapacity, unsatisfiable: false };
  }

  const granted = await withDbRetry(() =>
    // `$queryRawUnsafe` rather than the tagged template, because the statement
    // is assembled from the constants above rather than written inline — and a
    // `Prisma.sql` built from an already-joined string carries no placeholders
    // to bind, so the values would silently never arrive.
    //
    // "Unsafe" names the risk rather than describing this call. Nothing a
    // caller supplies is interpolated: the four values travel as $1-$4 and are
    // bound by the driver, and everything spliced into the text is a constant
    // in this file. A bucket key *is* caller-chosen, which is exactly why it is
    // a parameter.
    prisma.$queryRawUnsafe<Array<{ availableTokens: number }>>(
      GRANT_SQL,
      key,
      requestedTokens,
      maxCapacity,
      refillRatePerSec,
    ),
  );

  const row = granted[0];

  if (row !== undefined) {
    return {
      allowed: true,
      waitForMs: 0,
      remainingTokens: Number(row.availableTokens),
      unsatisfiable: false,
    };
  }

  // Denied: the `WHERE` did not hold, so nothing was written. Read the state
  // back to say how long to wait.
  //
  // A second query, and deliberately not part of the first. It reads a bucket
  // that may have moved since the refusal, which makes the wait an estimate —
  // and an estimate is all it can ever be, because the queue ahead of this
  // caller is not knowable. Being slightly wrong costs one extra loop; making
  // the grant itself racy to avoid that would cost the guarantee.
  const state = await withDbRetry(() =>
    prisma.rateLimitState.findUnique({
      where: { id: key },
      select: { availableTokens: true, lastRefillAt: true },
    }),
  );

  if (state === null || state === undefined) {
    // The row vanished between the two statements — a truncate, or a cleanup
    // job. The next attempt recreates it full, so waiting is pointless.
    return { allowed: false, waitForMs: 0, remainingTokens: 0, unsatisfiable: false };
  }

  const plan = planTokenConsumption(
    { availableTokens: state.availableTokens, lastRefillAt: state.lastRefillAt },
    { maxCapacity, refillRatePerSec },
    requestedTokens,
    new Date(),
  );

  return {
    allowed: false,
    waitForMs: plan.waitForMs,
    remainingTokens: plan.refilledTokens,
    unsatisfiable: plan.unsatisfiable,
  };
}

/** How a project's bucket is configured. */
export interface ProjectRateLimitOptions extends ConsumeTokensOptions {
  /**
   * Namespace prefix, so two limits on the same project — a token budget and a
   * request budget, say — do not share one bucket.
   */
  scope?: string;
}

/**
 * The bucket key for a project.
 *
 * Exported so a test, an operator and the limiter itself all compute it the
 * same way. A key derived in two places is two buckets the moment one of them
 * changes.
 */
export function projectBucketKey(projectId: string, scope = "anthropic"): string {
  return `${scope}:${projectId}`;
}

/**
 * Build a limiter bound to one project.
 *
 * The consumer is handed a function that takes a token count and nothing else.
 * It cannot choose its bucket or widen its capacity — a component able to raise
 * its own limit is not limited — and it needs no database client of its own,
 * which is what keeps `@staticforge/ai` free of Prisma.
 */
export function createProjectRateLimiter(
  projectId: string,
  options: ProjectRateLimitOptions,
  prisma: PrismaClient,
): RateLimiter {
  const key = projectBucketKey(projectId, options.scope);

  return (requestedTokens: number) =>
    consumeApiTokens(
      key,
      requestedTokens,
      options.maxCapacity,
      options.refillRatePerSec,
      prisma,
    );
}
