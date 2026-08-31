import {
  UnauthorizedError,
  createSessionVerifier,
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
 * Build the session verifier, lazily and only when a session token arrives.
 *
 * A deployment with no Supabase project can still serve integrations holding
 * API keys. Building this eagerly would turn one misconfiguration into two
 * outages — every machine caller refused because the *human* login is
 * unconfigured.
 */
function resolveSessionVerifier() {
  const env = readServerEnv();

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
      { sessionVerifier: resolveSessionVerifier },
    );

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
