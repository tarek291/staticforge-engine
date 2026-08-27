import { describe, expect, test } from "vitest";

import {
  AI_MS_PER_PAGE,
  BASE_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TEMPLATE_MS_PER_PAGE,
  computeCommandTimeoutMs,
  describeBudget,
} from "./job-budget.js";

/**
 * The budget exists because a flat ten-minute limit killed every real
 * authoring run — the job system was built to allow work longer than a request,
 * and the timeout forbade exactly that work. These tests are mostly about the
 * sizes that used to fail.
 */

const MINUTE = 60_000;

describe("computeCommandTimeoutMs", () => {
  test("a run with no pages still gets the base allowance", () => {
    expect(computeCommandTimeoutMs({ pageCount: 0, aiEnabled: false })).toBe(
      BASE_TIMEOUT_MS,
    );
  });

  test("grows with the number of pages", () => {
    const small = computeCommandTimeoutMs({ pageCount: 10, aiEnabled: true });
    const large = computeCommandTimeoutMs({ pageCount: 200, aiEnabled: true });

    expect(large).toBeGreaterThan(small);
  });

  test("authoring costs far more per page than templating", () => {
    // One paced provider call per page against an in-memory string build.
    const authored = computeCommandTimeoutMs({ pageCount: 100, aiEnabled: true });
    const templated = computeCommandTimeoutMs({
      pageCount: 100,
      aiEnabled: false,
    });

    expect(authored).toBeGreaterThan(templated);
    expect(AI_MS_PER_PAGE).toBeGreaterThan(TEMPLATE_MS_PER_PAGE);
  });

  test("the 200-page authoring run the flat limit used to kill now fits", () => {
    // The audit's worked example: pacing alone is 10 minutes before a single
    // token of latency, so a ten-minute ceiling could never have held it.
    const budget = computeCommandTimeoutMs({ pageCount: 200, aiEnabled: true });

    expect(budget).toBeGreaterThan(10 * MINUTE);
    expect(budget).toBe(BASE_TIMEOUT_MS + 200 * AI_MS_PER_PAGE);
  });

  test("the 500-page run the job system was built for fits too", () => {
    const budget = computeCommandTimeoutMs({ pageCount: 500, aiEnabled: true });

    expect(budget).toBeGreaterThan(2 * 60 * MINUTE);
    expect(budget).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
  });

  test("is capped, so a stuck run cannot pin a worker forever", () => {
    expect(
      computeCommandTimeoutMs({ pageCount: 1_000_000, aiEnabled: true }),
    ).toBe(MAX_TIMEOUT_MS);
  });

  test("a nonsensical page count degrades to the base allowance", () => {
    // Never a crash and never an unbounded wait: the count arrives from a
    // database read that may legitimately have failed.
    for (const pageCount of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        computeCommandTimeoutMs({ pageCount, aiEnabled: true }),
      ).toBeGreaterThanOrEqual(BASE_TIMEOUT_MS);
    }

    expect(computeCommandTimeoutMs({ pageCount: -5, aiEnabled: true })).toBe(
      BASE_TIMEOUT_MS,
    );
  });

  test("fractional counts are truncated rather than rejected", () => {
    expect(computeCommandTimeoutMs({ pageCount: 2.9, aiEnabled: false })).toBe(
      BASE_TIMEOUT_MS + 2 * TEMPLATE_MS_PER_PAGE,
    );
  });
});

describe("describeBudget", () => {
  test("reads as minutes below an hour", () => {
    expect(describeBudget(5 * MINUTE)).toBe("5m");
    expect(describeBudget(45 * MINUTE)).toBe("45m");
  });

  test("reads as hours and minutes above one", () => {
    expect(describeBudget(60 * MINUTE)).toBe("1h00m");
    expect(describeBudget(105 * MINUTE)).toBe("1h45m");
  });

  test("describes a real 500-page authoring budget legibly", () => {
    const budget = computeCommandTimeoutMs({ pageCount: 500, aiEnabled: true });

    expect(describeBudget(budget)).toMatch(/^\d+h\d{2}m$/);
  });
});
