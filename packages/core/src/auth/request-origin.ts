/**
 * Refusing a mutation the browser was tricked into sending.
 *
 * ## Why `SameSite=Lax` is not enough on its own
 *
 * It reads like it is. A `Lax` cookie is not sent on a cross-*site* POST, so the
 * classic hidden-form attack from `evil.test` is already dead.
 *
 * The gap is that "site" is not "origin". `SameSite` compares **registrable
 * domains**, so `blog.example.com`, `staging.example.com` and `app.example.com`
 * are all one site — and a POST from any of them to any other is *same-site*,
 * which means the cookie is attached. Anyone who can put content on a sibling
 * subdomain can therefore forge authenticated mutations against the app: a
 * marketing page on a shared domain, a customer-controlled subdomain, an old
 * staging host somebody forgot, a subdomain takeover of a dangling DNS record.
 *
 * None of those are exotic, and each one turns a cookie session into a
 * capability the attacker can spend.
 *
 * ## Why this checks `Origin` and not `Referer`
 *
 * `Origin` is sent by every browser on cross-origin requests and on all
 * non-`GET` requests, it cannot be set by page JavaScript, and it carries only
 * the scheme, host and port — no path, so nothing private leaks by checking it.
 * `Referer` is stripped by privacy settings and proxies often enough that a
 * guard built on it has to allow the absent case, which is the case an attacker
 * arranges.
 *
 * ## Why an absent `Origin` is refused rather than allowed
 *
 * Because the whole guard collapses otherwise. If "no `Origin`" means "allow",
 * the attack is to arrange for no `Origin` — and while a browser will not omit
 * it on a cross-origin POST, a guard whose default is *allow* is one bug away
 * from being decorative.
 *
 * This is safe here precisely because it applies to **cookie** callers only. A
 * bearer-token integration is not subject to CSRF at all — an attacker cannot
 * make a browser attach a header it does not know — and requiring an `Origin`
 * from `curl` would break every integration in the product. The distinction is
 * carried on the principal, not guessed from the request.
 *
 * ## Why safe methods are exempt
 *
 * `GET`, `HEAD` and `OPTIONS` are meant to be side-effect free, and a route that
 * mutates on `GET` has a worse problem than this guard can fix. Exempting them
 * also keeps the dashboard's ordinary reads working from any context.
 */

/** Methods that must not change anything, and so need no origin proof. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** Why a request was refused, for a log line. */
export type OriginRefusal =
  /** No `Origin` header on a cookie-authenticated mutation. */
  | "missing-origin"
  /** An `Origin` that is not a parseable absolute URL. */
  | "malformed-origin"
  /** A well-formed `Origin` naming somewhere else. */
  | "foreign-origin"
  /** The server could not work out what it is called. */
  | "unknown-host";

/** The verdict, and enough to explain it. */
export type OriginCheck =
  | { ok: true }
  | { ok: false; reason: OriginRefusal; origin: string | null; expected: string | null };

/** What {@link checkRequestOrigin} needs to know about a request. */
export interface OriginCheckInput {
  /** The HTTP method. */
  method: string;
  /** The `Origin` header, or `null`. */
  origin: string | null;
  /**
   * What this server believes it is called — the `Host` header, or a configured
   * canonical host.
   *
   * Compared as a host, not as a full URL: a deployment behind a proxy sees
   * `http` internally while the browser sent `https`, so comparing schemes would
   * refuse every request on exactly the deployments that need this most.
   */
  host: string | null;
  /**
   * Extra hosts to accept.
   *
   * For a deployment served under more than one name, or a local dashboard
   * developed against a deployed API. Empty by default: an allowlist that
   * starts populated is one nobody reviews.
   */
  allowedHosts?: readonly string[];
}

/** The host part of an `Origin`, or `null` when it is not a usable URL. */
function hostOf(value: string): string | null {
  try {
    const url = new URL(value);

    // `Origin: null` — a sandboxed iframe, a `data:` document, some redirects.
    // It parses as a URL with no host, and it is not this server.
    return url.host === "" ? null : url.host.toLowerCase();
  } catch {
    return null;
  }
}

/** A `Host` header reduced to the same shape an origin's host has. */
function normalizeHost(value: string): string | null {
  const trimmed = value.trim().toLowerCase();

  return trimmed === "" ? null : trimmed;
}

/**
 * Decide whether a cookie-authenticated mutation really came from this app.
 *
 * Call it only for callers who authenticated **by cookie**. A bearer caller is
 * not exposed to this attack and must not be asked for an `Origin` it has no
 * reason to send.
 *
 * @returns `{ ok: true }` for safe methods and for matching origins.
 */
export function checkRequestOrigin(input: OriginCheckInput): OriginCheck {
  if (SAFE_METHODS.has(input.method.toUpperCase())) {
    return { ok: true };
  }

  const expected = input.host === null ? null : normalizeHost(input.host);

  if (expected === null) {
    // Without knowing what this server is called there is nothing to compare
    // against, and "compare against nothing" can only mean allow. Refused
    // instead: a guard that cannot run is not a guard that passes.
    return { ok: false, reason: "unknown-host", origin: input.origin, expected: null };
  }

  if (input.origin === null || input.origin.trim() === "") {
    return { ok: false, reason: "missing-origin", origin: null, expected };
  }

  const actual = hostOf(input.origin);

  if (actual === null) {
    return {
      ok: false,
      reason: "malformed-origin",
      origin: input.origin,
      expected,
    };
  }

  const allowed = new Set<string>([expected]);

  for (const host of input.allowedHosts ?? []) {
    const normalized = normalizeHost(host);

    if (normalized !== null) {
      allowed.add(normalized);
    }
  }

  // Exact host match, including the port. Not a suffix test: `endsWith` on
  // `example.com` would accept `evil-example.com`, and matching the registrable
  // domain would accept the sibling subdomain this whole guard exists to refuse.
  if (!allowed.has(actual)) {
    return { ok: false, reason: "foreign-origin", origin: input.origin, expected };
  }

  return { ok: true };
}

/** Env var naming extra origins a cookie session may post from. */
export const ALLOWED_ORIGINS_ENV_VAR = "STATICFORGE_ALLOWED_ORIGINS";

/**
 * Read the extra-hosts allowlist.
 *
 * Comma separated, and each entry may be a bare host or a full URL — an
 * operator writing `https://app.example.com` should not have to discover that
 * only `app.example.com` was accepted.
 */
export function readAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[ALLOWED_ORIGINS_ENV_VAR];

  if (raw === undefined || raw.trim() === "") {
    return [];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => hostOf(entry) ?? normalizeHost(entry) ?? "")
    .filter((entry) => entry !== "");
}
