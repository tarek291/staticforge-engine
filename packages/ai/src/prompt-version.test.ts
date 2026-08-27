import { DEFAULT_CONTENT_PROFILE, STRICT_SEO_PROFILE } from "@staticforge/schemas";
import { stableHash } from "@staticforge/core";
import { describe, expect, test } from "vitest";

import { PROMPT_VERSION, buildSystemPrompt } from "./prompts.js";

/**
 * The prompt version is recorded on every page it writes and is part of the
 * cache key. If the prompt text changes without a version bump, the cache keeps
 * serving content written by a prompt that no longer exists — silently, and
 * indefinitely.
 *
 * These fingerprints make that impossible to do by accident. When one fails:
 *
 *   1. Confirm the prompt change was intended.
 *   2. Bump PROMPT_VERSION in prompts.ts.
 *   3. Update the fingerprint below to the value the failure reports.
 *
 * Step 2 is the one that matters; step 3 only re-arms the guard.
 */

const FINGERPRINTS: Record<string, string> = {
  "1.0.0::default": "9db36cecfac7a8cc",
  "1.0.0::strictSeo": "a3b3978de4c01438",
};

describe("prompt version", () => {
  test("is a readable version string", () => {
    expect(PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const profile of [DEFAULT_CONTENT_PROFILE, STRICT_SEO_PROFILE]) {
    test(`the "${profile.id}" prompt has not drifted without a version bump`, () => {
      const key = `${PROMPT_VERSION}::${profile.id}`;
      const actual = stableHash(buildSystemPrompt(profile));

      expect(
        actual,
        `The ${profile.id} prompt changed but PROMPT_VERSION is still ${PROMPT_VERSION}. ` +
          `Bump it in prompts.ts, then set the fingerprint for "${key}" to "${actual}".`,
      ).toBe(FINGERPRINTS[key]);
    });
  }

  test("a changed profile produces a different prompt fingerprint", () => {
    const widened = { ...STRICT_SEO_PROFILE, title: { min: 5, max: 65 } };

    expect(stableHash(buildSystemPrompt(widened))).not.toBe(
      stableHash(buildSystemPrompt(STRICT_SEO_PROFILE)),
    );
  });
});
