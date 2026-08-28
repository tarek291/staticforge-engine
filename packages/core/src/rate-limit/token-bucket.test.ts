import { describe, expect, test } from "vitest";

import {
  planTokenConsumption,
  unlimited,
  type TokenBucketPolicy,
  type TokenBucketState,
} from "./token-bucket.js";

/**
 * The bucket arithmetic.
 *
 * Two properties carry the feature and both fail quietly. Granting more than
 * the bucket holds produces 429s in the middle of a paid run and looks like a
 * provider problem. Losing the fractional remainder of a refill produces a
 * caller that waits for ever while the maths insists it is being topped up.
 */

const T0 = new Date("2026-08-28T12:00:00.000Z");

/** `seconds` after T0. */
function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

const POLICY: TokenBucketPolicy = { maxCapacity: 100, refillRatePerSec: 10 };

function state(availableTokens: number, lastRefillAt = T0): TokenBucketState {
  return { availableTokens, lastRefillAt };
}

describe("spending what is there", () => {
  test("a full bucket grants and deducts", () => {
    const plan = planTokenConsumption(state(100), POLICY, 30, T0);

    expect(plan.granted).toBe(true);
    expect(plan.remainingTokens).toBe(70);
    expect(plan.waitForMs).toBe(0);
  });

  test("spending exactly the balance is allowed", () => {
    const plan = planTokenConsumption(state(30), POLICY, 30, T0);

    // `>=`, not `>`. Off by one here means the last token of every bucket is
    // permanently unspendable.
    expect(plan.granted).toBe(true);
    expect(plan.remainingTokens).toBe(0);
  });

  test("spending one more than the balance is refused", () => {
    const plan = planTokenConsumption(state(29), POLICY, 30, T0);

    expect(plan.granted).toBe(false);
    expect(plan.remainingTokens).toBe(29);
  });

  test("a refusal leaves the bucket untouched", () => {
    const plan = planTokenConsumption(state(5), POLICY, 30, T0);

    // Including the clock. The time a refused caller spends waiting is time the
    // bucket is still filling; advancing it here would charge the caller for
    // its own wait.
    expect(plan.remainingTokens).toBe(5);
    expect(plan.nextRefillAt).toEqual(T0);
  });
});

describe("refilling over time", () => {
  test("tokens accrue at the configured rate", () => {
    const plan = planTokenConsumption(state(0), POLICY, 25, at(3));

    // 3 seconds at 10/s.
    expect(plan.refilledTokens).toBe(30);
    expect(plan.granted).toBe(true);
    expect(plan.remainingTokens).toBe(5);
  });

  test("the bucket never exceeds its capacity", () => {
    const plan = planTokenConsumption(state(90), POLICY, 1, at(3600));

    // An hour at 10/s is 36,000 tokens. A bucket that banked them would let an
    // idle tenant burst a whole hour's allowance at once, which is exactly what
    // the provider's own limiter would refuse.
    expect(plan.refilledTokens).toBe(100);
  });

  test("a clock that went backwards adds nothing, and takes nothing", () => {
    const plan = planTokenConsumption(state(50, at(10)), POLICY, 10, T0);

    // An NTP correction, or two machines disagreeing. Negative elapsed time
    // must not remove tokens a caller has already been told it has.
    expect(plan.refilledTokens).toBe(50);
    expect(plan.granted).toBe(true);
  });
});

describe("the fractional remainder is carried, not lost", () => {
  test("a partial second earns nothing yet", () => {
    const plan = planTokenConsumption(state(0), { maxCapacity: 10, refillRatePerSec: 1 }, 1, at(0.4));

    expect(plan.refilledTokens).toBe(0);
    expect(plan.granted).toBe(false);
  });

  test("a grant advances the clock by the tokens earned, not to now", () => {
    // 2.7 seconds at 1/s earns 2 whole tokens. Advancing the clock to `now`
    // would discard 0.7 seconds of accrual — and a caller polling faster than
    // one token's worth of time would then earn nothing, for ever.
    const plan = planTokenConsumption(
      state(0),
      { maxCapacity: 10, refillRatePerSec: 1 },
      2,
      at(2.7),
    );

    expect(plan.granted).toBe(true);
    expect(plan.nextRefillAt).toEqual(at(2));
  });

  test("polling out of step with the refill rate does not lose throughput", () => {
    const policy: TokenBucketPolicy = { maxCapacity: 10, refillRatePerSec: 1 };
    let current = state(0);
    let granted = 0;

    // Twenty polls at 0.7s intervals — deliberately out of step with the 1/s
    // refill, which is the case that exposes a lost remainder. Advancing the
    // clock to `now` on each grant discards 0.4s every time and drops
    // throughput to roughly one grant per 1.4s instead of per 1s.
    for (let i = 1; i <= 20; i += 1) {
      const plan = planTokenConsumption(current, policy, 1, at(i * 0.7));

      if (plan.granted) {
        granted += 1;
        current = { availableTokens: plan.remainingTokens, lastRefillAt: plan.nextRefillAt };
      }
    }

    // Fourteen seconds at one token per second. An implementation that reset
    // the clock on every grant manages ten, and nothing anywhere reports that
    // the tenant is being under-served by 30%.
    expect(granted).toBe(14);
  });

  test("a full bucket does discard the remainder, which is what a bucket means", () => {
    const plan = planTokenConsumption(
      state(100),
      POLICY,
      10,
      at(50),
    );

    expect(plan.refilledTokens).toBe(100);
    expect(plan.nextRefillAt).toEqual(at(50));
  });
});

