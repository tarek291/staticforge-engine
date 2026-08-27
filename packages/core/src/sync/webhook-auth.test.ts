import { describe, expect, test } from "vitest";

import {
  MIN_SECRET_LENGTH,
  extractBearerToken,
  verifyWebhookToken,
  webhookAuthStatus,
} from "./webhook-auth.js";

/**
 * The webhook's front door.
 *
 * Most of this is about refusals, because an authentication check is only worth
 * having if every way of getting it wrong is closed — and the ways that matter
 * here are the quiet ones: a secret nobody set, a placeholder nobody replaced,
 * an error message that says which half of the token was right.
 */

const SECRET = "s".repeat(MIN_SECRET_LENGTH) + "-a-real-looking-secret";

describe("extractBearerToken", () => {
  test("reads the standard scheme a webhook sender emits", () => {
    expect(extractBearerToken(`Bearer ${SECRET}`)).toBe(SECRET);
  });

  test("is case-insensitive about the scheme", () => {
    expect(extractBearerToken(`bearer ${SECRET}`)).toBe(SECRET);
    expect(extractBearerToken(`BEARER ${SECRET}`)).toBe(SECRET);
  });

  test("accepts a bare token, which is what an operator types into curl", () => {
    expect(extractBearerToken(SECRET)).toBe(SECRET);
  });

  test("treats absent, empty and whitespace headers alike", () => {
    for (const header of [null, undefined, "", "   ", "Bearer   "]) {
      expect(extractBearerToken(header)).toBeUndefined();
    }
  });
});

describe("verifyWebhookToken accepts only the real secret", () => {
  test("accepts the configured secret", () => {
    expect(verifyWebhookToken(`Bearer ${SECRET}`, SECRET)).toEqual({ ok: true });
  });

  test("refuses a wrong token", () => {
    const result = verifyWebhookToken(`Bearer ${"x".repeat(40)}`, SECRET);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("invalid-token");
  });

  test("refuses a token that is a prefix of the secret", () => {
    // The case a naive comparison plus a length check would let through.
    const result = verifyWebhookToken(`Bearer ${SECRET.slice(0, -1)}`, SECRET);

    expect(result.ok).toBe(false);
  });

  test("refuses a token that merely contains the secret", () => {
    const result = verifyWebhookToken(`Bearer ${SECRET}extra`, SECRET);

    expect(result.ok).toBe(false);
  });

  test("refuses a missing header", () => {
    const result = verifyWebhookToken(null, SECRET);

    expect(result.ok === false && result.reason).toBe("missing-token");
  });
});

describe("verifyWebhookToken fails closed", () => {
  test("an unset secret refuses every call", () => {
    // The failure mode of a forgotten environment variable has to be a closed
    // door. This route writes tenant data and queues paid work.
    for (const secret of [undefined, "", "   "]) {
      const result = verifyWebhookToken(`Bearer ${SECRET}`, secret);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("not-configured");
    }
  });

  test("an unset secret is not satisfied by an empty token either", () => {
    // The bug this guards: comparing "" to "" and calling it a match.
    const result = verifyWebhookToken("Bearer ", undefined);

    expect(result.ok).toBe(false);
  });

  test("a placeholder secret is refused rather than honoured", () => {
    const result = verifyWebhookToken("Bearer changeme", "changeme");

    // Somebody meant to replace this. Accepting it authenticates anyone who
    // guessed the most obvious value in the world.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("weak-secret");
  });

  test("a secret one character under the floor is still refused", () => {
    const short = "a".repeat(MIN_SECRET_LENGTH - 1);

    expect(verifyWebhookToken(`Bearer ${short}`, short).ok).toBe(false);
  });

  test("a secret exactly at the floor is accepted", () => {
    const exact = "a".repeat(MIN_SECRET_LENGTH);

    expect(verifyWebhookToken(`Bearer ${exact}`, exact)).toEqual({ ok: true });
  });
});

describe("what a refusal tells the caller", () => {
  test("a wrong token and a missing one get the same message", () => {
    const wrong = verifyWebhookToken("Bearer wrong-token-entirely", SECRET);
    const absent = verifyWebhookToken(null, SECRET);

    // Distinct reasons for our own logging, but nothing in either message
    // narrows the search for the real value.
    expect(wrong.ok === false && wrong.message).not.toContain(SECRET);
    expect(absent.ok === false && absent.message).not.toContain(SECRET);
  });

  test("no refusal ever echoes the secret", () => {
    for (const header of [null, "Bearer wrong", `Bearer ${SECRET.slice(0, 8)}`]) {
      const result = verifyWebhookToken(header, SECRET);

      expect(result.ok === false && result.message.includes(SECRET)).toBe(false);
    }
  });

  test("a misconfigured server answers 503, a bad caller 401", () => {
    // 503 does not imply the caller could fix it by trying another token.
    expect(webhookAuthStatus("not-configured")).toBe(503);
    expect(webhookAuthStatus("weak-secret")).toBe(503);
    expect(webhookAuthStatus("missing-token")).toBe(401);
    expect(webhookAuthStatus("invalid-token")).toBe(401);
  });
});
