import { sleep, type RateLimiter } from "@staticforge/core";

/**
 * Waiting for capacity before spending money.
 *
 * The retry policy in `retry.ts` reacts to a provider that has already refused
 * — a 429 that has been sent, received, and paid for in latency. This is the
 * other side: not asking in the first place when the tenant's own budget says
 * there is no room.
 *
 * The distinction matters because the two limits are different things. A 429 is
 * the provider protecting itself from everyone; this bucket is the engine
 * protecting one tenant's allowance from its own workers, of which there may be
 * several and none of which can see the others' in-flight calls.
 */

/** Raised when a caller waited as long as it was allowed to and never got in. */
export class RateLimitTimeoutError extends Error {
  override readonly name = "RateLimitTimeoutError";

  /** Total time spent waiting before giving up. */
  readonly waitedMs: number;

  /** Tokens the call was asking for. */
  readonly requestedTokens: number;

  constructor(requestedTokens: number, waitedMs: number, budgetMs: number) {
    super(
      `Rate limited: waited ${Math.round(waitedMs / 1000)}s for ${requestedTokens} ` +
        `token(s) without capacity becoming available (budget ${Math.round(budgetMs / 1000)}s).`,
    );
    this.requestedTokens = requestedTokens;
    this.waitedMs = waitedMs;
  }
}

/** Raised when a request could never fit, however long anyone waits. */
export class RateLimitImpossibleError extends Error {
  override readonly name = "RateLimitImpossibleError";

  readonly requestedTokens: number;

  constructor(requestedTokens: number) {
    super(
      `Rate limit misconfigured: a single call needs ${requestedTokens} token(s), ` +
        `which is more than the bucket can ever hold. Raise the capacity or lower ` +
        `the per-call cost — waiting will not help.`,
    );
    this.requestedTokens = requestedTokens;
  }
}

/**
 * Raised when the limiter answers with something that is not a duration.
 *
 * Its own class rather than a reused one, because it is a different problem
 * from the two above and points somewhere else entirely. `RateLimitTimeoutError`
 * says the bucket stayed full; `RateLimitImpossibleError` says the request was
 * too big. This one says the limiter itself is broken — and an operator sent to
 * look at their capacity settings by either of the other two would be looking
 * in the wrong place.
 */
export class RateLimitContractError extends Error {
  override readonly name = "RateLimitContractError";

  /** What the limiter actually returned. */
  readonly reported: unknown;

  readonly requestedTokens: number;

  constructor(requestedTokens: number, reported: unknown) {
    super(
      `Rate limiter returned ${String(reported)} for waitForMs, which is not a ` +
        `duration. The limiter is misbehaving — this is not a busy bucket, and ` +
        `waiting will not fix it.`,
    );
    this.requestedTokens = requestedTokens;
    this.reported = reported;
  }
}

/** Reported each time a caller is held back, so a long run explains itself. */
export interface RateLimitWaitNotice {
  requestedTokens: number;
  waitForMs: number;
  /** Total waited on this call so far, including this pause. */
  totalWaitedMs: number;
  attempt: number;
}

/** Options for {@link awaitTokens}. */
export interface AwaitTokensOptions {
  /**
   * Longest to wait in total for one call.
   *
   * A ceiling, not a target. Without one a misconfigured bucket turns a run
   * into a process that is alive, holding a job lease, and never finishing —
   * the worst of the three possible outcomes, because it looks like progress.
   */
  budgetMs?: number;
  /**
   * Longest for a single pause.
   *
   * Caps a pathological wait computed from a very slow refill rate, and keeps
   * the loop coming back often enough that a lease renewal is never starved by
   * one enormous sleep.
   *
   * Raised to {@link MIN_PAUSE_MS} if it is set below it. A ceiling under the
   * floor is not a shorter wait, it is no wait — and the resulting loop is a
   * denial of service against this engine's own database.
   */
  maxPauseMs?: number;
  /** Injected so a test can observe *that* it waited, not spend the time. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Called before each pause. */
  onWait?: (notice: RateLimitWaitNotice) => void;
}

/**
 * A value usable as a duration, or `undefined`.
 *
 * `Number.isFinite` rather than an `isNaN` check, because it rejects `Infinity`
 * too — and an infinite wait is not a long wait, it is the `unsatisfiable` case
 * wearing a number.
 */
function asDurationMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Default total wait for one call. Generous: a queue ahead of you is normal. */
export const DEFAULT_RATE_LIMIT_BUDGET_MS = 120_000;

/** Default ceiling for a single pause. */
export const DEFAULT_MAX_PAUSE_MS = 15_000;

/**
 * The shortest this loop will ever pause.
 *
 * A limiter reporting zero would otherwise spin against the database as fast as
 * the event loop allows. It is also what makes the iteration cap below exact:
 * every pass adds at least this much to the running total, so the number of
 * passes a legitimate run can make is arithmetic rather than a guess.
 */
export const MIN_PAUSE_MS = 1000;

