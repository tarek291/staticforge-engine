import { describe, expect, test, vi } from "vitest";
import type { RateLimiter, TokenGrant } from "@staticforge/core";

import {
  DEFAULT_MAX_PAUSE_MS,
  RateLimitImpossibleError,
  RateLimitTimeoutError,
  awaitTokens,
} from "./rate-limit.js";

/**
 * Waiting for the tenant's own budget before spending money.
 *
 * The tests here assert that the engine *actually stops*. A limiter that
 * reports a wait and a caller that proceeds anyway is worse than no limiter:
 * the bucket is debited, the provider is hit, and a dashboard shows a limit
 * being respected that is not.
 *
 * Time is injected throughout. A test that asserted on the wall clock would be
 * slow and flaky, and — worse — would pass just as happily against code that
 * slept for the wrong reason.
 */

/** A grant. */
function allow(remainingTokens = 100): TokenGrant {
  return { allowed: true, waitForMs: 0, remainingTokens, unsatisfiable: false };
}

/** A refusal with a wait. */
function deny(waitForMs: number): TokenGrant {
  return { allowed: false, waitForMs, remainingTokens: 0, unsatisfiable: false };
}

/** A limiter that answers from a script, then allows for ever. */
function scripted(...answers: TokenGrant[]): {
  limiter: RateLimiter;
  asked: number[];
} {
  const asked: number[] = [];
  let index = 0;

  const limiter: RateLimiter = (requestedTokens) => {
    asked.push(requestedTokens);
    const answer = answers[index] ?? allow();
    index += 1;
    return Promise.resolve(answer);
  };

  return { limiter, asked };
}

/**
 * The error a call produced.
 *
 * Also asserts that it produced one. A `.catch()` that quietly returned
 * `undefined` would let a test about refusing pass against code that allowed.
 */
async function errorFrom<E extends Error>(call: Promise<unknown>): Promise<E> {
  try {
    await call;
  } catch (error: unknown) {
    return error as E;
  }

  throw new Error("Expected the call to reject, but it resolved.");
}

/** A sleep that records rather than waits. */
function recordingSleep(): { fn: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];

  return {
    fn: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
    waits,
  };
}

describe("a granted call proceeds without waiting", () => {
  test("it returns immediately", async () => {
    const { limiter, asked } = scripted(allow());
    const sleep = recordingSleep();

    await awaitTokens(limiter, 500, { sleepFn: sleep.fn });

    expect(asked).toEqual([500]);
    expect(sleep.waits).toEqual([]);
  });

  test("no limiter means no gate at all", async () => {
    const sleep = recordingSleep();

    // What a local file run does. The absence of a limiter is the only way to
    // opt out — there is deliberately no per-call bypass flag, because a
    // per-call bypass is one somebody eventually sets.
    await awaitTokens(undefined, 500, { sleepFn: sleep.fn });

    expect(sleep.waits).toEqual([]);
  });
});

describe("a refused call actually waits", () => {
  test("it sleeps, then asks again", async () => {
    const { limiter, asked } = scripted(deny(3000), allow());
    const sleep = recordingSleep();

    await awaitTokens(limiter, 500, { sleepFn: sleep.fn });

    // The property that matters: it stopped. A caller that logged the wait and
    // carried on would debit the bucket, hit the provider, and show a limit
    // being respected that was not.
    expect(sleep.waits).toEqual([3000]);
    expect(asked).toEqual([500, 500]);
  });

  test("it keeps asking rather than trusting one estimate", async () => {
    const { limiter, asked } = scripted(deny(1500), deny(1500), deny(1500), allow());
    const sleep = recordingSleep();

    await awaitTokens(limiter, 500, { sleepFn: sleep.fn });

    // The wait a limiter reports is computed without knowing who else is
    // queued, so another worker may take the capacity in between. Sleeping once
    // and assuming is what lets several workers wake together and all spend.
    expect(sleep.waits).toEqual([1500, 1500, 1500]);
    expect(asked).toHaveLength(4);
  });

  test("a single pause is capped, so a lease renewal is never starved", async () => {
    const { limiter } = scripted(deny(10 * 60 * 1000), allow());
    const sleep = recordingSleep();

    await awaitTokens(limiter, 500, { sleepFn: sleep.fn, budgetMs: 60 * 60 * 1000 });

    expect(sleep.waits).toEqual([DEFAULT_MAX_PAUSE_MS]);
  });

  test("a zero wait still pauses, so the loop cannot spin", async () => {
    const { limiter } = scripted(deny(0), allow());
    const sleep = recordingSleep();

    await awaitTokens(limiter, 500, { sleepFn: sleep.fn });

    // A limiter reporting zero would otherwise spin against the database as
    // fast as the event loop allows — a denial of service against our own
    // Postgres, caused by the thing meant to reduce load.
    expect(sleep.waits[0]).toBeGreaterThanOrEqual(1000);
  });

  test("each pause is reported, so a paused run does not look hung", async () => {
    const { limiter } = scripted(deny(2000), deny(2000), allow());
    const notices: Array<{ waitForMs: number; totalWaitedMs: number; attempt: number }> = [];
    const sleep = recordingSleep();

    await awaitTokens(limiter, 500, {
      sleepFn: sleep.fn,
      onWait: (notice) => notices.push(notice),
    });

    // An operator watching a silent process decides it has hung and kills it,
    // which throws away the pages it had already paid for.
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ waitForMs: 2000, totalWaitedMs: 2000, attempt: 1 });
    expect(notices[1]).toMatchObject({ totalWaitedMs: 4000, attempt: 2 });
  });
});

