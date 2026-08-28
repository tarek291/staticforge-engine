import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readBearerToken } from "../access/api-key.js";

/**
 * Proving which *person* is calling.
 *
 * Phase 23 decided what a principal may do. Phase 25 let a machine prove which
 * organization it was. Neither established who a human is: `userId` arrived as
 * a string the caller chose, so the whole authorisation model rested on an
 * assertion nobody checked.
 *
 * This is the check. A session token is verified by the identity provider that
 * issued it, and the id that comes back is the one the role gate is asked about.
 *
 * ## Why verification is delegated
 *
 * Supabase mints these tokens and holds the signing keys. Verifying one here
 * would mean re-implementing JWT validation — signature, issuer, audience,
 * expiry, and the key rotation behind all four — to arrive at an answer the
 * provider will give for the cost of one call. Every home-grown copy of that
 * check is one algorithm confusion bug away from accepting anything, and the
 * bug is invisible until somebody looks for it.
 *
 * The cost is a network round trip on the authenticated path. That is worth
 * paying now and worth revisiting with local JWKS verification later — as an
 * optimisation, deliberately taken, rather than as the default nobody chose.
 *
 * ## Why the client is injected
 *
 * The same reason every other boundary here is: so the guard can be exercised
 * against a double with no network and no project. A test that needed a live
 * Supabase to prove an empty token is refused is a test nobody runs.
 */

/** Raised when a caller cannot be identified. */
export class UnauthorizedError extends Error {
  override readonly name = "UnauthorizedError";

  /**
   * Why, for a log line — never for a response body.
   *
   * Absent, malformed, expired and unknown are four things internally and must
   * be one thing to a caller, for the reason the API-key path gives: three
   * extra messages are three bits handed to whoever is guessing.
   */
  readonly detail: string;

  constructor(detail: string) {
    super("Unauthorized.");
    this.detail = detail;
  }
}

/** A person, as a verified session describes them. */
export interface SessionUser {
  /** The identity provider's id. This is what `userId` must be. */
  id: string;
  email: string;
  name: string | null;
}

/** The single call this module needs from Supabase. */
export interface SessionVerifier {
  auth: {
    getUser: (token: string) => Promise<{
      data: { user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> } | null };
      error: { message: string } | null;
    }>;
  };
}

/** Environment variables naming the Supabase project. */
export const SUPABASE_URL_ENV_VAR = "SUPABASE_URL";
export const SUPABASE_ANON_KEY_ENV_VAR = "SUPABASE_ANON_KEY";

/**
 * Build a verifier from the environment.
 *
 * @returns The client, or `undefined` when the project is not configured. The
 * absence is returned rather than thrown so a caller can decide: a local run
 * legitimately has no Supabase project, while a deployed server with no
 * identity provider is a server that must refuse every request rather than
 * start and accept them.
 */
export function createSessionVerifier(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseClient | undefined {
  const url = env[SUPABASE_URL_ENV_VAR]?.trim();
  const key = env[SUPABASE_ANON_KEY_ENV_VAR]?.trim();

  if (url === undefined || url === "" || key === undefined || key === "") {
    return undefined;
  }

  return createClient(url, key, {
    auth: {
      // A server verifying someone else's token has no session of its own to
      // keep. Persisting or refreshing one would make concurrent requests share
      // mutable auth state, which is how one caller ends up answered as another.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/**
 * Verify a session token and return the person it belongs to.
 *
 * @param token - The raw token, or an `Authorization` header value — both are
 * accepted, because every caller has one or the other and a helper that took
 * only one guarantees somebody strips the scheme by hand and gets it wrong.
 * @param verifier - The identity provider. Injected so this is testable.
 * @throws {UnauthorizedError} If the token is absent, malformed, expired,
 * rejected, or resolves to no user.
 */
export async function verifyUserSession(
  token: unknown,
  verifier: SessionVerifier,
): Promise<SessionUser> {
  const raw = normaliseToken(token);

  if (raw === undefined) {
    // Refused before the provider is called. An empty or absent token cannot
    // become valid, and spending a network round trip to be told so turns an
    // unauthenticated request into load on someone else's service.
    throw new UnauthorizedError("No bearer token was supplied.");
  }

  let result: Awaited<ReturnType<SessionVerifier["auth"]["getUser"]>>;

  try {
    result = await verifier.auth.getUser(raw);
  } catch (error: unknown) {
    // A provider that is unreachable is not a caller who is authorised. This
    // is the one place a fail-open would be tempting — an outage would lock
    // everybody out — and it is exactly where it must not happen.
    throw new UnauthorizedError(
      `The identity provider could not be reached: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (result.error !== null) {
    throw new UnauthorizedError(`The identity provider rejected the token: ${result.error.message}`);
  }

  const user = result.data.user;

  if (user === null || user === undefined) {
    // A response with no error and no user. Treated as a refusal rather than
    // as a shape to reason about: an SDK that answers this way has told us
    // nothing, and nothing is not an identity.
    throw new UnauthorizedError("The token resolved to no user.");
  }

  const email = typeof user.email === "string" ? user.email.trim() : "";

  if (email === "") {
    // The email is the natural key a `User` row is stored under, and it is
    // unique. A verified session without one cannot be reconciled to a row, and
    // inventing an address would create a second identity for the same person.
    throw new UnauthorizedError(`The verified user ${user.id} has no email address.`);
  }

  const name = user.user_metadata?.["name"] ?? user.user_metadata?.["full_name"];

  return {
    id: user.id,
    email,
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : null,
  };
}

/**
 * Accept either a bare token or a whole `Authorization` header.
 *
 * A header is recognised by its scheme rather than guessed at, so a bare token
 * that happens to contain a space is not silently truncated.
 */
function normaliseToken(token: unknown): string | undefined {
  if (typeof token !== "string") {
    return undefined;
  }

  const trimmed = token.trim();

  if (trimmed === "") {
    return undefined;
  }

  // A word boundary, not a required space. Trimming turns `"Bearer "` into `"Bearer"`, which a
  // space-requiring pattern no longer recognises as a header — so the scheme
  // name itself would fall through and be sent to the provider as though it
  // were the credential. Matching on the word boundary means a bare `Bearer`
  // is still a header, and `readBearerToken` correctly finds nothing in it.
  if (/^Bearer\b/i.test(trimmed)) {
    return readBearerToken(trimmed);
  }

  return trimmed;
}
