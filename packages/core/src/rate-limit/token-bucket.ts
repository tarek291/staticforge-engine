/**
 * The token-bucket arithmetic, as a pure function.
 *
 * The authoritative *grant* happens in a single SQL statement, because a
 * decision made in JavaScript between a read and a write is not a decision two
 * processes can both make safely. This module is the same arithmetic written
 * once, in a form that can be tested exhaustively without a database — and it
 * is what computes the wait a denied caller is told to observe.
 *
 * ## Why a bucket rather than a fixed window
 *
 * A fixed window lets a caller spend its whole minute's allowance in the first
 * second and then sit idle, which is precisely the shape that trips a
 * provider's own limiter. A bucket smooths: capacity bounds the burst, the
 * refill rate bounds the average, and the two are tuned separately.
 *
 * ## Why the fractional remainder is carried in the timestamp
 *
 * Tokens are stored as an integer, so a refill of 0.4 tokens has nowhere to go.
 * Discarding it and advancing the clock to "now" would lose that fraction on
 * every call — a caller polling ten times a second at one token per second
 * would earn nothing, forever. So the clock is advanced by exactly the time the
 * *whole* tokens represent, and the remainder stays owed. The only case where
 * time is deliberately discarded is a bucket already at capacity, which is what
 * a bucket means.
 */

/** A bucket, as stored. */
export interface TokenBucketState {
  availableTokens: number;
  lastRefillAt: Date;
}

/** How a bucket behaves. */
export interface TokenBucketPolicy {
  /** The most tokens the bucket can hold — the burst ceiling. */
  maxCapacity: number;
  /** Tokens added per second — the sustained ceiling. */
  refillRatePerSec: number;
}

/** What one consumption attempt would do. */
export interface TokenConsumptionPlan {
  /** Whether the request may proceed now. */
  granted: boolean;
  /** Tokens the bucket holds after refill, before this request is deducted. */
  refilledTokens: number;
  /** Tokens the bucket would hold after this request. */
  remainingTokens: number;
  /** How long to wait before retrying. `0` when granted. */
  waitForMs: number;
  /** What `lastRefillAt` becomes. Unchanged from the input when denied. */
  nextRefillAt: Date;
  /**
   * Whether the request can never be granted by waiting.
   *
   * A request larger than the bucket's whole capacity is not slow, it is
   * impossible, and a caller that slept on it would sleep for ever. Separated
   * from an ordinary denial because the two need opposite handling: one is
   * retried, the other is a configuration error to surface.
   */
  unsatisfiable: boolean;
}

/** Milliseconds in a second, named so the arithmetic below reads as intent. */
const MS_PER_SECOND = 1000;

/**
 * Work out what a consumption attempt would do, without doing it.
 *
 * @param state - The bucket as stored.
 * @param policy - Capacity and refill rate.
 * @param requestedTokens - What this call wants to spend.
 * @param now - The clock. Injected so a test does not have to wait.
 */
export function planTokenConsumption(
  state: TokenBucketState,
  policy: TokenBucketPolicy,
  requestedTokens: number,
  now: Date,
): TokenConsumptionPlan {
  const { maxCapacity, refillRatePerSec } = policy;

  // A request bigger than the bucket can ever hold. Reported rather than
  // denied, because "wait and try again" is advice that never comes true here.
  if (requestedTokens > maxCapacity) {
    return {
      granted: false,
      refilledTokens: state.availableTokens,
      remainingTokens: state.availableTokens,
      waitForMs: 0,
      nextRefillAt: state.lastRefillAt,
      unsatisfiable: true,
    };
  }

  // Clamped at zero. A clock that has gone backwards — an NTP correction, or
  // two machines disagreeing — must not remove tokens a caller has already been
  // told it has.
  const elapsedSec = Math.max(
    0,
    (now.getTime() - state.lastRefillAt.getTime()) / MS_PER_SECOND,
  );

  // A rate of zero is a legitimate policy — a hard quota that never refills —
  // and it is also the value that turns every division below into NaN or
  // Infinity. Handled as what it means rather than guarded against as an edge
  // case: nothing accrues, so a shortfall can never be waited out.
  const refills = refillRatePerSec > 0;

  const earned = refills ? Math.floor(elapsedSec * refillRatePerSec) : 0;
  const refilled = Math.min(maxCapacity, state.availableTokens + earned);

  if (refilled >= requestedTokens) {
    return {
      granted: true,
      refilledTokens: refilled,
      remainingTokens: refilled - requestedTokens,
      waitForMs: 0,
      // Advanced by the time the whole tokens represent, not to `now` — see the
      // module comment. At capacity the remainder is meaningless, because the
      // bucket stopped accruing when it filled.
      nextRefillAt: !refills
        ? state.lastRefillAt
        : refilled >= maxCapacity
          ? now
          : new Date(
              state.lastRefillAt.getTime() +
                (earned / refillRatePerSec) * MS_PER_SECOND,
            ),
      unsatisfiable: false,
    };
  }

  // Denied. The bucket is left exactly as it was: the time spent waiting is
  // time it was still filling, and advancing the clock here would charge the
  // caller for its own wait.
  const shortfall = requestedTokens - refilled;

  return {
    granted: false,
    refilledTokens: refilled,
    remainingTokens: state.availableTokens,
    // Rounded up. Waking a millisecond early means being refused again, and a
    // retry loop that has to go round twice for every grant is a retry loop
    // that doubles the load it exists to reduce.
    waitForMs: refills
      ? Math.ceil((shortfall / refillRatePerSec) * MS_PER_SECOND)
      : 0,
    nextRefillAt: state.lastRefillAt,
    // A bucket that never refills and does not hold enough is not busy, it is
    // exhausted. Telling the caller to wait would be telling it to wait for
    // ever — the same lie an oversized request would be told.
    unsatisfiable: !refills,
  };
}

/** The answer a limiter gives a caller. */
export interface TokenGrant {
  /** Whether the call may proceed. */
  allowed: boolean;
  /** How long to wait before asking again. `0` when allowed. */
  waitForMs: number;
  /** Tokens left in the bucket. */
  remainingTokens: number;
  /** Whether waiting could never help. See {@link TokenConsumptionPlan}. */
  unsatisfiable: boolean;
}

/**
 * A bound rate limiter.
 *
 * A function rather than an interface with one method, and bound to its key and
 * policy at construction. The consumer — the AI service — must not be in a
 * position to choose which bucket it draws from or how big that bucket is: a
 * component that can widen its own limit is not limited.
 */
export type RateLimiter = (requestedTokens: number) => Promise<TokenGrant>;

/** A limiter that never refuses. What a caller with no limiter configured uses. */
export function unlimited(): RateLimiter {
  return (requestedTokens: number) =>
    Promise.resolve({
      allowed: true,
      waitForMs: 0,
      remainingTokens: Number.POSITIVE_INFINITY,
      unsatisfiable: false,
      requestedTokens,
    } as TokenGrant);
}
