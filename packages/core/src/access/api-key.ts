import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The shape of an API key, and how it becomes a hash.
 *
 * Pure and side-effect free: no database, no clock, no I/O. Keeping the format
 * and the hashing here means the CLI that mints a key, the route that verifies
 * one, and the tests that check both are all looking at the same definition —
 * rather than three implementations that agree until one of them is "fixed".
 *
 * ## What the key deliberately does not contain
 *
 * Not the organization id. A credential that carries the identity it grants is
 * a credential that leaks that identity to anyone who sees it in a log line, a
 * bug report or a screenshot — and, worse, it invites code that reads the
 * tenant *out of the key* rather than out of the row the key resolves to. The
 * first such reader turns a forged prefix into a tenant crossing.
 *
 * So the key is a prefix and 256 bits of randomness. Which organization it
 * belongs to is a fact stored in the database, discoverable only by presenting
 * the key.
 */

/**
 * The fixed prefix every organization key carries.
 *
 * Fixed, and therefore greppable. A stable prefix is what lets GitHub's secret
 * scanning, `git-secrets` and a company's own log scrubbers recognise one of
 * these on sight — which is the difference between a key leaked into a public
 * repository being revoked within the hour and it being found by whoever looks
 * for it first.
 *
 * `org` names the *kind* of principal, not a particular one: this is a key that
 * acts as an organization, as distinct from a future key that acts as a user.
 */
export const API_KEY_PREFIX = "sf_org_";

/** Bytes of randomness behind each key. */
export const API_KEY_ENTROPY_BYTES = 32;

/**
 * Characters in the random part, for a base64url encoding of 32 bytes.
 *
 * Derived rather than written down, so changing the entropy cannot leave a
 * length check quietly asserting the old size.
 */
export const API_KEY_SECRET_LENGTH = Math.ceil((API_KEY_ENTROPY_BYTES * 4) / 3);

/** Total characters in a well-formed key. */
export const API_KEY_LENGTH = API_KEY_PREFIX.length + API_KEY_SECRET_LENGTH;

/**
 * Mint a new plaintext key.
 *
 * `randomBytes` rather than `Math.random`: the latter is a seeded PRNG whose
 * output is predictable from a few samples, and a credential an attacker can
 * predict is not a credential. base64url so the value survives a header, a URL
 * and a shell without escaping.
 *
 * @returns The plaintext key. The only time it will ever exist.
 */
export function generateApiKeySecret(): string {
  return API_KEY_PREFIX + randomBytes(API_KEY_ENTROPY_BYTES).toString("base64url");
}

/**
 * Hash a key for storage and lookup.
 *
 * Unsalted, deliberately. A salt exists to stop one precomputed table breaking
 * every stored secret at once, which matters when the secrets are human-chosen
 * and share a small space. There is no table that covers 2^256, and a salted
 * hash could not be looked up by index — verification would become a scan of
 * every row with a comparison each.
 *
 * @param rawKey - The plaintext key, exactly as presented.
 * @returns Lowercase hex.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

/**
 * Whether a value even looks like one of our keys.
 *
 * Checked before the database is touched, so a scanner spraying arbitrary
 * `Authorization` headers costs a string comparison rather than a query. It is
 * a cheap filter and explicitly *not* a security boundary — a well-formed key
 * is still worthless until it resolves to a row.
 */
export function isWellFormedApiKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === API_KEY_LENGTH &&
    value.startsWith(API_KEY_PREFIX)
  );
}

/**
 * Read a bearer credential out of an `Authorization` header.
 *
 * Case-insensitive on the scheme, because RFC 7235 says the scheme is, and a
 * client sending `bearer` is correct even though it is unusual.
 *
 * @returns The credential, or `undefined` when the header is absent or is not a
 * bearer header. An empty credential is `undefined` too: `Bearer ` with nothing
 * after it is a client that failed to interpolate its key, and treating the
 * empty string as a value it might match is how a misconfiguration becomes an
 * authentication.
 */
export function readBearerToken(header: string | null | undefined): string | undefined {
  if (typeof header !== "string") {
    return undefined;
  }

  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();

  return token === undefined || token === "" ? undefined : token;
}

/**
 * Compare two hashes without leaking where they differ.
 *
 * The hashes compared here are derived from a 256-bit secret, so a timing
 * oracle on this comparison is not a practical route to forging one. It is
 * constant-time anyway, because the cost is a few microseconds and the habit is
 * what stops the next comparison — over something guessable — being written
 * with `===`.
 *
 * Length is checked first and separately: `timingSafeEqual` throws on a
 * mismatch, and a thrown exception is itself an observable difference.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The principal id an API key acts as.
 *
 * A key is a member of its organization in exactly the way a person is, so it
 * gets an identity the existing authorisation gate already understands. That is
 * what lets a key be checked by `requireCapability` rather than by a second,
 * parallel permission path — and a second path is how one of them ends up
 * missing a check.
 *
 * The `apikey:` prefix keeps them distinguishable from people wherever members
 * are listed, and cannot collide with a real user id for the same reason a
 * colon cannot appear in one.
 */
export function apiKeyPrincipalId(apiKeyId: string): string {
  return `apikey:${apiKeyId}`;
}

/** Whether a principal id names an API key rather than a person. */
export function isApiKeyPrincipal(userId: string): boolean {
  return userId.startsWith("apikey:");
}

/**
 * Render a presented credential for a log line or an error message.
 *
 * Never the value, and never part of it. The prefix alone is enough to convey
 * the only thing a log needs — whether this was one of ours — and a log that
 * echoed the key, or even its last few characters, would put working key
 * material into the one place people paste freely.
 *
 * The two outcomes are worth distinguishing when reading a log: "a
 * StaticForge key that did not work" usually means revoked or rotated, while
 * "not one of ours" usually means a client sending the wrong credential
 * entirely, and those lead to different conversations.
 */
export function redactApiKey(value: unknown): string {
  return isWellFormedApiKey(value)
    ? `${API_KEY_PREFIX}…`
    : "(not a StaticForge API key)";
}
