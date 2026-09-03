import { describe, expect, test, vi } from "vitest";
import type { RateLimiter, TokenGrant } from "@staticforge/core";

import {
  DEFAULT_MAX_PAUSE_MS,
  DEFAULT_RATE_LIMIT_BUDGET_MS,
  MIN_PAUSE_MS,
  RateLimitContractError,
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

/**
 * A limiter answering with something that is not a duration.
 *
 * The bug this closes had two halves, and the second is the one that made it an
 * outage rather than a wrong number.
 *
 * `Math.max(1000, NaN)` is `NaN`, and `setTimeout(fn, NaN)` fires immediately —
 * so the loop stops waiting and hammers the limiter as fast as the event loop
 * allows. Then `waited += NaN` makes `waited` permanently `NaN`, and
 * `NaN > budgetMs` is `false`, so the budget check is silently disabled for the
 * rest of the call. The one guard against a process that is alive, holding a
 * lease and never finishing, is switched off by a single bad answer — and stays
 * off even for later grants that are perfectly valid.
 */
describe("a limiter that answers with nonsense fails fast", () => {
  /** Everything that is not a duration, and how each one arrives. */
  const notDurations: ReadonlyArray<[string, number]> = [
    // A wait computed in TypeScript from a division by zero, which is exactly
    // how the database gate nearly produced one.
    ["NaN", Number.NaN],
    // "Never" expressed as a number rather than as `unsatisfiable`.
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    // A clock that went backwards between two reads.
    ["a negative wait", -5000],
  ];

  for (const [label, waitForMs] of notDurations) {
    test(`${label} throws instead of being slept on`, async () => {
      const { fn, waits } = recordingSleep();
      const { limiter } = scripted({
        allowed: false,
        waitForMs,
        remainingTokens: 0,
        unsatisfiable: false,
      });

      const error = await errorFrom<RateLimitContractError>(
        awaitTokens(limiter, 100, { sleepFn: fn }),
      );

      expect(error).toBeInstanceOf(RateLimitContractError);
      // Nothing was slept on. `setTimeout(fn, NaN)` fires immediately, so
      // passing it through is what turned this into a spin.
      expect(waits).toEqual([]);
    });
  }

  test("it does not spin the loop against the limiter", async () => {
    let calls = 0;
    const limiter: RateLimiter = () => {
      calls += 1;

      return Promise.resolve({
        allowed: false,
        waitForMs: Number.NaN,
        remainingTokens: 0,
        unsatisfiable: false,
      });
    };

    await errorFrom(awaitTokens(limiter, 100, { sleepFn: () => Promise.resolve() }));

    // Asked once and refused. Before the fix this loop ran until something
    // else broke, querying Postgres on every pass.
    expect(calls).toBe(1);
  });

  test("the error names the limiter, not the tenant's capacity", async () => {
    const { limiter } = scripted({
      allowed: false,
      waitForMs: Number.NaN,
      remainingTokens: 0,
      unsatisfiable: false,
    });

    const error = await errorFrom<RateLimitContractError>(
      awaitTokens(limiter, 100, { sleepFn: () => Promise.resolve() }),
    );

    // A `RateLimitTimeoutError` here would say "the bucket stayed full for two
    // minutes" and send an operator to look at capacity settings for a fault
    // nowhere near them. The value that caused it is carried on the error.
    expect(error.message).toMatch(/limiter is misbehaving/i);
    expect(error.message).toMatch(/waiting will not fix it/i);
    expect(Number.isNaN(error.reported as number)).toBe(true);
  });

  test("a valid wait is still honoured, so the guard is not just refusing everything", async () => {
    const { fn, waits } = recordingSleep();
    const { limiter } = scripted(deny(2000));

    await awaitTokens(limiter, 100, { sleepFn: fn });

    expect(waits).toEqual([2000]);
  });

  test("zero is a duration and keeps its one-second floor", async () => {
    const { fn, waits } = recordingSleep();
    const { limiter } = scripted(deny(0));

    // Zero is valid, not nonsense — it means "ask again shortly". The floor is
    // what stops it spinning, and it must survive a guard aimed at NaN.
    await awaitTokens(limiter, 100, { sleepFn: fn });

    expect(waits).toEqual([1000]);
  });
});

describe("a budget that is not a number cannot disable the timeout", () => {
  test("a NaN budget falls back to the default rather than being honoured", async () => {
    const { fn, waits } = recordingSleep();
    const limiter: RateLimiter = () => Promise.resolve(deny(DEFAULT_MAX_PAUSE_MS));

    const error = await errorFrom<RateLimitTimeoutError>(
      // `??` only catches null and undefined, so this NaN used to flow straight
      // through — and `waited + pause > NaN` is `false`, which disables the
      // timeout exactly as completely as a poisoned `waited` does. This is the
      // same bug arriving through the front door.
      awaitTokens(limiter, 100, { budgetMs: Number.NaN, sleepFn: fn }),
    );

    expect(error).toBeInstanceOf(RateLimitTimeoutError);
    // Bounded by the default budget rather than running for ever.
    expect(waits.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(
      DEFAULT_RATE_LIMIT_BUDGET_MS,
    );
  });

  test("a NaN pause ceiling falls back to the default", async () => {
    const { fn, waits } = recordingSleep();
    const { limiter } = scripted(deny(1_000_000));

    await awaitTokens(limiter, 100, { maxPauseMs: Number.NaN, sleepFn: fn });

    // Capped at the default rather than sleeping for a fortnight, which would
    // starve the lease renewal this ceiling exists to protect.
    expect(waits).toEqual([DEFAULT_MAX_PAUSE_MS]);
  });

  test("the iteration cap never fires before the budget does", async () => {
    const { fn, waits } = recordingSleep();
    // A long budget and the shortest legal pause: the most iterations a healthy
    // run can possibly make.
    const limiter: RateLimiter = () => Promise.resolve(deny(MIN_PAUSE_MS));

    const error = await errorFrom<RateLimitTimeoutError>(
      awaitTokens(limiter, 100, { budgetMs: 600_000, sleepFn: fn }),
    );

    // The cap is a backstop against arithmetic that has stopped working, and a
    // backstop that fires during normal operation is a bug of its own — it
    // would cut a legitimate ten-minute wait short and report it as a timeout
    // that never happened. The budget is what stopped this, at its full length.
    expect(error).toBeInstanceOf(RateLimitTimeoutError);
    expect(waits.length).toBe(600_000 / MIN_PAUSE_MS);
  });

  test("an explicit zero budget is still honoured, because zero is a number", async () => {
    const { limiter } = scripted(deny(1000));

    // The fallback must trigger on "not a duration", not on "falsy". Zero is a
    // real budget and means "do not wait at all".
    const error = await errorFrom<RateLimitTimeoutError>(
      awaitTokens(limiter, 100, { budgetMs: 0, sleepFn: () => Promise.resolve() }),
    );

    expect(error).toBeInstanceOf(RateLimitTimeoutError);
  });
});
