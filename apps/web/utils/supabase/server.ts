import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { readServerEnv } from "@/lib/env";

/**
 * A Supabase client bound to this request's cookies.
 *
 * The browser half of authentication. Phase 25 gave machines a credential and
 * Phase 27 gave the server a way to verify a bearer token; neither gave a
 * person a way to *hold* a session. This is that: `@supabase/ssr` keeps the
 * access and refresh tokens in cookies, reads them on every server render, and
 * writes rotated ones back.
 *
 * ## Why a new client per request
 *
 * It closes over one request's cookie store. A module-scope singleton would
 * share that store between concurrent requests, which is how one caller ends
 * up answered as another — the worst bug this file could have, and a silent
 * one.
 *
 * ## Why `getUser()` and never `getSession()`
 *
 * `getSession()` reads the cookie and decodes it. It does not verify anything,
 * so on a server it answers with whatever the client sent — and a cookie is
 * something the client controls. `getUser()` revalidates the token against the
 * auth server and is the only one of the two that constitutes a check.
 *
 * The cost is a round trip per call, which is the same trade Phase 27 took for
 * bearer tokens and is worth revisiting with local JWKS verification later, as
 * an optimisation someone chooses rather than a default nobody noticed.
 */

/**
 * Build a request-scoped client.
 *
 * @throws {ServerEnvError} When the Supabase project is not configured. The
 * throw propagates so a caller can tell "our deployment is broken" from "your
 * credential is bad" — a `500` and a `401` are different answers and only one
 * of them is the caller's problem.
 */
export async function createClient(): Promise<SupabaseClient> {
  const env = readServerEnv();
  const cookieStore = await cookies();

  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Thrown when a Server Component tries to write. That is expected and
          // harmless: middleware refreshes the session on every request, so the
          // rotated cookie is already on its way to the browser and this call
          // had nothing left to do. Swallowing it here is what keeps a render
          // from failing over a write it did not need to make.
        }
      },
    },
  });
}

/**
 * The person this request's cookies identify, or `null`.
 *
 * Never throws for an absent or bad session — that is an ordinary outcome and
 * the caller decides what it means. A missing *configuration* still throws,
 * because that is not an ordinary outcome.
 */
export async function readCookieUser(): Promise<{
  id: string;
  email: string;
  name: string | null;
} | null> {
  const supabase = await createClient();

  // `getUser`, not `getSession`. See the note above: one of them is a check and
  // the other is a decode.
  const { data, error } = await supabase.auth.getUser();

  if (error !== null || data.user === null) {
    return null;
  }

  const email = typeof data.user.email === "string" ? data.user.email.trim() : "";

  if (email === "") {
    // The email is the unique key a `User` row is stored under. A verified
    // session without one cannot be reconciled to a row, and inventing an
    // address would create a second identity for the same person.
    return null;
  }

  const metadata = data.user.user_metadata as Record<string, unknown> | undefined;
  const name = metadata?.["name"] ?? metadata?.["full_name"];

  return {
    id: data.user.id,
    email,
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : null,
  };
}
