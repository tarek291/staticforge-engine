import { describe, expect, test, vi } from "vitest";

import { isTransientDatabaseError, withDbRetry } from "./retry.js";

/**
 * The point of this wrapper is the line it draws, not the loop it runs.
 *
 * A connection that dropped is an outage and should be waited on; a constraint
 * that was violated is an answer and must surface immediately. Most of what
 * follows is about the second half, because retrying a real failure is the way
 * this feature does damage: it turns one clear refusal into four, delayed.
 */

/** A Prisma-shaped error, which is identified by its `code`. */
function prismaError(code: string): Error & { code: string } {
  return Object.assign(new Error(`prisma ${code}`), { code });
}

/** Never wait in real time. */
const instant = { sleepFn: () => Promise.resolve(), random: () => 0.5 };

describe("isTransientDatabaseError", () => {
  test("connection-layer failures are transient", () => {
    for (const code of [
      "P1001", // can't reach database server
      "P1002", // server reached but timed out
      "P1008", // operation timed out
      "P1011", // TLS error
      "P1017", // server closed the connection
      "P2024", // pool timeout
      "P2028", // transaction API error, typically a dropped connection
    ]) {
      expect(isTransientDatabaseError(prismaError(code)), code).toBe(true);
    }
  });

  test("an answer from the database is never transient", () => {
    // Each of these means the query arrived and the server replied. Retrying
    // repeats the same refusal and hides the reason behind a delay.
    for (const code of [
      "P2002", // unique constraint violation
      "P2003", // foreign key constraint violation
      "P2025", // record not found
      "P2000", // value too long for column
    ]) {
      expect(isTransientDatabaseError(prismaError(code)), code).toBe(false);
    }
  });

  test("an ordinary Error is not transient", () => {
    // It came from this codebase, not from the wire.
    expect(isTransientDatabaseError(new Error("boom"))).toBe(false);
    expect(isTransientDatabaseError("boom")).toBe(false);
    expect(isTransientDatabaseError(undefined)).toBe(false);
  });

  test("a client that could not initialise at all is transient", () => {
    const error = Object.assign(new Error("no connection"), {
      name: "PrismaClientInitializationError",
    });

    expect(isTransientDatabaseError(error)).toBe(true);
  });
});

describe("withDbRetry", () => {
  test("returns the first success without waiting", async () => {
    const sleepFn = vi.fn(() => Promise.resolve());

    await expect(withDbRetry(() => Promise.resolve("ok"), { sleepFn })).resolves.toBe(
      "ok",
    );
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test("recovers from a dropped connection", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(prismaError("P1017"))
      .mockResolvedValueOnce("ok");

    await expect(withDbRetry(operation, instant)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  test("rethrows a constraint violation on the first attempt", async () => {
    const operation = vi.fn().mockRejectedValue(prismaError("P2002"));

    await expect(withDbRetry(operation, instant)).rejects.toThrow("prisma P2002");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test("preserves the original error rather than wrapping it", async () => {
    // A caller matching on a Prisma code has to still be able to.
    const operation = vi.fn().mockRejectedValue(prismaError("P2025"));

    await expect(withDbRetry(operation, instant)).rejects.toMatchObject({
      code: "P2025",
    });
  });

  test("gives up after the budget and rethrows the last failure", async () => {
    const operation = vi.fn().mockRejectedValue(prismaError("P1001"));

    await expect(
      withDbRetry(operation, { ...instant, maxRetries: 2 }),
    ).rejects.toThrow("prisma P1001");

    // maxRetries is retries *after* the first attempt.
    expect(operation).toHaveBeenCalledTimes(3);
  });

  test("backs off exponentially, capped", async () => {
    const delays: number[] = [];
    const operation = vi.fn().mockRejectedValue(prismaError("P1001"));

    await withDbRetry(operation, {
      maxRetries: 4,
      baseDelayMs: 100,
      maxDelayMs: 400,
      random: () => 1, // no jitter reduction, so the ceiling is visible
      sleepFn: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => undefined);

    expect(delays).toEqual([100, 200, 400, 400]);
  });

  test("jitters, so a fleet does not reconverge on one schedule", async () => {
    // A pooler drops many connections at once. Retrying on an identical
    // schedule rebuilds the spike the retry is recovering from.
    const delays: number[] = [];
    const operation = vi.fn().mockRejectedValue(prismaError("P2024"));

    await withDbRetry(operation, {
      maxRetries: 1,
      baseDelayMs: 1000,
      random: () => 0, // the low end of the jitter window
      sleepFn: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    }).catch(() => undefined);

    expect(delays).toEqual([500]);
  });

  test("reports each retry, with the code that caused it", async () => {
    const onRetry = vi.fn();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(prismaError("P1001"))
      .mockResolvedValueOnce("ok");

    await withDbRetry(operation, { ...instant, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 4,
      code: "P1001",
    });
  });

  test("hands the operation its attempt number", async () => {
    const seen: number[] = [];

    await withDbRetry((attempt) => {
      seen.push(attempt);
      return attempt < 3
        ? Promise.reject(prismaError("P1001"))
        : Promise.resolve("ok");
    }, instant);

    expect(seen).toEqual([1, 2, 3]);
  });
});