/**
 * Hold until the bucket has room, then return.
 *
 * Loops rather than sleeping once and assuming: the wait a limiter reports is
 * an estimate made without knowing who else is queued, so another worker may
 * take the capacity in between. Asking again is the only way to be sure, and
 * the alternative — trusting the estimate — is what lets several workers wake
 * together and all spend at once.
 *
 * ## Why every duration here is validated
 *
 * A non-finite number poisons this loop in two separate ways, and the second is
 * the one that turns a bug into an outage.
 *
 * `Math.max(1000, NaN)` is `NaN`, so the pause becomes `NaN`, and
 * `setTimeout(fn, NaN)` fires immediately — the loop stops waiting and hammers
 * the limiter's database as fast as the event loop allows.
 *
 * Worse: `waited += NaN` makes `waited` `NaN` permanently, and `NaN > budgetMs`
 * is `false`. So the budget check — the one guard standing between this and a
 * process that is alive, holding a job lease, and never finishing — is silently
 * disabled for the rest of the call, including for every later grant that comes
 * back perfectly valid. One bad answer disables the timeout for good.
 *
 * The two sources are handled differently on purpose. A bad *option* is
 * replaced with the documented default, because a caller who passed
 * `millis(undefined)` gave no usable budget and the standard one is a truthful
 * substitute. A bad *grant* throws, because there is no honest substitute for
 * "how long until there is capacity" — inventing one would mean sleeping the
 * whole budget to reach a conclusion the first answer already implied, which is
 * exactly the reasoning the `unsatisfiable` branch below is built on.
 *
 * @param limiter - The bound limiter. Omit for no limiting at all.
 * @param requestedTokens - What the call will cost.
 * @param options - Budget, pause ceiling, clock and reporting. A budget or
 * pause ceiling that is not a finite, non-negative number falls back to the
 * default rather than being honoured.
 * @throws {RateLimitImpossibleError} If the request can never fit.
 * @throws {RateLimitContractError} If the limiter reports a wait that is not a
 * duration.
 * @throws {RateLimitTimeoutError} If the budget is exhausted first.
 */
export async function awaitTokens(
  limiter: RateLimiter | undefined,
  requestedTokens: number,
  options: AwaitTokensOptions = {},
): Promise<void> {
  if (limiter === undefined) {
    return;
  }

  // Validated, not just defaulted. `??` only catches `null` and `undefined`, so
  // a caller parsing `--budget-ms` out of an absent flag hands this a `NaN`
  // that flows straight through — and `waited + pause > NaN` is `false`, which
  // disables the timeout as completely as a poisoned `waited` does.
  const budgetMs = asDurationMs(options.budgetMs) ?? DEFAULT_RATE_LIMIT_BUDGET_MS;

  // Raised to the floor, not just validated. `Math.min(maxPauseMs, …)` applies
  // the ceiling *after* the floor, so a ceiling below the floor wins — and a
  // caller passing `maxPauseMs: 0`, or anything under a second, turns the pause
  // into zero. `setTimeout(fn, 0)` returns immediately, `waited` stops growing,
  // and the loop hammers the limiter's database as fast as the event loop
  // allows: the same spin the `NaN` guard closed, arriving through a value that
  // is a perfectly good duration.
  //
  // The iteration cap below bounds it — that is what the cap is for — but
  // bounding a hammer loop is not the same as not having one. It would still
  // fire a hundred-odd queries and then report a timeout that never happened.
  const maxPauseMs = Math.max(
    MIN_PAUSE_MS,
    asDurationMs(options.maxPauseMs) ?? DEFAULT_MAX_PAUSE_MS,
  );
  const sleepFn = options.sleepFn ?? sleep;

  // A structural backstop, and the reason it exists is worth stating.
  //
  // The budget check is *arithmetic*, and arithmetic is precisely what a
  // non-finite number breaks — that is how this loop became unbounded in the
  // first place. A guard against bad numbers that is itself made of numbers
  // protects nothing that a future bug of the same shape cannot switch off
  // again.
  //
  // So the loop is also bounded by counting, which no arithmetic can poison:
  // `attempt` is an integer incremented by one and compared to an integer.
  // Every pass adds at least `MIN_PAUSE_MS` to `waited`, so this is the largest
  // number of passes a healthy run can make — it cannot refuse a legitimate
  // long budget, and it cannot be disabled.
  const maxAttempts = Math.ceil(budgetMs / MIN_PAUSE_MS) + 1;

  let waited = 0;
  let attempt = 0;

  for (;;) {
    attempt += 1;

    if (attempt > maxAttempts) {
      // Unreachable while the arithmetic works: the budget check below fires
      // first, every time. Reaching it means something upstream produced a
      // value that broke that check, and the useful response is to stop rather
      // than to keep going and find out what else it broke.
      throw new RateLimitTimeoutError(requestedTokens, waited, budgetMs);
    }

    const grant = await limiter(requestedTokens);

    if (grant.allowed) {
      return;
    }

    if (grant.unsatisfiable) {
      // Not a busy moment. Failing immediately is the only useful response —
      // this call will not fit at any point in the future, and a run that slept
      // on it would burn its whole budget to reach the same conclusion.
      throw new RateLimitImpossibleError(requestedTokens);
    }

    const reportedWaitMs = asDurationMs(grant.waitForMs);

    if (reportedWaitMs === undefined) {
      // Not a busy moment — a broken limiter. Thrown rather than defaulted for
      // the same reason `unsatisfiable` is: the next call will answer the same
      // way, so sleeping on it burns the whole budget to reach the identical
      // conclusion. And it would reach it wearing the wrong name: a
      // `RateLimitTimeoutError` says "the bucket stayed full for two minutes",
      // which would send an operator to look at their capacity settings for a
      // fault that is nowhere near them.
      throw new RateLimitContractError(requestedTokens, grant.waitForMs);
    }

    // Floored, because a limiter reporting zero would spin this loop against
    // the database as fast as the event loop allows. One second is short enough
    // to stay responsive and long enough not to be a denial of service against
    // our own Postgres.
    const pause = Math.min(maxPauseMs, Math.max(MIN_PAUSE_MS, reportedWaitMs));

    if (waited + pause > budgetMs) {
      throw new RateLimitTimeoutError(requestedTokens, waited, budgetMs);
    }

    waited += pause;
    options.onWait?.({
      requestedTokens,
      waitForMs: pause,
      totalWaitedMs: waited,
      attempt,
    });

    await sleepFn(pause);
  }
}
