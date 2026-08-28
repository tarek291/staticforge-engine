/**
 * Deciding whether this process will connect to an address.
 *
 * Two features now hand a URL to the engine and ask it to make a request: the
 * sync layer fetches a sheet, and the build trigger posts to a deploy hook.
 * Both are the same shape of risk and were about to grow the same check twice.
 *
 * That is worth avoiding for the usual reason. Two copies of a guard are two
 * guards until the first time someone relaxes one — and the one that gets
 * relaxed is always the one whose caller looked safe at the time.
 */

/** Why an address was refused. */
export interface OutboundUrlRefusal {
  ok: false;
  message: string;
}

/** An address this process will connect to. */
export interface OutboundUrlAllowed {
  ok: true;
  url: URL;
}

export type OutboundUrlCheck = OutboundUrlAllowed | OutboundUrlRefusal;

/**
 * Whether a hostname names the machine itself or a network only it can reach.
 *
 * Hostname-based, and therefore deliberately incomplete: a public name that
 * *resolves* to a private address passes this, and closing that gap needs
 * resolution before connection and a socket-level hook to stop a redirect
 * landing somewhere else. This refuses the direct cases and does not pretend to
 * be more — an honest partial guard being easier to reason about than one whose
 * limits are undocumented.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();

  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host === "::1"
  );
}

/**
 * Check an address before connecting to it.
 *
 * ## Why this exists
 *
 * A URL that reaches this engine is fetched *by the server*, from wherever the
 * server sits. That is the shape of a server-side request forgery: an address
 * pointing at `localhost`, at a private range, or at a cloud metadata endpoint
 * asks this process to reach something the caller could not reach themselves.
 *
 * Some of the URLs checked here come from an operator's own environment and are
 * trusted today. The check is applied to them anyway, because "this value is
 * trusted" is a property of who sets it, and the set of people who can set it
 * grows the first time a URL becomes a field on a form. A guard written before
 * that happens is a guard nobody has to remember to add.
 *
 * @param raw - The candidate address.
 * @param subject - What the address is for, used in the refusal message so an
 * operator reading a log knows which setting to fix.
 */
export function checkOutboundUrl(raw: string, subject = "this URL"): OutboundUrlCheck {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `${subject} is not a URL: "${raw}".` };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      message: `Refusing ${url.protocol} for ${subject} — only http and https are used.`,
    };
  }

  if (isPrivateHostname(url.hostname)) {
    return {
      ok: false,
      message:
        `Refusing "${url.hostname}" for ${subject}: it is a loopback or private ` +
        `address. This request is made by the server, so pointing one inward is ` +
        `how an internal service gets reached from outside.`,
    };
  }

  return { ok: true, url };
}

/**
 * Render a URL for a log line, without its secrets.
 *
 * A deploy hook is a capability URL: the path and the query *are* the
 * credential, and anyone holding one can trigger a production deploy. So the
 * origin is logged and the rest is not. Writing the whole URL into a job log
 * that a dashboard renders — and that an operator pastes into a support
 * thread — would publish it.
 */
export function redactUrl(url: URL): string {
  return `${url.origin}/…`;
}
