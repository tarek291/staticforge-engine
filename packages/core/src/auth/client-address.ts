/**
 * Working out who is knocking, for the purpose of rate limiting them.
 *
 * ## Why this is not the same as "the client's IP"
 *
 * A server behind a proxy does not see the caller's address; it sees the
 * proxy's, and the real one arrives in a header the proxy added. Headers are
 * caller-controllable by default, so a request that has *not* passed through
 * your proxy can carry any `X-Forwarded-For` it likes.
 *
 * That matters more than it sounds. A limiter keyed on a forgeable string is
 * not a limiter: an attacker sends a different value each time, gets a fresh
 * bucket each time, and the limit binds nobody except the honest users who send
 * their real address. It is worse than having no limiter, because it is
 * reported as protection.
 *
 * ## What is done about it
 *
 * Two things, and the second is the one that actually holds.
 *
 * The address is read from the *rightmost* entry of `X-Forwarded-For` rather
 * than the leftmost. Each proxy appends, so the last entry is the one written
 * by the hop closest to this server — the only entry a caller cannot choose. The
 * leftmost is the "real client IP" every tutorial reaches for and is precisely
 * the forgeable one.
 *
 * And the caller of this pairs the per-address bucket with a **global** one,
 * which has no key derived from the request at all and therefore cannot be
 * evaded by any header. The per-address bucket stops one machine hammering an
 * endpoint; the global bucket bounds what a botnet can do. Neither alone is
 * enough, and the global one is the honest backstop for everything this
 * function cannot promise.
 *
 * ## Why not key on the email instead
 *
 * Because that is a denial of service wearing a hat. Anyone could lock a named
 * user out of their own account by failing on their behalf, and the endpoint
 * would be handing out a way to do it to whoever asked.
 */

/**
 * Headers that may carry a forwarded address, most trustworthy first.
 *
 * The single-value headers come first because a proxy that sets one sets it
 * itself, with no list for a caller to prepend to.
 */
export const FORWARDED_HEADERS: readonly string[] = [
  // Set by the platform edge, not appended to. Vercel and most CDNs.
  "x-real-ip",
  "cf-connecting-ip",
  // A list. Read from the right — see the note above.
  "x-forwarded-for",
];

/** What an unidentifiable caller is bucketed as. */
export const UNKNOWN_CLIENT = "unknown";

/**
 * The address to rate limit a request against.
 *
 * @param headers - The request's headers.
 * @returns An address, or {@link UNKNOWN_CLIENT} when none is present.
 *
 * Every unidentifiable caller shares one bucket, deliberately. The alternative
 * — letting a request with no address through unlimited — would mean the way
 * past the limiter is to send fewer headers, which is not a bar worth calling
 * one.
 */
export function clientAddress(headers: {
  get: (name: string) => string | null;
}): string {
  for (const header of FORWARDED_HEADERS) {
    const raw = headers.get(header);

    if (raw === null || raw.trim() === "") {
      continue;
    }

    // Rightmost, not leftmost. Each proxy appends its view of who called it, so
    // the last entry was written by the hop nearest this server and is the only
    // one the original caller could not have chosen. Taking the first entry —
    // the usual mistake — reads a value the caller supplied.
    const parts = raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");

    const candidate = parts[parts.length - 1];

    if (candidate !== undefined) {
      return candidate;
    }
  }

  return UNKNOWN_CLIENT;
}

/**
 * How hard sign-in may be attempted.
 *
 * Sized for a person, not for an integration. Ten attempts lets somebody try a
 * few passwords, mistype one, and come back — and one every twenty seconds
 * sustained is far below what a credential-stuffing run needs to be worth
 * running, while being far above anything a real person does.
 */
export const LOGIN_RATE_LIMIT = Object.freeze({
  /** Attempts one address may burst. */
  perAddressBurst: 10,
  /** Attempts per second it earns back. One every twenty seconds. */
  perAddressRefillPerSec: 0.05,
  /**
   * Attempts everyone together may burst.
   *
   * The backstop, and the only part a forged header cannot get around. Loose
   * enough that a busy morning at a real customer never touches it; tight
   * enough that a distributed run is metered rather than unbounded.
   */
  globalBurst: 200,
  /** Attempts per second the global bucket earns back. */
  globalRefillPerSec: 2,
} as const);

/** The bucket a single caller is counted in. */
export function loginRateLimitKey(address: string): string {
  return `auth:login:addr:${address}`;
}

/** The bucket every caller is counted in, whatever they claim to be. */
export const LOGIN_GLOBAL_RATE_LIMIT_KEY = "auth:login:global";
