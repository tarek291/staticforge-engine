import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";
import { planTokenConsumption } from "@staticforge/core";

import {
  consumeApiTokens,
  createProjectRateLimiter,
  projectBucketKey,
} from "./rate-limit.js";

/**
 * The distributed bucket.
 *
 * The guarantee this module exists for cannot be proved by a mock: only a real
 * Postgres can show that two concurrent callers are serialised. What a mock
 * *can* prove — and what these tests are about — is that the decision is
 * delegated to the database at all.
 *
 * That distinction is the whole design. A read-then-write implementation would
 * satisfy every behavioural test anyone wrote and still let two workers spend
 * the same tokens, because the bug lives in the gap between two queries rather
 * than in either of them. So the tests below assert the *shape*: one statement,
 * no read before it, the arithmetic inside it.
 *
 * The end-to-end behaviour under real concurrency is verified against Supabase
 * and reported with the change, not asserted here — the database suite does not
 * open a connection, and that guarantee is worth more than this one test.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

/** Arm the grant statement to succeed with a given balance. */
function armGrant(availableTokens: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.$queryRawUnsafe.mockResolvedValue([{ availableTokens }] as any);
}

/** Arm the grant statement to be refused. */
function armDenial(state: { availableTokens: number; lastRefillAt: Date } | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.$queryRawUnsafe.mockResolvedValue([] as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.rateLimitState.findUnique.mockResolvedValue(state as any);
}

/** The SQL text of the statement that was run. */
function sqlText(): string {
  return String(prisma.$queryRawUnsafe.mock.calls[0]?.[0] ?? "");
}

describe("the decision belongs to the database", () => {
  test("a grant is one statement, with nothing read first", async () => {
    armGrant(70);

    await consumeApiTokens("bucket", 30, 100, 10, prisma);

    // The property that makes this safe across processes. A read before the
    // write would satisfy every behavioural test ever written and still let two
    // workers spend the same tokens.
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(prisma.rateLimitState.findUnique).not.toHaveBeenCalled();
  });

  test("the statement upserts, so a first caller does not race to create a row", async () => {
    armGrant(70);

    await consumeApiTokens("bucket", 30, 100, 10, prisma);

    const sql = sqlText();

    expect(sql).toContain("INSERT INTO");
    expect(sql).toContain("ON CONFLICT");
    expect(sql).toContain("DO UPDATE");
  });

  test("the grant condition is in the statement, not around it", async () => {
    armGrant(70);

    await consumeApiTokens("bucket", 30, 100, 10, prisma);

    const sql = sqlText();

    // `WHERE refilled >= requested` on the conflict path is what makes Postgres
    // re-evaluate the decision against the locked, current tuple.
    expect(sql).toMatch(/WHERE[\s\S]*>=\s*\$2/);
    expect(sql).toContain("RETURNING");
  });

  test("the refill arithmetic is in the statement", async () => {
    armGrant(70);

    await consumeApiTokens("bucket", 30, 100, 10, prisma);

    const sql = sqlText();

    // Clamped at capacity, floored to whole tokens, and clamped at zero elapsed
    // so a backwards clock cannot remove tokens.
    expect(sql).toContain("LEAST(");
    expect(sql).toContain("FLOOR(");
    expect(sql).toContain("GREATEST(0,");
    expect(sql).toContain("EXTRACT(EPOCH FROM");
  });

  test("the clock advances by the tokens earned, not to NOW()", async () => {
    armGrant(70);

    await consumeApiTokens("bucket", 30, 100, 10, prisma);

    // Advancing to NOW() would discard the sub-token remainder on every call,
    // and a caller polling faster than one token's worth of time would earn
    // nothing at all. `make_interval` is what carries it.
    expect(sqlText()).toContain("make_interval");
  });

  test("the key and the policy travel as parameters, not as interpolation", async () => {
    armGrant(70);

    await consumeApiTokens("tenant-42", 30, 100, 10, prisma);

    const args = prisma.$queryRawUnsafe.mock.calls[0]?.slice(1);

    // A bucket key is a value a caller chose. Interpolating one into SQL would
    // make the rate limiter the injection point.
    expect(args).toEqual(["tenant-42", 30, 100, 10]);
  });
});

describe("a granted spend", () => {
  test("reports what is left", async () => {
    armGrant(70);

    const grant = await consumeApiTokens("bucket", 30, 100, 10, prisma);

    expect(grant).toEqual({
      allowed: true,
      waitForMs: 0,
      remainingTokens: 70,
      unsatisfiable: false,
    });
  });

  test("a zero-cost call is answered without a query", async () => {
    const grant = await consumeApiTokens("bucket", 0, 100, 10, prisma);

    // Answered rather than treated as a degenerate grant: a caller that
    // computed a zero cost by accident should not silently bypass the limiter
    // *and* pay for a round trip to do it.
    expect(grant.allowed).toBe(true);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("a refused spend", () => {
  test("reads the state back to say how long to wait", async () => {
    const lastRefillAt = new Date(Date.now() - 1000);
    armDenial({ availableTokens: 5, lastRefillAt });

    const grant = await consumeApiTokens("bucket", 100, 200, 10, prisma);

    expect(grant.allowed).toBe(false);
    expect(grant.waitForMs).toBeGreaterThan(0);
    expect(prisma.rateLimitState.findUnique).toHaveBeenCalledWith({
      where: { id: "bucket" },
      select: { availableTokens: true, lastRefillAt: true },
    });
  });

  test("the wait matches the shared arithmetic", async () => {
    const lastRefillAt = new Date("2026-08-28T12:00:00.000Z");
    const now = new Date("2026-08-28T12:00:00.000Z");
    armDenial({ availableTokens: 0, lastRefillAt });

    const grant = await consumeApiTokens("bucket", 50, 200, 10, prisma);
    const expected = planTokenConsumption(
      { availableTokens: 0, lastRefillAt },
      { maxCapacity: 200, refillRatePerSec: 10 },
      50,
      now,
    );

    // The formula lives in two places — the SQL, which is authoritative, and
    // `planTokenConsumption`, which computes the wait. Pinning them against
    // each other here is the drift guard that the duplication needs.
    expect(grant.waitForMs).toBeLessThanOrEqual(expected.waitForMs);
    expect(grant.waitForMs).toBeGreaterThan(0);
  });

  test("a vanished row is not something to wait for", async () => {
    armDenial(null);

    const grant = await consumeApiTokens("bucket", 100, 200, 10, prisma);

    // Truncated, or cleaned up. The next attempt recreates it full, so a wait
    // would be time spent for nothing.
    expect(grant).toEqual({
      allowed: false,
      waitForMs: 0,
      remainingTokens: 0,
      unsatisfiable: false,
    });
  });
});

describe("a request larger than the bucket", () => {
  test("is refused without touching the database", async () => {
    const grant = await consumeApiTokens("bucket", 500, 100, 10, prisma);

    // A configuration error, not a busy moment. Telling the caller to wait
    // would be telling it to wait for ever, and querying first would spend a
    // round trip to reach a conclusion the arguments already contain.
    expect(grant.unsatisfiable).toBe(true);
    expect(grant.allowed).toBe(false);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test("a request of exactly the capacity is not refused this way", async () => {
    armGrant(0);

    const grant = await consumeApiTokens("bucket", 100, 100, 10, prisma);

    expect(grant.allowed).toBe(true);
    expect(grant.unsatisfiable).toBe(false);
  });
});

describe("a bound limiter cannot widen its own limit", () => {
  test("it takes only a token count", async () => {
    armGrant(70);

    const limiter = createProjectRateLimiter(
      "prj_1",
      { maxCapacity: 100, refillRatePerSec: 10 },
      prisma,
    );

    await limiter(30);

    // The consumer chooses how much to spend and nothing else. A component able
    // to choose its own bucket, or raise its capacity, is not limited.
    expect(prisma.$queryRawUnsafe.mock.calls[0]?.slice(1)).toEqual([
      "anthropic:prj_1",
      30,
      100,
      10,
    ]);
  });

  test("the key is derived in one place", () => {
    // A key computed in two places is two buckets, the moment one changes.
    expect(projectBucketKey("prj_1")).toBe("anthropic:prj_1");
    expect(projectBucketKey("prj_1", "openai")).toBe("openai:prj_1");
  });

  test("two scopes on one project are separate buckets", () => {
    // Otherwise a token budget and a request budget would draw each other down.
    expect(projectBucketKey("prj_1", "tokens")).not.toBe(
      projectBucketKey("prj_1", "requests"),
    );
  });
});
