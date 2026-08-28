import { UnauthorizedError, createSessionVerifier } from "@staticforge/core";
import {
  authenticateRequest,
  listProjectsForPrincipal,
  prisma,
} from "@staticforge/database";

import { ServerEnvError, readServerEnv } from "../../../../lib/env";

/**
 * The first authenticated read surface.
 *
 * Every other dashboard route in this app still acts as the `local-operator`
 * constant. This one asks who is calling and answers accordingly — a person
 * with a Supabase session, or an integration with a Phase 25 API key, through
 * one door.
 *
 * ## What it does not do
 *
 * It does not create anything. A caller who verifies but has never been
 * provisioned into the `User` table has no memberships and sees an empty list,
 * rather than having a row written for them on a `GET`. Just-in-time
 * provisioning is a reasonable feature and a terrible side effect of a read:
 * a GET that writes is a GET that cannot be retried, cached, or reasoned about.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  // The session verifier is built lazily, and only if a session token is what
  // actually arrives. A deployment with no Supabase project can still serve
  // integrations holding API keys; building it eagerly would turn one
  // misconfiguration into two outages.
  const resolveSessionVerifier = () => {
    const env = readServerEnv();

    // Passed as the validated record rather than reaching back into
    // `process.env`, so what was checked is what builds the client.
    return createSessionVerifier({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
    });
  };

  let principal;

  try {
    principal = await authenticateRequest(request.headers.get("authorization"), prisma, {
      sessionVerifier: resolveSessionVerifier,
    });
  } catch (error: unknown) {
    if (error instanceof ServerEnvError) {
      // 500, not 401. This is our fault, not the caller's, and a 401 would send
      // an operator looking at their token while the server sits misconfigured.
      //
      // The detail goes to the log, not the body. An operator reads logs; an
      // unauthenticated caller reads responses, and which environment variables
      // a deployment is missing is not something to tell one. The status code
      // already says "our side", which is all the caller needs.
      // eslint-disable-next-line no-console
      console.error(`[dashboard/projects] ${error.message}`);

      return Response.json(
        { error: "The server is misconfigured. Contact the operator." },
        { status: 500 },
      );
    }

    if (error instanceof UnauthorizedError) {
      // One answer for every failure — absent, malformed, unknown, revoked,
      // expired. The reason lives on the error for a log and never in the body.
      return Response.json(
        { error: "Unauthorized." },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }

    throw error;
  }

  const projects = await listProjectsForPrincipal(principal.userId, prisma);

  return Response.json({
    // Echoed so a client can show who it is acting as, and so an integrator
    // debugging an empty list can see which principal was resolved. Neither
    // field is a credential.
    principal: { kind: principal.kind, label: principal.label },
    projects,
  });
}
