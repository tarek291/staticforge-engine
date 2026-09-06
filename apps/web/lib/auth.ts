import {
  UnauthorizedError,
  checkRequestOrigin,
  createSessionVerifier,
  readAllowedHosts,
  type OrgCapability,
  type OrgRoleName,
} from "@staticforge/core";
import {
  AccessDeniedError,
  authenticateRequest,
  prisma,
  requireProjectCapability,
  type AuthenticatedPrincipal,
} from "@staticforge/database";

import { ServerEnvError, readServerEnv } from "./env";
import { readCookieUser } from "../utils/supabase/server";

/**
 * The guard every API route in this app goes through.
 *
 * Phase 28 wired authentication into one route by hand. Repeating that by hand
 * on each of the others is how the fifth one ends up missing a check nobody
 * notices — so the logic is here once, and a route is three lines of using it.
 *
 * ## Why these return a result instead of throwing
 *
 * A thrown guard is forgotten silently: a route with no `try` still compiles,
 * still runs, and answers 500 instead of 401 — safe by luck rather than by
 * design. A discriminated union cannot be forgotten, because reading
 * `auth.principal` without first narrowing on `auth.ok` is a *compile error*.
 * The type system enforces the check that a `catch` block only documents.
 *
 * The refusal arrives as a ready `Response` rather than as a code, so two
 * routes cannot disagree about what a 401 body looks like.
 *
 * ## Three ways in, one shape out
 *
 * A bearer `sf_org_…` key, a bearer session token, or a browser cookie. Routes
 * did not change to gain the third: the CLI keeps sending a header and the
 * dashboard will send a cookie, and both arrive at the same `principal`.
 *
 * The header always wins. A browser attaches its cookie to every request to
 * this origin, including ones an integration makes through it, so a caller that
 * bothered to send a header meant that header — and checking the cookie first
 * would answer as whoever happened to be logged in on that machine.
 *
 * ## Cookie callers must also prove where they came from
 *
 * The same fact that makes the ordering matter — a browser attaches the cookie
 * by itself — is what makes a cookie session forgeable by a page the person did
 * not mean to trust. `SameSite=Lax` stops the classic cross-*site* form post and
 * does **not** stop a sibling subdomain: `SameSite` compares registrable
 * domains, so anything under the same `example.com` is same-site and its POSTs
 * carry the cookie.
 *
 * So a cookie-authenticated *mutation* is checked against `Origin`. A bearer
 * caller is not: it is not exposed to the attack, and demanding an `Origin` from
 * `curl` would break every integration while preventing nothing. The rule lives
 * in `@staticforge/core` where it is tested; this reads the request.
 */

/** A caller who proved who they are, or the refusal to send back. */
export type ApiAuth =
  | { ok: true; principal: AuthenticatedPrincipal }
  | { ok: false; response: Response };

/** A caller allowed to do the thing, or the refusal to send back. */
export type ApiAuthorization =
  | { ok: true; organizationId: string; role: OrgRoleName }
  | { ok: false; response: Response };

/** The one 401 body in this app. */
function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized." },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

/**
 * Look for a browser session, treating an unconfigured provider as "none".
 *
 * The same reasoning the lazy verifier below is built on, applied to the half
 * that was missing it. `readCookieUser` needs Supabase configuration, and it is
 * consulted on **every request that arrives without a header** — including one
 * that carries no credential at all. So on a deployment with no Supabase
 * project, an anonymous request to any route threw `ServerEnvError` and was
 * answered `500`.
 *
 * That is wrong three ways. The caller sent nothing, so the honest answer is
 * `401`. A `500` tells an unauthenticated stranger that the server is
 * misconfigured, which is a fact about the deployment they have no business
 * learning. And every drive-by scanner then registers as a server fault in
 * whatever watches the error rate.
 *
 * A missing identity provider means no cookie session exists — nobody can have
 * signed in — so `null` is the truthful answer, and the absent-credential path
 * raises `UnauthorizedError` exactly as it does when Supabase *is* configured
 * and the caller simply is not signed in.
 *
 * This deliberately does **not** soften the case where a session token was
 * actually presented: that still reaches `resolveSessionVerifier`, still throws,
 * and is still a `500`. A caller who offered a credential we cannot check is
 * owed a different answer from one who offered nothing at all.
 */
async function resolveCookieUser(routeLabel: string) {
  try {
    return await readCookieUser();
  } catch (error: unknown) {
    if (error instanceof ServerEnvError) {
      // eslint-disable-next-line no-console
      console.error(
        `[${routeLabel}] no browser sessions are possible: ${error.message}`,
      );

      return null;
    }

    throw error;
  }
}

