import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authenticating a webhook call.
 *
 * The whole of the check, in one place, because it is the kind of code that
 * looks finished long before it is correct.
 *
 * ## Why not `===`
 *
 * String comparison stops at the first differing byte. An attacker who can time
 * responses can therefore recover a secret one character at a time, which turns
 * an unguessable token into a few thousand requests. `timingSafeEqual` compares
 * every byte regardless — but it throws when the two buffers differ in length,
 * and using it directly would leak the secret's length through that difference.
 * Hashing both sides first fixes both problems at once: the comparison is
 * always over two 32-byte digests, so neither the length nor the content of the
 * supplied token changes how long the answer takes.
 *
 * ## Why an unset secret is a refusal
 *
 * A missing secret must never mean "no check required". This endpoint writes
 * tenant data and queues paid work, so the failure mode of a forgotten
 * environment variable has to be a closed door rather than an open one — and it
 * has to say so, because "unauthorised" for a deployment that simply was not
 * configured is an hour of debugging nobody needs.
 */

/** Environment variable holding the shared webhook secret. */
export const WEBHOOK_SECRET_ENV_VAR = "STATICFORGE_WEBHOOK_SECRET";

/**
 * Shortest secret worth calling one.
 *
 * Not a policy so much as a tripwire: a two-character value in this variable is
 * a placeholder somebody meant to replace, and accepting it would authenticate
 * the whole internet.
 */
export const MIN_SECRET_LENGTH = 16;

/** Why a call was refused. Distinct cases, because they need distinct answers. */
export type WebhookAuthFailure =
  /** The server has no secret configured, so it cannot authenticate anything. */
  | "not-configured"
  /** The configured secret is too short to be meaningful. */
  | "weak-secret"
  /** No `Authorization` header, or one this endpoint does not understand. */
  | "missing-token"
  /** A token was supplied and it is not the right one. */
  | "invalid-token";

/** The verdict on one call. */
export type WebhookAuthResult =
  | { ok: true }
  | { ok: false; reason: WebhookAuthFailure; message: string };

/**
 * Pull the token out of an `Authorization` header.
 *
 * Accepts both `Bearer <token>` and a bare token: the first is what a webhook
 * sender emits by default, the second is what an operator types into `curl`,
 * and refusing the second buys nothing but a support question.
 */
export function extractBearerToken(header: string | null | undefined): string | undefined {
  const value = header?.trim();

  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value);

  if (match !== null) {
    const token = match[1]?.trim() ?? "";
    return token.length === 0 ? undefined : token;
  }

  // No scheme, so the whole value is the token — unless it is the bare scheme
  // with nothing after it, which is a sender that meant to include a secret and
  // did not. Returning "Bearer" there would compare the word against the real
  // secret and, far worse, read as a token having been supplied at all.
  if (/^Bearer$/i.test(value)) {
    return undefined;
  }

  return value;
}

/** Compare two secrets in time that does not depend on their contents. */
function constantTimeEquals(left: string, right: string): boolean {
  // Digest first: `timingSafeEqual` throws on a length mismatch, and letting
  // that happen would leak the real secret's length.
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();

  return timingSafeEqual(a, b);
}

/**
 * Decide whether a webhook call is authentic.
 *
 * @param header - The raw `Authorization` header, or null when absent.
 * @param secret - The configured secret. Undefined when none is set.
 * @returns The verdict, with a reason a caller can turn into a status code.
 */
export function verifyWebhookToken(
  header: string | null | undefined,
  secret: string | undefined,
): WebhookAuthResult {
  const configured = secret?.trim();

  if (configured === undefined || configured.length === 0) {
    return {
      ok: false,
      reason: "not-configured",
      message:
        `This endpoint is not configured. Set ${WEBHOOK_SECRET_ENV_VAR} to a ` +
        `long random value before exposing it. It is refused rather than left ` +
        `open, because it writes tenant data and queues paid work.`,
    };
  }

  if (configured.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      reason: "weak-secret",
      message:
        `${WEBHOOK_SECRET_ENV_VAR} is shorter than ${MIN_SECRET_LENGTH} ` +
        `characters. A value that short is a placeholder, and accepting it ` +
        `would authenticate anyone who guessed it.`,
    };
  }

  const token = extractBearerToken(header);

  if (token === undefined) {
    return {
      ok: false,
      reason: "missing-token",
      message: "Missing Authorization header. Send `Authorization: Bearer <secret>`.",
    };
  }

  if (!constantTimeEquals(token, configured)) {
    // Deliberately the same message as a missing token would deserve: an
    // attacker learns nothing from the difference between "wrong" and "absent".
    return {
      ok: false,
      reason: "invalid-token",
      message: "Invalid credentials.",
    };
  }

  return { ok: true };
}

/** The HTTP status a refusal deserves. */
export function webhookAuthStatus(reason: WebhookAuthFailure): number {
  // A server with no secret is misconfigured, not a client that got it wrong,
  // and 503 says so without implying the caller could fix it by retrying with
  // a different token.
  return reason === "not-configured" || reason === "weak-secret" ? 503 : 401;
}
