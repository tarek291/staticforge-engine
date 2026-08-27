import { describe, expect, test } from "vitest";

import { canonicalize, combineHash, stableHash } from "./hash.js";

/**
 * These fingerprints gate a paid API call. A hash that varies for identical
 * data misses the cache on every run and quietly costs money; a hash that
 * collides for different data serves stale content. Both directions are tested.
 */

describe("canonicalize", () => {
  test("sorts object keys, so insertion order cannot matter", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  test("sorts nested keys too", () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe(
      canonicalize({ outer: { a: 2, z: 1 } }),
    );
  });

  test("preserves array order, which is meaningful", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  test("treats an absent field and an undefined one alike", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  test("handles primitives and null", () => {
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
  });
});

describe("stableHash", () => {
  test("is deterministic", () => {
    expect(stableHash({ a: 1 })).toBe(stableHash({ a: 1 }));
  });

  test("ignores key order", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  test("changes when any value changes", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  test("changes when a nested value changes", () => {
    expect(stableHash({ a: { b: 1 } })).not.toBe(stableHash({ a: { b: 2 } }));
  });

  test("distinguishes a number from its string form", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: "1" }));
  });

  test("returns 16 lowercase hex characters", () => {
    expect(stableHash({ anything: true })).toMatch(/^[0-9a-f]{16}$/);
  });

  test("handles values that are not objects", () => {
    expect(stableHash("plain")).toMatch(/^[0-9a-f]{16}$/);
    expect(stableHash(null)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("combineHash", () => {
  test("is order-sensitive, because the parts are positional", () => {
    expect(combineHash(["a", "b"])).not.toBe(combineHash(["b", "a"]));
  });

  test("cannot be confused by parts that concatenate the same way", () => {
    // Without a separator, ["ab","c"] and ["a","bc"] would collide.
    expect(combineHash(["ab", "c"])).not.toBe(combineHash(["a", "bc"]));
  });

  test("is deterministic", () => {
    expect(combineHash(["x", "y"])).toBe(combineHash(["x", "y"]));
  });
});