describe("the wait it reports", () => {
  test("is how long the shortfall takes to accrue", () => {
    const plan = planTokenConsumption(state(0), POLICY, 25, T0);

    // 25 tokens at 10/s.
    expect(plan.waitForMs).toBe(2500);
  });

  test("is rounded up, never down", () => {
    const plan = planTokenConsumption(state(0), { maxCapacity: 10, refillRatePerSec: 3 }, 1, T0);

    // 1/3 s = 333.33ms. Waking a millisecond early means being refused again,
    // and a loop that goes round twice per grant doubles the load it exists to
    // reduce.
    expect(plan.waitForMs).toBe(334);
  });

  test("is zero when granted", () => {
    expect(planTokenConsumption(state(100), POLICY, 1, T0).waitForMs).toBe(0);
  });
});

describe("a request that can never fit", () => {
  test("is reported as unsatisfiable rather than as a long wait", () => {
    const plan = planTokenConsumption(state(100), POLICY, 101, T0);

    // "Wait and try again" is advice that never comes true here. A caller told
    // to sleep on it would sleep until its budget ran out and learn nothing.
    expect(plan.unsatisfiable).toBe(true);
    expect(plan.granted).toBe(false);
    expect(plan.waitForMs).toBe(0);
  });

  test("a request of exactly the capacity is satisfiable", () => {
    const plan = planTokenConsumption(state(100), POLICY, 100, T0);

    expect(plan.unsatisfiable).toBe(false);
    expect(plan.granted).toBe(true);
  });

  test("an oversized request leaves the bucket alone", () => {
    const plan = planTokenConsumption(state(100), POLICY, 500, T0);

    expect(plan.remainingTokens).toBe(100);
    expect(plan.nextRefillAt).toEqual(T0);
  });
});

describe("serialised callers cannot together exceed the bucket", () => {
  test("concurrent spenders are bounded by capacity plus refill", () => {
    // The property the SQL exists to guarantee, asserted against the arithmetic
    // it implements: given serialised application of the plan — which is what a
    // row lock provides — the total granted can never exceed what the bucket
    // held plus what it earned.
    const policy: TokenBucketPolicy = { maxCapacity: 100, refillRatePerSec: 10 };
    let current = state(100);
    let spent = 0;

    // Twenty workers all asking for 20 tokens at the same instant.
    for (let i = 0; i < 20; i += 1) {
      const plan = planTokenConsumption(current, policy, 20, T0);

      if (plan.granted) {
        spent += 20;
        current = { availableTokens: plan.remainingTokens, lastRefillAt: plan.nextRefillAt };
      }
    }

    // Five get through, fifteen are refused. Not twenty, which is what a
    // read-then-write in application code would have allowed.
    expect(spent).toBe(100);
    expect(current.availableTokens).toBe(0);
  });

  test("over a window, throughput is bounded by the refill rate", () => {
    const policy: TokenBucketPolicy = { maxCapacity: 10, refillRatePerSec: 1 };
    let current = state(10);
    let spent = 0;

    // A hundred attempts spread over ten seconds.
    for (let i = 0; i < 100; i += 1) {
      const plan = planTokenConsumption(current, policy, 1, at(i * 0.1));

      if (plan.granted) {
        spent += 1;
        current = { availableTokens: plan.remainingTokens, lastRefillAt: plan.nextRefillAt };
      }
    }

    // The initial burst of 10, plus roughly a token per second thereafter —
    // never the 100 an unlimited caller would have made.
    expect(spent).toBeGreaterThanOrEqual(10);
    expect(spent).toBeLessThanOrEqual(21);
  });
});

describe("a bucket that never refills is a hard quota", () => {
  const QUOTA: TokenBucketPolicy = { maxCapacity: 100, refillRatePerSec: 0 };

  test("it spends what it has", () => {
    const plan = planTokenConsumption(state(40), QUOTA, 30, at(60));

    expect(plan.granted).toBe(true);
    expect(plan.remainingTokens).toBe(10);
  });

  test("time adds nothing to it", () => {
    const plan = planTokenConsumption(state(0), QUOTA, 1, at(86_400));

    // A day later and still empty. The arithmetic must not divide by the rate
    // to discover that — `0 / 0` is `NaN`, and `NaN >= 1` is false, which is
    // the right answer reached by an accident nobody should rely on.
    expect(plan.refilledTokens).toBe(0);
    expect(plan.granted).toBe(false);
  });

  test("an exhausted quota is unsatisfiable rather than a wait", () => {
    const plan = planTokenConsumption(state(0), QUOTA, 1, at(60));

    // Not busy — exhausted. Telling the caller to wait would be telling it to
    // wait for ever, which is the same lie an oversized request would be told.
    expect(plan.unsatisfiable).toBe(true);
    expect(plan.waitForMs).toBe(0);
  });

  test("the clock is left alone, so nothing accrues by accident", () => {
    const plan = planTokenConsumption(state(40), QUOTA, 30, at(60));

    expect(plan.nextRefillAt).toEqual(T0);
    expect(Number.isNaN(plan.nextRefillAt.getTime())).toBe(false);
  });
});

describe("the unlimited limiter", () => {
  test("always allows, so an unconfigured run behaves as it always did", async () => {
    const grant = await unlimited()(1_000_000);

    expect(grant.allowed).toBe(true);
    expect(grant.waitForMs).toBe(0);
    expect(grant.unsatisfiable).toBe(false);
  });
});
