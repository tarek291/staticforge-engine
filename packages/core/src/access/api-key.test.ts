import { describe, expect, test } from "vitest";

import {
  API_KEY_LENGTH,
  API_KEY_PREFIX,
  apiKeyPrincipalId,
  generateApiKeySecret,
  hashApiKey,
  hashesMatch,
  isApiKeyPrincipal,
  isWellFormedApiKey,
  readBearerToken,
  redactApiKey,
} from "./api-key.js";

/**
 * The key format and its hash.
 *
 * A credential is one of the few things where a weakness is silent by
 * construction: everything keeps working, and the only observer who notices is
 * the one exploiting it. So the tests here are mostly about what a key must
 * *not* be — predictable, reversible, self-describing, or accepted in a form
 * nobody meant to accept.
 */

describe("a minted key is unguessable", () => {
  test("two keys are never the same", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKeySecret()));

    // Not a statistical claim about randomness so much as a smoke test for the
    // failure that actually happens: a generator wired to a constant, a seeded
    // PRNG, or a value cached at module load.
    expect(keys.size).toBe(500);
  });

  test("it carries the scannable prefix", () => {
    // Fixed and greppable, which is what lets GitHub secret scanning and a
    // company's own log scrubbers recognise one on sight.
    expect(generateApiKeySecret().startsWith(API_KEY_PREFIX)).toBe(true);
  });

  test("it is long enough to be worth 256 bits", () => {
    const key = generateApiKeySecret();

    expect(key).toHaveLength(API_KEY_LENGTH);
    expect(key.length - API_KEY_PREFIX.length).toBeGreaterThanOrEqual(43);
  });

  test("it survives a header and a URL without escaping", () => {
    // base64url, so no `+`, `/` or `=`. A key that had to be escaped would be a
    // key some client eventually fails to escape.
    for (let i = 0; i < 50; i += 1) {
      expect(generateApiKeySecret()).toMatch(/^sf_org_[A-Za-z0-9_-]+$/);
    }
  });

  test("it does not contain the organization it grants", () => {
    // Asserted as a property of the *format*: nothing is passed in, so nothing
    // about a tenant can come out. A key carrying its own organization invites
    // code that reads the tenant out of the credential rather than out of the
    // row it resolves to, and that reader turns a forged prefix into a tenant
    // crossing.
    expect(generateApiKeySecret.length).toBe(0);
  });
});

describe("the hash is what gets stored", () => {
  test("hashing is deterministic, or a stored key could never be found", () => {
    const key = generateApiKeySecret();

    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  test("different keys hash differently", () => {
    expect(hashApiKey(generateApiKeySecret())).not.toBe(
      hashApiKey(generateApiKeySecret()),
    );
  });

  test("the hash does not contain the key", () => {
    const key = generateApiKeySecret();
    const hash = hashApiKey(key);

    // The point of storing it. A hash that embedded any of the secret would
    // make a database dump a list of partially-recovered credentials.
    expect(hash).not.toContain(key);
    expect(hash).not.toContain(key.slice(API_KEY_PREFIX.length));
    expect(hash).not.toContain(API_KEY_PREFIX);
  });

  test("it is hex of a fixed width, so the column and the index are stable", () => {
    expect(hashApiKey(generateApiKeySecret())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("one changed character changes the whole hash", () => {
    const key = generateApiKeySecret();
    const tampered = `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`;

    expect(hashApiKey(tampered)).not.toBe(hashApiKey(key));
  });
});

describe("what is not a key", () => {
  test("the wrong prefix is refused", () => {
    const key = generateApiKeySecret();

    expect(isWellFormedApiKey(`sk_live_${key.slice(7)}`)).toBe(false);
    expect(isWellFormedApiKey(key.slice(1))).toBe(false);
  });

  test("the wrong length is refused", () => {
    expect(isWellFormedApiKey(`${generateApiKeySecret()}x`)).toBe(false);
    expect(isWellFormedApiKey(generateApiKeySecret().slice(0, -1))).toBe(false);
    expect(isWellFormedApiKey(API_KEY_PREFIX)).toBe(false);
  });

  test("non-strings are refused rather than coerced", () => {
    for (const value of [undefined, null, 0, {}, [], true]) {
      expect(isWellFormedApiKey(value)).toBe(false);
    }
  });

  test("a real key is accepted", () => {
    expect(isWellFormedApiKey(generateApiKeySecret())).toBe(true);
  });
});

describe("reading the Authorization header", () => {
  test("it takes the credential after Bearer", () => {
    expect(readBearerToken("Bearer sf_org_abc")).toBe("sf_org_abc");
  });

  test("the scheme is case-insensitive, as RFC 7235 requires", () => {
    expect(readBearerToken("bearer sf_org_abc")).toBe("sf_org_abc");
    expect(readBearerToken("BEARER sf_org_abc")).toBe("sf_org_abc");
  });

  test("an absent header is nothing, not an empty credential", () => {
    expect(readBearerToken(null)).toBeUndefined();
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken("")).toBeUndefined();
  });

  test("a bearer header with no credential is nothing", () => {
    // A client that failed to interpolate its key. Treating the empty string as
    // a value that might match is how a misconfiguration becomes an
    // authentication.
    expect(readBearerToken("Bearer")).toBeUndefined();
    expect(readBearerToken("Bearer ")).toBeUndefined();
    expect(readBearerToken("Bearer    ")).toBeUndefined();
  });

  test("another scheme is not a bearer token", () => {
    expect(readBearerToken("Basic c2VjcmV0")).toBeUndefined();
    expect(readBearerToken("sf_org_abc")).toBeUndefined();
  });
});

describe("comparing hashes", () => {
  test("equal hashes match", () => {
    const hash = hashApiKey(generateApiKeySecret());

    expect(hashesMatch(hash, hash)).toBe(true);
  });

  test("different hashes do not", () => {
    expect(
      hashesMatch(hashApiKey("a"), hashApiKey("b")),
    ).toBe(false);
  });

  test("different lengths are refused rather than thrown on", () => {
    // `timingSafeEqual` throws on a length mismatch, and a thrown exception is
    // itself an observable difference — a cruder timing signal than the one the
    // function exists to avoid.
    expect(() => hashesMatch("abc", "abcd")).not.toThrow();
    expect(hashesMatch("abc", "abcd")).toBe(false);
  });
});

describe("a key is a principal the role gate already understands", () => {
  test("its id is namespaced away from people", () => {
    expect(apiKeyPrincipalId("key_1")).toBe("apikey:key_1");
    expect(isApiKeyPrincipal("apikey:key_1")).toBe(true);
  });

  test("a person is not mistaken for a key", () => {
    expect(isApiKeyPrincipal("local-operator")).toBe(false);
    expect(isApiKeyPrincipal("alice@example.com")).toBe(false);
  });
});

describe("redaction", () => {
  test("a key never appears in the redacted form", () => {
    const key = generateApiKeySecret();
    const redacted = redactApiKey(key);

    expect(redacted).not.toContain(key.slice(API_KEY_PREFIX.length));
    expect(redacted).toBe(`${API_KEY_PREFIX}…`);
  });

  test("not even the last few characters", () => {
    const key = generateApiKeySecret();

    // A suffix feels harmless and is not: it narrows the search space and,
    // across enough log lines, identifies the key.
    expect(redactApiKey(key)).not.toContain(key.slice(-4));
  });

  test("something that is not ours says so, which is a different conversation", () => {
    expect(redactApiKey("hunter2")).toBe("(not a StaticForge API key)");
  });
});