describe("waiting has a ceiling", () => {
  test("it gives up rather than holding a lease for ever", async () => {
    const { limiter } = scripted(deny(5000), deny(5000), deny(5000));
    const sleep = recordingSleep();

    await expect(
      awaitTokens(limiter, 500, { sleepFn: sleep.fn, budgetMs: 12_000 }),
    ).rejects.toBeInstanceOf(RateLimitTimeoutError);

    // Two pauses fit in the budget; the third would exceed it and is refused
    // before sleeping. A misconfigured bucket otherwise turns a run into a
    // process that is alive, holding a job lease, and never finishing — the
    // worst of the three outcomes, because it looks like progress.
    expect(sleep.waits).toEqual([5000, 5000]);
  });

  test("the timeout says how long it waited", async () => {
    const { limiter } = scripted(deny(5000), deny(5000), deny(5000));

    const error = await errorFrom<RateLimitTimeoutError>(
      awaitTokens(limiter, 500, {
        sleepFn: () => Promise.resolve(),
        budgetMs: 12_000,
      }),
    );

    expect(error).toBeInstanceOf(RateLimitTimeoutError);
    expect(error.waitedMs).toBe(10_000);
    expect(error.requestedTokens).toBe(500);
  });
});

describe("a request that can never fit fails at once", () => {
  test("it does not sleep", async () => {
    const { limiter } = scripted({
      allowed: false,
      waitForMs: 0,
      remainingTokens: 0,
      unsatisfiable: true,
    });
    const sleep = recordingSleep();

    await expect(
      awaitTokens(limiter, 500_000, { sleepFn: sleep.fn }),
    ).rejects.toBeInstanceOf(RateLimitImpossibleError);

    // Sleeping on it would burn the whole budget to reach the same conclusion,
    // and a run that failed after two minutes of silence reads as a hang rather
    // than as the configuration error it is.
    expect(sleep.waits).toEqual([]);
  });

  test("the message points at the fix rather than at the symptom", async () => {
    const { limiter } = scripted({
      allowed: false,
      waitForMs: 0,
      remainingTokens: 0,
      unsatisfiable: true,
    });

    const error = await errorFrom(
      awaitTokens(limiter, 500_000, { sleepFn: () => Promise.resolve() }),
    );

    expect(error.message).toMatch(/capacity/i);
    expect(error.message).toMatch(/waiting will not help/i);
  });
});

describe("the limiter is asked for the real cost", () => {
  test("the token count reaches the bucket unchanged", async () => {
    const asked: number[] = [];
    const limiter: RateLimiter = (tokens) => {
      asked.push(tokens);
      return Promise.resolve(allow());
    };

    await awaitTokens(limiter, 16_000, { sleepFn: vi.fn() });

    // A limiter charged a nominal 1 per call would bound requests per minute
    // and say nothing about tokens per minute, which is the limit a long
    // authoring run actually reaches first.
    expect(asked).toEqual([16_000]);
  });
});