/**
 * Build the session verifier, lazily and only when a session token arrives.
 *
 * A deployment with no Supabase project can still serve integrations holding
 * API keys. Building this eagerly would turn one misconfiguration into two
 * outages — every machine caller refused because the *human* login is
 * unconfigured.
 *
 * ## Why an unconfigured provider returns `undefined` rather than throwing
 *
 * Because that is what `authenticateRequest` was written to expect. It already
 * has the branch — "no identity provider configured, so a session token cannot
 * be verified" — and it already refuses with `UnauthorizedError`, on the stated
 * grounds that *sessions are not configured here* is a fact about the
 * deployment an unauthenticated caller has no business learning.
 *
 * Throwing from here reached past that branch. The result was that **any**
 * bearer token which is not a well-formed API key — a random string, a stale
 * JWT, a scanner's junk — was answered `500` on a deployment without Supabase,
 * which is the exact information leak that branch exists to prevent, arriving
 * through the door next to the one it was guarding. Found by running it.
 *
 * The counter-argument is that a person holding a genuinely valid token is now
 * told "unauthorized" when the truth is "we cannot check". That is real, and it
 * is the lesser harm: the operator still gets the reason in the log below,
 * because the misconfiguration is reported the moment anybody tries — while the
 * alternative hands the same diagnosis to everyone who sends a bearer header at
 * all.
 *
 * @returns The verifier, or `undefined` when no provider is configured.
 */
function resolveSessionVerifier(routeLabel: string) {
  let env;

  try {
    env = readServerEnv();
  } catch (error: unknown) {
    if (error instanceof ServerEnvError) {
      // eslint-disable-next-line no-console
      console.error(
        `[${routeLabel}] a session token was presented and cannot be verified: ` +
          `${error.message}`,
      );

      return undefined;
    }

    throw error;
  }

  // The validated values build the client, rather than reaching back into
  // `process.env` for whatever it holds by now.
  return createSessionVerifier({
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
  });
}

/**
 * Identify the caller of an API request.
 *
 * Accepts a Supabase session JWT or a Phase 25 `sf_org_…` API key, through the
 * same door and with the same refusal. Absent, malformed, unknown, revoked and
 * expired are five things internally and one `401` to a caller.
 *
 * @param request - The incoming request.
 * @param routeLabel - Named in the server log when the *server* is at fault, so
 * a misconfiguration can be traced to the route that noticed it.
 */
export async function requireApiAuth(
  request: Request,
  routeLabel: string,
): Promise<ApiAuth> {
  try {
    const principal = await authenticateRequest(
      request.headers.get("authorization"),
      prisma,
      {
        sessionVerifier: () => resolveSessionVerifier(routeLabel),
        // Consulted only when no header arrived. Reading cookies needs Next's
        // request-scoped store, which is why this is a callback rather than a
        // value: the *ordering* lives in `@staticforge/database`, where it is
        // tested, and only the mechanics live here.
        cookieUser: () => resolveCookieUser(routeLabel),
      },
    );

    // Only for cookie callers, and only for methods that change something. See
    // the note at the top of this file: a bearer credential is not attached by
    // a browser, so it is not exposed to this and must not be asked for proof.
    if (principal.kind === "session" && principal.viaCookie) {
      const verdict = checkRequestOrigin({
        method: request.method,
        origin: request.headers.get("origin"),
        // What the browser addressed. Behind a proxy this is the public name,
        // which is the one the browser's `Origin` will carry.
        host: request.headers.get("host"),
        allowedHosts: readAllowedHosts(),
      });

      if (!verdict.ok) {
        // eslint-disable-next-line no-console
        console.error(
          `[${routeLabel}] refused a cookie ${request.method}: ${verdict.reason} ` +
            `(origin ${verdict.origin ?? "absent"}, expected ${verdict.expected ?? "unknown"})`,
        );

        return {
          ok: false,
          response: Response.json(
            {
              error:
                "This request did not come from an allowed origin. " +
                "Use an API key for programmatic access.",
            },
            { status: 403 },
          ),
        };
      }
    }

    return { ok: true, principal };
  } catch (error: unknown) {
    if (error instanceof ServerEnvError) {
      // 500, not 401. This is our fault, and a 401 would send an operator
      // looking at their token while the server sits misconfigured.
      //
      // The detail goes to the log, not the body: an operator reads logs, an
      // unauthenticated caller reads responses, and which environment variables
      // are missing is not something to tell one.
      // eslint-disable-next-line no-console
      console.error(`[${routeLabel}] ${error.message}`);

      return {
        ok: false,
        response: Response.json(
          { error: "The server is misconfigured. Contact the operator." },
          { status: 500 },
        ),
      };
    }

    if (error instanceof UnauthorizedError) {
      return { ok: false, response: unauthorized() };
    }

    throw error;
  }
}

/**
 * Check that an identified caller may do something to a project.
 *
 * Resolves the project's organization first, so a caller holding only a project
 * id cannot be checked against an organization it happens to belong to. That
 * lookup is inside `requireProjectCapability`, which is the same gate every
 * non-HTTP write passes — there is deliberately no second permission path for
 * routes.
 *
 * A caller with no membership gets `404`, identical to a project that does not
 * exist: two different answers would let a valid credential enumerate other
 * tenants' project ids. A *member* whose role is too weak gets `403` naming
 * their role, which is not a leak — they already know both — and is the
 * difference between a self-service fix and a support thread.
 */
export async function requireApiProjectCapability(
  projectId: string,
  principal: AuthenticatedPrincipal,
  capability: OrgCapability,
): Promise<ApiAuthorization> {
  try {
    const { organizationId, role } = await requireProjectCapability(
      projectId,
      principal.userId,
      capability,
      prisma,
    );

    return { ok: true, organizationId, role };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return {
        ok: false,
        response:
          error.heldRole === null
            ? Response.json({ error: "Project not found." }, { status: 404 })
            : Response.json({ error: error.message }, { status: 403 }),
      };
    }

    throw error;
  }
}
