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
   */
  maxPauseMs?: number;
  /** Injected so a test can observe *that* it waited, not spend the time. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Called before each pause. */
  onWait?: (notice: RateLimitWaitNotice) => void;
}

/** Default total wait for one call. Generous: a queue ahead of you is normal. */
export const DEFAULT_RATE_LIMIT_BUDGET_MS = 120_000;

/** Default ceiling for a single pause. */
export const DEFAULT_MAX_PAUSE_MS = 15_000;

/**
 * Hold until the bucket has room, then return.
 *
 * Loops rather than sleeping once and assuming: the wait a limiter reports is
 * an estimate made without knowing who else is queued, so another worker may
 * take the capacity in between. Asking again is the only way to be sure, and
 * the alternative — trusting the estimate — is what lets several workers wake
 * together and all spend at once.
 *
 * @param limiter - The bound limiter. Omit for no limiting at all.
 * @param requestedTokens - What the call will cost.
 * @param options - Budget, pause ceiling, clock and reporting.
 * @throws {RateLimitImpossibleError} If the request can never fit.
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

  const budgetMs = options.budgetMs ?? DEFAULT_RATE_LIMIT_BUDGET_MS;
  const maxPauseMs = options.maxPauseMs ?? DEFAULT_MAX_PAUSE_MS;
  const sleepFn = options.sleepFn ?? sleep;

  let waited = 0;
  let attempt = 0;

  for (;;) {
    attempt += 1;

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

    // A limiter reporting zero would spin this loop against the database as
    // fast as the event loop allows. One second is short enough to stay
    // responsive and long enough not to be a denial of service against our own
    // Postgres.
    const pause = Math.min(maxPauseMs, Math.max(1000, grant.waitForMs));

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
