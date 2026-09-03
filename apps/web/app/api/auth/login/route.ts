import { z } from "zod";
import {
  LOGIN_GLOBAL_RATE_LIMIT_KEY,
  LOGIN_RATE_LIMIT,
  clientAddress,
  loginRateLimitKey,
} from "@staticforge/core";
import { consumeApiTokens, prisma } from "@staticforge/database";

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
 * ## How it is rate limited
 *
 * Phase 24's token bucket, on two keys at once. Phase 30 left this endpoint
 * open because the bucket was keyed on an organization, which signing in is
 * what establishes; the answer is that this endpoint keys on something else.
 *
 * **Not on the email.** That would let anyone lock a named user out of their
 * own account by failing on their behalf — a denial of service handed out to
 * whoever asked for it.
 *
 * **On the caller's address**, which bounds one machine, **and on a global
 * key**, which bounds everybody. Both, because the first is derived from a
 * header and a request that has not passed through a trusted proxy can carry
 * whatever header it likes: an attacker rotating that value gets a fresh bucket
 * every time. The global bucket is keyed on nothing at all, so no header
 * changes it, and it is what actually holds against a distributed run.
 *
 * The global one is checked first, so a flood cannot be used to fill up other
 * people's per-address buckets on the way past.
 *
 * A refused attempt still costs a token. That is the point — a limiter that
 * only charged for successes would meter the honest users and let the guessing
 * through free.
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
  const refusal = await refuseIfTooFast(request);

  if (refusal !== null) {
    return refusal;
  }

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

/**
 * Spend an attempt from the global bucket and this caller's own.
 *
 * @returns A `429` to send back, or `null` when the attempt may proceed.
 */
async function refuseIfTooFast(request: Request): Promise<Response | null> {
  const buckets: ReadonlyArray<{ key: string; burst: number; refill: number }> = [
    // Global first. Checked before the per-address bucket so a flood cannot
    // spend its way through other people's buckets on the way past — and so the
    // one limit a forged header cannot dodge is the one that runs even when the
    // address is nonsense.
    {
      key: LOGIN_GLOBAL_RATE_LIMIT_KEY,
      burst: LOGIN_RATE_LIMIT.globalBurst,
      refill: LOGIN_RATE_LIMIT.globalRefillPerSec,
    },
    {
      key: loginRateLimitKey(clientAddress(request.headers)),
      burst: LOGIN_RATE_LIMIT.perAddressBurst,
      refill: LOGIN_RATE_LIMIT.perAddressRefillPerSec,
    },
  ];

  for (const bucket of buckets) {
    let grant;

    try {
      grant = await consumeApiTokens(bucket.key, 1, bucket.burst, bucket.refill, prisma);
    } catch (error: unknown) {
      // The limiter needs the database, and this endpoint is reachable without
      // one. Failing *open* is the deliberate choice: a database blip would
      // otherwise lock every customer out of their own dashboard, which is a
      // worse and much more likely outcome than an unmetered minute of
      // guessing. Loud, so it cannot be the silent state.
      // eslint-disable-next-line no-console
      console.error(
        `[auth/login] rate limiter unavailable, allowing the attempt: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }

    if (!grant.allowed) {
      // No detail about which bucket, and none about the account. "Too many
      // attempts" is the whole answer: saying *whose* limit was hit would tell
      // a caller whether anyone else is signing in from their address.
      return Response.json(
        { error: "Too many sign-in attempts. Try again shortly." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil(grant.waitForMs / 1000))),
          },
        },
      );
    }
  }

  return null;
}
