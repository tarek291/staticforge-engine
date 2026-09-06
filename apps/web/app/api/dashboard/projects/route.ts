import { listProjectsForPrincipal, prisma } from "@staticforge/database";

import { requireApiAuth } from "../../../../lib/auth";

/**
 * The projects a caller may see.
 *
 * ## Why this route is three lines now
 *
 * It used to be forty. This was the *first* authenticated surface — Phase 28
 * wired the auth by hand, here, before there was a helper — and Phase 29 built
 * `requireApiAuth` and converted every other route to it. This one was left
 * behind, still carrying its own copy.
 *
 * That copy did not rot in the way the Phase 29 note predicted. The check was
 * still there and still correct for the credential it knew about. What happened
 * instead is that the shared guard *grew* and this one did not:
 *
 * - Phase 30 added cookie sessions. `requireApiAuth` passes a `cookieUser`
 *   resolver; the copy never did — so the one endpoint the dashboard calls
 *   could not read a browser session at all. Every other route could.
 * - The CodeRabbit remediation made an unconfigured provider answer `401`
 *   rather than telling a stranger the server is misconfigured. The copy went
 *   on answering `500` to any bearer token that is not a well-formed API key.
 * - The same round added the `Origin` check that stops a sibling subdomain
 *   spending a cookie session. The copy had nothing to apply it to.
 *
 * Found by running it: the dashboard signed in and then could not list a single
 * project, because the route it asks was the one route that does not know what
 * a cookie is. Two implementations of "who is calling" do not stay identical;
 * they diverge in the direction of whichever one somebody remembered to update.
 *
 * ## What it still does not do
 *
 * It does not create anything. A caller who verifies but has never been
 * provisioned into the `User` table has no memberships and sees an empty list,
 * rather than having a row written for them on a `GET`. Just-in-time
 * provisioning is a reasonable feature and a terrible side effect of a read:
 * a GET that writes is a GET that cannot be retried, cached, or reasoned about.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireApiAuth(request, "dashboard/projects");

  if (!auth.ok) {
    return auth.response;
  }

  const projects = await listProjectsForPrincipal(auth.principal.userId, prisma);

  return Response.json({
    // Echoed so a client can show who it is acting as, and so an integrator
    // debugging an empty list can see which principal was resolved. Neither
    // field is a credential.
    principal: { kind: auth.principal.kind, label: auth.principal.label },
    projects,
  });
}
