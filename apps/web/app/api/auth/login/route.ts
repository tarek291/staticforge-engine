import { z } from "zod";

import { ServerEnvError } from "@/lib/env";
import { createClient } from "@/utils/supabase/server";

/**
 * Exchange an email and password for a session cookie.
 *
 * The only route in this app that is *meant* to be called without a credential,
 * because obtaining one is what it is for. The route-coverage test exempts it
 * by name rather than by pattern, so opening a second unauthenticated endpoint
 * stays a visible edit in a file about authentication.
 *
 * ## Where the session goes
 *
 * Nowhere in the body. `signInWithPassword` hands the tokens to the SSR client,
 * whose cookie adapter writes them onto this response as `HttpOnly` cookies —
 * so the browser holds a session that JavaScript on the page cannot read, and
 * therefore that a cross-site script cannot steal. Returning the access token
 * in JSON, which is the obvious shape for an API, would hand that protection
 * back for the convenience of one client.
 *
 * ## What it will not tell you
 *
 * Whether the email exists. A wrong password and an unknown address get the
 * same answer, because two answers turn this endpoint into a way to enumerate
 * a customer's users — and a list of real addresses is the first half of a
 * credential-stuffing run.
 *
 * ## What it does not have, stated plainly
 *
 * Rate limiting. Phase 24 built a distributed token bucket, and it is keyed on
 * an organization — which this endpoint does not know, because knowing it is
 * what signing in establishes. Keying on the email instead would let anyone
 * lock a named user out by failing on their behalf, which is a denial of
 * service dressed as a protection. Supabase applies its own limits on the auth
 * endpoint behind this, and that is the whole of the protection today.
 */
export const dynamic = "force-dynamic";

/** Shape only. Whether the credentials are *right* is the auth server's answer. */
const CredentialsSchema = z.object({
  email: z.string().email(),
  // A floor, not a policy. The password rules belong to the identity provider,
  // and duplicating them here would produce two definitions that disagree the
  // first time one is changed.
  password: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const parsed = CredentialsSchema.safeParse(body);

  if (!parsed.success) {
    // A shape failure is safe to name: it says nothing about whether any
    // account exists, only that this request could never have been evaluated.
    return Response.json(
      { error: "email and password are required." },
      { status: 400 },
    );
  }

  let supabase;

  try {
    supabase = await createClient();
  } catch (error: unknown) {
    if (error instanceof ServerEnvError) {
      // eslint-disable-next-line no-console
      console.error(`[auth/login] ${error.message}`);

      return Response.json(
        { error: "The server is misconfigured. Contact the operator." },
        { status: 500 },
      );
    }

    throw error;
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error !== null || data.user === null) {
    // One answer for a wrong password, an unknown address, an unconfirmed
    // account and a locked one. The provider's own message goes nowhere near
    // the response.
    return Response.json({ error: "Invalid credentials." }, { status: 401 });
  }

  // The cookies are already on the response by now, written by the adapter. The
  // body carries only what a client needs to render a signed-in state — never
  // the token that would let a script act as this person.
  return Response.json({
    user: {
      id: data.user.id,
      email: data.user.email ?? null,
    },
  });
}
