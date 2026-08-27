import { describe, expect, test, vi } from "vitest";

import {
  RetryExhaustedError,
  classifyError,
  computeDelayMs,
  withRetry,
} from "./retry.js";

/** No suite may wait in real time; every test injects this. */
const noWait = { sleepFn: () => Promise.resolve(), random: () => 0.5 };

/** An error shaped like the SDK's, without depending on the SDK's classes. */
function apiError(status: number, headers?: Record<string, string>) {
  return Object.assign(new Error(`HTTP ${status}`), { status, headers });
}

describe("classifyError", () => {
  test("treats rate limiting and server faults as retryable", () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504, 529]) {
      expect(classifyError(apiError(status)).retryable, `status ${status}`).toBe(true);
    }
  });

  test("treats client mistakes as final", () => {
    // Waiting cannot fix a bad key, a bad model id, or an oversized request.
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(classifyError(apiError(status)).retryable, `status ${status}`).toBe(false);
    }
  });

  test("treats a failure with no HTTP status as a transport problem", () => {
    // DNS failure, socket reset, aborted request: no response ever arrived.
    expect(classifyError(new Error("ECONNRESET")).retryable).toBe(true);
    expect(classifyError(new Error("ECONNRESET")).status).toBeUndefined();
  });

  test("survives being handed something that is not an error", () => {
    for (const value of [null, undefined, "boom", 42]) {
      expect(() => classifyError(value)).not.toThrow();
    }
  });

  test("reads retry-after from a plain header bag", () => {
    expect(classifyError(apiError(429, { "retry-after": "12" })).retryAfterMs).toBe(
      12_000,
    );
  });

  test("reads retry-after from a Headers instance", () => {
    const error = Object.assign(new Error("429"), {
      status: 429,
      headers: new Headers({ "retry-after": "3" }),
    });

    expect(classifyError(error).retryAfterMs).toBe(3000);
  });

  test("ignores a retry-after that is not a number", () => {
    expect(
      classifyError(apiError(429, { "retry-after": "soon" })).retryAfterMs,
    ).toBeUndefined();
  });
});

describe("computeDelayMs", () => {
  const base = { baseDelayMs: 1000, maxDelayMs: 30_000, random: () => 1 };

  test("backs off exponentially", () => {
    expect(computeDelayMs(1, { ...base, retryAfterMs: undefined })).toBe(1000);
    expect(computeDelayMs(2, { ...base, retryAfterMs: undefined })).toBe(2000);
    expect(computeDelayMs(3, { ...base, retryAfterMs: undefined })).toBe(4000);
  });

  test("caps the wait", () => {
    expect(computeDelayMs(20, { ...base, retryAfterMs: undefined })).toBe(30_000);
  });

  test("applies jitter between half and full the computed delay", () => {
    const low = computeDelayMs(3, { ...base, random: () => 0, retryAfterMs: undefined });
    const high = computeDelayMs(3, { ...base, random: () => 1, retryAfterMs: undefined });

    // Full jitter: spreads a fleet of workers instead of synchronising them
    // into a thundering herd against a provider that is already struggling.
    expect(low).toBe(2000);
    expect(high).toBe(4000);
  });

  test("obeys retry-after over its own formula", () => {
    expect(computeDelayMs(1, { ...base, retryAfterMs: 9000 })).toBe(9000);
  });

  test("still caps a retry-after that is absurdly long", () => {
    expect(computeDelayMs(1, { ...base, retryAfterMs: 600_000 })).toBe(30_000);
  });
});

describe("withRetry", () => {
  test("returns the first success without waiting", async () => {
    const sleepFn = vi.fn(() => Promise.resolve());
    const operation = vi.fn(() => Promise.resolve("ok"));

    await expect(withRetry(operation, { ...noWait, sleepFn })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  test("retries a transient failure and returns the eventual success", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(apiError(529))
      .mockRejectedValueOnce(apiError(500))
      .mockResolvedValue("ok");

    await expect(withRetry(operation, noWait)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  test("does not retry a client mistake, and rethrows it untouched", async () => {
    const original = apiError(401);
    const operation = vi.fn(() => Promise.reject(original));

    await expect(withRetry(operation, noWait)).rejects.toBe(original);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  test("gives up after the budget, reporting attempts and last status", async () => {
    const operation = vi.fn(() => Promise.reject(apiError(503)));

    await expect(
      withRetry(operation, { ...noWait, maxRetries: 2 }),
    ).rejects.toMatchObject({
      name: "RetryExhaustedError",
      attempts: 3,
      status: 503,
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  test("preserves the original failure as the cause", async () => {
    const original = apiError(500);

    try {
      await withRetry(() => Promise.reject(original), { ...noWait, maxRetries: 1 });
      throw new Error("expected withRetry to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError);
      expect((error as RetryExhaustedError).cause).toBe(original);
    }
  });

  test("waits the amount the provider asked for", async () => {
    const sleepFn = vi.fn(() => Promise.resolve());
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(apiError(429, { "retry-after": "7" }))
      .mockResolvedValue("ok");

    await withRetry(operation, { ...noWait, sleepFn });

    expect(sleepFn).toHaveBeenCalledWith(7000);
  });

  test("reports each retry before waiting", async () => {
    const onRetry = vi.fn();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(apiError(529))
      .mockResolvedValue("ok");

    await withRetry(operation, { ...noWait, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
      attempt: 1,
      maxAttempts: 4,
      status: 529,
    });
  });

  test("passes the attempt number to the operation", async () => {
    const seen: number[] = [];

    await withRetry(
      (attempt) => {
        seen.push(attempt);
        return attempt < 3 ? Promise.reject(apiError(500)) : Promise.resolve("ok");
      },
      noWait,
    );

    expect(seen).toEqual([1, 2, 3]);
  });
});
