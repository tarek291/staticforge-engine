import { describe, expect, test } from "vitest";

import {
  LOGIN_GLOBAL_RATE_LIMIT_KEY,
  LOGIN_RATE_LIMIT,
  UNKNOWN_CLIENT,
  clientAddress,
  loginRateLimitKey,
} from "./client-address.js";

/**
 * Identifying a caller well enough to rate limit them.
 *
 * The tests worth reading are the ones about forgery. A limiter keyed on a
 * value the caller chooses is not a limiter — it binds the honest users who
 * send their real address and nobody else — and the failure is silent, because
 * the endpoint reports itself as protected either way.
 */

/** A `Headers`-shaped stand-in. */
function headers(map: Record<string, string>): { get: (name: string) => string | null } {
  return { get: (name) => map[name] ?? null };
}

describe("the forwarded address is read from the end of the chain", () => {
  test("the rightmost entry wins, because it is the one a caller cannot write", () => {
    // A request that reached a proxy carrying `X-Forwarded-For: 1.1.1.1` comes
    // out as `1.1.1.1, <the real peer>`. The first entry is whatever the caller
    // typed; the last was appended by the hop nearest this server.
    const address = clientAddress(
      headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }),
    );

    expect(address).toBe("203.0.113.9");
  });

  test("an attacker rotating the leftmost entry stays in one bucket", () => {
    const buckets = new Set(
      ["9.9.9.9", "8.8.8.8", "7.7.7.7", "6.6.6.6"].map((forged) =>
        loginRateLimitKey(
          clientAddress(headers({ "x-forwarded-for": `${forged}, 203.0.113.9` })),
        ),
      ),
    );

    // The whole point. Reading the leftmost entry would have produced four
    // buckets from four forged values, and a fifth on the next request — an
    // unlimited supply of fresh allowances, which is worse than no limiter
    // because it is reported as one.
    expect(buckets.size).toBe(1);
  });

  test("whitespace and empty entries do not produce a bucket of their own", () => {
    expect(
      clientAddress(headers({ "x-forwarded-for": "1.1.1.1,  , 203.0.113.9 ," })),
    ).toBe("203.0.113.9");
  });

  test("a single-valued platform header is preferred over the list", () => {
    // `x-real-ip` is *set* by the edge rather than appended to, so there is no
    // list for a caller to prepend to.
    expect(
      clientAddress(
        headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1" }),
      ),
    ).toBe("203.0.113.9");
  });

  test("an empty header falls through to the next one rather than being used", () => {
    expect(
      clientAddress(headers({ "x-real-ip": "   ", "x-forwarded-for": "203.0.113.9" })),
    ).toBe("203.0.113.9");
  });
});

describe("a caller with no address is still counted", () => {
  test("no headers at all lands in one shared bucket", () => {
    expect(clientAddress(headers({}))).toBe(UNKNOWN_CLIENT);
  });

  test("the unknown bucket is a real bucket, not a bypass", () => {
    // Letting an unidentifiable caller through unlimited would mean the way
    // past the limiter is to send *fewer* headers, which is not a bar.
    expect(loginRateLimitKey(UNKNOWN_CLIENT)).toBe(
      loginRateLimitKey(clientAddress(headers({}))),
    );
    expect(loginRateLimitKey(UNKNOWN_CLIENT)).not.toBe(LOGIN_GLOBAL_RATE_LIMIT_KEY);
  });
});

describe("the buckets are distinct and the policy is sized for people", () => {
  test("two addresses do not share a bucket", () => {
    expect(loginRateLimitKey("203.0.113.9")).not.toBe(loginRateLimitKey("203.0.113.8"));
  });

  test("the global bucket is not derived from the request", () => {
    // The one limit a forged header cannot move. If this ever became a function
    // of anything the caller sends, the backstop would stop being one.
    expect(LOGIN_GLOBAL_RATE_LIMIT_KEY).not.toContain("203.0.113.9");
    expect(LOGIN_GLOBAL_RATE_LIMIT_KEY).not.toContain(UNKNOWN_CLIENT);
  });

  test("one address may not out-attempt everybody put together", () => {
    // A per-address burst at or above the global one would make the global
    // bucket decorative for a single caller.
    expect(LOGIN_RATE_LIMIT.perAddressBurst).toBeLessThan(LOGIN_RATE_LIMIT.globalBurst);
    expect(LOGIN_RATE_LIMIT.perAddressRefillPerSec).toBeLessThan(
      LOGIN_RATE_LIMIT.globalRefillPerSec,
    );
  });

  test("a person can mistype a password without being locked out", () => {
    // Sized for a human, not an integration. A burst small enough to catch a
    // second wrong guess would generate more support than it prevents attacks.
    expect(LOGIN_RATE_LIMIT.perAddressBurst).toBeGreaterThanOrEqual(5);
  });

  test("sustained guessing is far below what stuffing needs to be worth running", () => {
    // One attempt every twenty seconds. Three an hour is not a credential
    // stuffing run; it is somebody who forgot their password.
    expect(LOGIN_RATE_LIMIT.perAddressRefillPerSec).toBeLessThanOrEqual(0.1);
  });
});
