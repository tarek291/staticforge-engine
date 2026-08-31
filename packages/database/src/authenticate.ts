import type { PrismaClient } from "@prisma/client";
import {
  UnauthorizedError,
  isWellFormedApiKey,
  readBearerToken,
  verifyUserSession,
  type SessionUser,
  type SessionVerifier,
} from "@staticforge/core";

import { verifyApiKey } from "./api-key.js";
import { withDbRetry } from "./retry.js";
import type { TenantProjectSummary } from "./tenant.js";

/**
 * One door for two kinds of caller.
 *
 * A dashboard request carries a person's session; an integration carries a
 * machine key. Both end up asking the same questions of the same data, so they
 * arrive through the same function and leave as the same shape — a principal
 * with a `userId` the role gate already understands.
 *
 * ## Why one door and not two routes
 *
 * A second endpoint for machines is a second place every authorisation check
 * has to be repeated, and the one that gets forgotten is never the one anybody
 * is looking at. Phase 25 already made an API key a member of its organization
 * precisely so that a key and a person could be asked the same question; this
 * is where that pays off.
 *
 * ## Three ways in, one shape out
 *
 * A bearer `sf_org_…` key, a bearer session token, or a browser cookie. The
 * header is always preferred: a browser attaches its cookie to every request to
 * this origin, so a caller that bothered to send a header meant it, and
 * checking the cookie first would answer an integration as whoever happened to
 * be logged in on that machine.
 *
 * ## Why the routing decision is not an oracle
 *
 * The credential's *shape* decides which verifier runs — a `sf_org_…` prefix
 * goes to the key path, anything else to the session path. That is a routing
 * decision, not an authentication one, and both paths fail identically. A
 * caller cannot learn from a 401 whether it presented a malformed key, a real
 * but revoked key, an expired JWT, or nothing at all.
 */

/** Who is calling, once they have proved it. */
export type AuthenticatedPrincipal =
  | {
      kind: "api-key";
      /** The principal id the role gate is asked about. */
      userId: string;
      organizationId: string;
      apiKeyId: string;
      /** Human-readable, for a log line. Never a credential. */
      label: string;
    }
  | {
      kind: "session";
      /** The identity provider's user id. */
      userId: string;
      email: string;
      label: string;
    };

/** What {@link authenticateRequest} needs beyond the database. */
export interface AuthenticateOptions {
  /**
   * The identity provider, for session tokens.
   *
   * A function rather than a value, and called only on the session branch. A
   * deployment with no Supabase project can still verify API keys, and building
   * the verifier eagerly would make one misconfiguration into two outages —
   * every integration refused because the *human* login is unconfigured.
   *
   * It may throw, and the throw propagates. That is how a caller signals "this
   * is broken on our side, not yours": a missing configuration is a 500, while
   * an unverifiable token is a 401, and collapsing the two sends an operator
   * looking at their token while the server sits misconfigured.
   *
   * Omit it where sessions are not offered at all. A session token then fails
   * like any other unverifiable credential.
   */
  sessionVerifier?: (() => SessionVerifier | undefined) | undefined;
  /**
   * The person this request's cookies identify, if any.
   *
   * Consulted only when no bearer credential was presented. A browser sends a
   * cookie on every request to the origin, including the ones an integration
   * makes through it — so a caller that took the trouble to send a header meant
   * that header, and preferring the cookie would silently answer as whoever
   * happened to be logged in on that machine.
   *
   * Resolving this needs Next's request-scoped `cookies()`, which exists only
   * inside the web app. It arrives as a function so the *ordering* — the part
   * that can be got wrong — stays here, where it is tested, rather than living
   * in a route handler nothing can exercise.
   */
  cookieUser?: (() => Promise<SessionUser | null>) | undefined;
}

/**
 * Identify the caller, or refuse.
 *
 * @param authorizationHeader - The raw header, as received.
 * @param prisma - The client to read with.
 * @param options - The session verifier, when one is configured.
 * @throws {UnauthorizedError} For an absent, malformed, unknown, revoked or
 * expired credential — all of them with the same public message.
 */
export async function authenticateRequest(
  authorizationHeader: string | null | undefined,
  prisma: PrismaClient,
  options: AuthenticateOptions = {},
): Promise<AuthenticatedPrincipal> {
  const token = readBearerToken(authorizationHeader);

  if (token === undefined) {
    // No header. Fall back to a browser session, which is the only other way a
    // caller can identify itself.
    //
    // Explicitly *after* the header and never before it: a browser attaches its
    // cookie to every request to this origin, so preferring the cookie would
    // answer an integration running in a logged-in browser as the person logged
    // in there rather than as the key it presented.
    const person = await options.cookieUser?.();

    if (person !== null && person !== undefined) {
      return {
        kind: "session",
        userId: person.id,
        email: person.email,
        label: person.name ?? person.email,
      };
    }

    throw new UnauthorizedError("No bearer credential and no browser session.");
  }

  // The fork. Shape only: a well-formed key goes to the key path, everything
  // else is treated as a session token. Neither branch reveals which it took.
  if (isWellFormedApiKey(token)) {
    const principal = await verifyApiKey(token, prisma);

    if (principal === null) {
      throw new UnauthorizedError("The API key is unknown or revoked.");
    }

    return {
      kind: "api-key",
      userId: principal.userId,
      organizationId: principal.organizationId,
      apiKeyId: principal.apiKeyId,
      label: `api key "${principal.name}"`,
    };
  }

  const verifier = options.sessionVerifier?.();

  if (verifier === undefined) {
    // No identity provider configured, so a session token cannot be verified.
    // Refused rather than trusted, and refused with the same message as a bad
    // token: "sessions are not configured here" is a fact about the deployment
    // that an unauthenticated caller has no business learning.
    throw new UnauthorizedError(
      "A session token was presented but no identity provider is configured.",
    );
  }

  const user = await verifyUserSession(token, verifier);

  return {
    kind: "session",
    userId: user.id,
    email: user.email,
    label: user.name ?? user.email,
  };
}

/**
 * The projects a principal may see.
 *
 * Scoped through `OrganizationMember`, not through `Project.userId`. The older
 * column records who *created* a project; membership records who may reach it,
 * and those diverge the moment a second person joins an organization. Listing
 * by the creator would show an owner their own projects and hide their
 * colleagues' — which reads as data loss rather than as a permissions model.
 *
 * The same query serves a person and an API key, because Phase 25 made a key a
 * member. There is no branch here on the kind of principal, and that absence is
 * the point: a branch is where the two would eventually be scoped differently.
 *
 * @returns Every project in every organization this principal belongs to.
 * Empty for a verified caller with no memberships — a real answer, not an
 * error: somebody who has signed in but been invited nowhere sees nothing.
 */
export async function listProjectsForPrincipal(
  userId: string,
  prisma: PrismaClient,
): Promise<TenantProjectSummary[]> {
  const projects = await withDbRetry(() =>
    prisma.project.findMany({
      where: { organization: { members: { some: { userId } } } },
      orderBy: [{ workspaceId: "asc" }, { slug: "asc" }],
      include: {
        workspace: { select: { name: true } },
        business: { select: { name: true } },
        _count: { select: { services: true, locations: true, generatedPages: true } },
      },
    }),
  );

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    locale: project.locale,
    siteUrl: project.siteUrl,
    templateId: project.templateId,
    contentProfileId: project.contentProfileId,
    workspaceName: project.workspace.name,
    businessName: project.business?.name ?? null,
    serviceCount: project._count.services,
    locationCount: project._count.locations,
    pageCount: project._count.generatedPages,
    expectedPages: project._count.services * project._count.locations,
  }));
}
