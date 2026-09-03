/**
 * Which page paths require a signed-in person.
 *
 * Pure, and separate from the middleware that applies it, for the usual reason:
 * a rule written inside a Next.js middleware can only be tested by standing up
 * Next.js, and a rule that is hard to test gets one test instead of ten. The
 * middleware is glue over this.
 *
 * ## What this is not
 *
 * It is not the API's authorisation. Every API route authenticates itself
 * (Phase 29) and would refuse an unauthenticated call whatever this said. This
 * decides where to *send a browser* — a redirect to a sign-in page instead of a
 * shell rendered for nobody.
 *
 * Getting it wrong is therefore a usability failure rather than a security one,
 * and that asymmetry is worth keeping in mind: the temptation with page guards
 * is to treat them as the boundary, and then to relax an API check because "the
 * middleware already covers it". The middleware covers navigation. It covers
 * nothing that arrives without following a link.
 */

/** Page prefixes that need a session. */
export const PROTECTED_PREFIXES: readonly string[] = ["/dashboard"];

/** Where an unauthenticated browser is sent. */
export const LOGIN_PATH = "/login";

/**
 * Whether a path needs a signed-in person.
 *
 * Prefix matching on a path *segment*, not on a string. `/dashboards-public`
 * starts with `/dashboard` and is a different page; a naive `startsWith` would
 * protect it by accident today and, worse, would silently stop protecting
 * `/dashboard` the day somebody renames the prefix and forgets the slash.
 */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** What the middleware should do with one request. */
export interface PageGuardDecision {
  /** Whether to send the browser to the sign-in page. */
  redirect: boolean;
  /** Where to, when redirecting. */
  location?: string;
}

/**
 * Decide whether a browser may proceed.
 *
 * @param pathname - The path being requested.
 * @param hasSession - Whether a *verified* session was found. The caller must
 * have verified it: this function trusts the boolean, and a caller that passed
 * the result of decoding a cookie rather than checking it would make the whole
 * guard decorative.
 * @param returnTo - Whether to remember where the browser was going.
 */
export function decidePageAccess(
  pathname: string,
  hasSession: boolean,
  returnTo = true,
): PageGuardDecision {
  if (!isProtectedPath(pathname) || hasSession) {
    return { redirect: false };
  }

  // The destination travels as a query parameter so signing in returns the
  // person to the page they asked for. Only a path is ever carried — never a
  // full URL — because a redirect target a caller controls is an open redirect,
  // and "log in here, then we will send you to this other site" is a phishing
  // flow that looks exactly like a working one.
  const target = returnTo && pathname !== LOGIN_PATH ? pathname : undefined;

  return {
    redirect: true,
    location:
      target === undefined
        ? LOGIN_PATH
        : `${LOGIN_PATH}?next=${encodeURIComponent(target)}`,
  };
}

/**
 * Read a `next=` destination back, refusing anything that leaves this origin.
 *
 * A path, starting with a single `/`. Not `//evil.com` — which a browser reads
 * as a protocol-relative *absolute* URL — and not `/\evil.com`, which some
 * parsers normalise the same way. Both look like paths and are not.
 *
 * @returns The safe path, or `undefined` when there is nothing usable.
 */
export function safeReturnPath(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }

  if (!value.startsWith("/")) {
    return undefined;
  }

  if (value.startsWith("//") || value.startsWith("/\\")) {
    return undefined;
  }

  return value;
}
