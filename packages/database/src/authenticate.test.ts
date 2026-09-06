import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";
import {
  API_KEY_PREFIX,
  UnauthorizedError,
  hashApiKey,
  type SessionVerifier,
} from "@staticforge/core";

import { authenticateRequest, listProjectsForPrincipal } from "./authenticate.js";

/**
 * One door, two kinds of caller.
 *
 * The tests that matter are the ones showing the door is the *same* door: a
 * person and a machine leave as the same shape, are scoped by the same query,
 * and are refused with the same message. A second code path for machines is a
 * second place every check has to be repeated, and the one that gets forgotten
 * is never the one anybody is looking at.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

const RAW_KEY = `${API_KEY_PREFIX}${"k".repeat(43)}`;
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";

/** Arm the API-key lookup. */
function armKey(row: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.apiKey.findUnique.mockResolvedValue(row as any);
}

/** A provider that accepts any token as one person. */
function acceptingSession(user: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown>;
}): { verifier: SessionVerifier; asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    verifier: {
      auth: {
        getUser: (token: string) => {
          asked.push(token);
          return Promise.resolve({ data: { user }, error: null });
        },
      },
    },
  };
}

/** A provider that rejects everything. */
const REJECTING_SESSION: SessionVerifier = {
  auth: {
    getUser: () =>
      Promise.resolve({ data: { user: null }, error: { message: "invalid JWT" } }),
  },
};

/** The refusal a call produced, asserting that it produced one. */
async function refusalFrom(call: Promise<unknown>): Promise<UnauthorizedError> {
  try {
    await call;
  } catch (error: unknown) {
    if (error instanceof UnauthorizedError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected an UnauthorizedError, but the call resolved.");
}

describe("a machine key is accepted", () => {
  test("it resolves to the key's principal", async () => {
    armKey({ id: "key_1", name: "CI pipeline", organizationId: "org_1", revokedAt: null });

    const principal = await authenticateRequest(`Bearer ${RAW_KEY}`, prisma);

    expect(principal).toEqual({
      kind: "api-key",
      userId: "apikey:key_1",
      organizationId: "org_1",
      apiKeyId: "key_1",
      label: 'api key "CI pipeline"',
    });
  });

  test("the identity provider is never consulted for a key", async () => {
    armKey({ id: "key_1", name: "CI", organizationId: "org_1", revokedAt: null });
    const { verifier, asked } = acceptingSession({ id: "u1", email: "a@example.com" });

    await authenticateRequest(`Bearer ${RAW_KEY}`, prisma, { sessionVerifier: () => verifier });

    // The shape decides the route. Asking both would double the latency of
    // every machine call and give a session provider a token it has no business
    // seeing.
    expect(asked).toEqual([]);
  });

  test("the plaintext key never travels to the database", async () => {
    armKey({ id: "key_1", name: "CI", organizationId: "org_1", revokedAt: null });

    await authenticateRequest(`Bearer ${RAW_KEY}`, prisma);

    const queried = JSON.stringify(prisma.apiKey.findUnique.mock.calls);

    expect(queried).not.toContain(RAW_KEY);
    expect(queried).toContain(hashApiKey(RAW_KEY));
  });

  test("a revoked key is refused", async () => {
    armKey({ id: "key_1", name: "CI", organizationId: "org_1", revokedAt: new Date() });

    await expect(
      authenticateRequest(`Bearer ${RAW_KEY}`, prisma),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("an unknown key is refused", async () => {
    armKey(null);

    await expect(
      authenticateRequest(`Bearer ${RAW_KEY}`, prisma),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("a person's session is accepted", () => {
  test("it resolves to the identity provider's user", async () => {
    const { verifier } = acceptingSession({
      id: "user-uuid",
      email: "alice@example.com",
      user_metadata: { name: "Alice" },
    });

    const principal = await authenticateRequest(`Bearer ${JWT}`, prisma, {
      sessionVerifier: () => verifier,
    });

    expect(principal).toEqual({
      kind: "session",
      // A header the caller chose to send. Not attached by a browser, so not
      // exposed to CSRF and not asked for an origin proof.
      viaCookie: false,
      userId: "user-uuid",
      email: "alice@example.com",
      label: "Alice",
    });
  });

  test("the database is never asked about a session token", async () => {
    const { verifier } = acceptingSession({ id: "u1", email: "a@example.com" });

    await authenticateRequest(`Bearer ${JWT}`, prisma, { sessionVerifier: () => verifier });

    // A JWT is not a key and must not be hashed and looked up as one — that
    // would put a bearer token into a query, and a query into a slow log.
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  test("a rejected token is refused", async () => {
    await expect(
      authenticateRequest(`Bearer ${JWT}`, prisma, {
        sessionVerifier: () => REJECTING_SESSION,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("a session token with no configured provider is refused, not trusted", async () => {
    // A deployment with no identity provider can still verify keys. It must not
    // fall back to trusting a JWT it cannot check.
    const error = await refusalFrom(authenticateRequest(`Bearer ${JWT}`, prisma));

    expect(error).toBeInstanceOf(UnauthorizedError);
    // The *reason* is asserted, not only the refusal. Without the explicit
    // branch this still refuses — `verifyUserSession` turns the resulting
    // TypeError into an UnauthorizedError — so an outcome-only assertion passes
    // against code that reaches a missing provider and trips over it. That
    // happens to be safe today and is safe by accident, which is the kind of
    // guarantee the next refactor removes without noticing.
    expect(error.detail).toMatch(/no identity provider is configured/i);
  });

  test("the label falls back to the email when there is no name", async () => {
    const { verifier } = acceptingSession({ id: "u1", email: "alice@example.com" });

    const principal = await authenticateRequest(`Bearer ${JWT}`, prisma, {
      sessionVerifier: () => verifier,
    });

    expect(principal.label).toBe("alice@example.com");
  });
});

describe("nothing else is accepted", () => {
  test("an absent header is refused", async () => {
    await expect(authenticateRequest(null, prisma)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(authenticateRequest(undefined, prisma)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  test("a header with no credential is refused", async () => {
    for (const header of ["", "Bearer", "Bearer ", "Basic c2VjcmV0"]) {
      await expect(authenticateRequest(header, prisma)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    }
  });

  test("an absent credential costs no query and no provider call", async () => {
    const { verifier, asked } = acceptingSession({ id: "u1", email: "a@example.com" });

    await refusalFrom(authenticateRequest(null, prisma, { sessionVerifier: () => verifier }));

    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  test("every refusal carries the same public message", async () => {
    armKey(null);
    const messages = new Set<string>();

    messages.add((await refusalFrom(authenticateRequest(null, prisma))).message);
    messages.add(
      (await refusalFrom(authenticateRequest(`Bearer ${RAW_KEY}`, prisma))).message,
    );
    messages.add(
      (
        await refusalFrom(
          authenticateRequest(`Bearer ${JWT}`, prisma, {
            sessionVerifier: () => REJECTING_SESSION,
          }),
        )
      ).message,
    );

    // Absent, unknown key, rejected session. Three things internally, one thing
    // to a caller — the routing decision must not become an oracle.
    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe("Unauthorized.");
  });

  test("the reason survives on the error, for a log", async () => {
    armKey(null);

    const error = await refusalFrom(authenticateRequest(`Bearer ${RAW_KEY}`, prisma));

    expect(error.detail).toMatch(/unknown or revoked/i);
    expect(error.message).toBe("Unauthorized.");
  });
});

describe("a principal sees its organizations' projects and nothing else", () => {
  beforeEach(() => {
    prisma.project.findMany.mockResolvedValue([]);
  });

  /** The `where` the listing was built with. */
  function listWhere(): Record<string, unknown> {
    return (prisma.project.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> })
      .where;
  }

  test("scoping goes through membership, not through the creator column", async () => {
    await listProjectsForPrincipal("user-uuid", prisma);

    // `Project.userId` records who created a project; membership records who
    // may reach it. Listing by the creator would show an owner their own
    // projects and hide their colleagues', which reads as data loss.
    expect(listWhere()).toEqual({
      organization: { members: { some: { userId: "user-uuid" } } },
    });
    expect(listWhere()).not.toHaveProperty("userId");
  });

  test("an API key is scoped by exactly the same query", async () => {
    await listProjectsForPrincipal("apikey:key_1", prisma);

    // No branch on the kind of principal. A branch is where the two would
    // eventually be scoped differently.
    expect(listWhere()).toEqual({
      organization: { members: { some: { userId: "apikey:key_1" } } },
    });
  });

  test("a verified caller with no memberships sees nothing, and that is not an error", async () => {
    expect(await listProjectsForPrincipal("stranger", prisma)).toEqual([]);
  });

  test("projects are shaped for a listing, with counts", async () => {
    prisma.project.findMany.mockResolvedValue([
      {
        id: "prj_1",
        name: "GlanzFix",
        slug: "glanzfix-de",
        locale: "de",
        siteUrl: "https://www.glanzfix.de",
        templateId: "default",
        contentProfileId: "default",
        workspaceId: "ws_1",
        workspace: { name: "GlanzFix" },
        business: { name: "GlanzFix Reinigungsservice" },
        _count: { services: 3, locations: 3, generatedPages: 9 },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    const [project] = await listProjectsForPrincipal("user-uuid", prisma);

    expect(project).toMatchObject({
      id: "prj_1",
      workspaceName: "GlanzFix",
      businessName: "GlanzFix Reinigungsservice",
      pageCount: 9,
      expectedPages: 9,
    });
  });

  test("listing reads and never writes", async () => {
    await listProjectsForPrincipal("user-uuid", prisma);

    // A caller who verifies but has never been provisioned gets an empty list,
    // not a row written for them. A GET that writes is a GET that cannot be
    // retried, cached, or reasoned about.
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.organizationMember.create).not.toHaveBeenCalled();
  });
});

describe("a missing identity provider is our problem, not the caller's", () => {
  test("an API key works even when sessions are unconfigured", async () => {
    armKey({ id: "key_1", name: "CI", organizationId: "org_1", revokedAt: null });

    // The verifier factory would throw if it were called. It must not be: a
    // deployment with no Supabase project can still serve integrations, and
    // building the verifier eagerly turns one misconfiguration into two
    // outages.
    const principal = await authenticateRequest(`Bearer ${RAW_KEY}`, prisma, {
      sessionVerifier: () => {
        throw new Error("SUPABASE_URL is missing");
      },
    });

    expect(principal.kind).toBe("api-key");
  });

  test("a configuration failure propagates rather than becoming a 401", async () => {
    class ConfigError extends Error {}

    // A missing configuration is a 500 and an unverifiable token is a 401.
    // Collapsing the two sends an operator looking at their token while the
    // server sits misconfigured.
    await expect(
      authenticateRequest(`Bearer ${JWT}`, prisma, {
        sessionVerifier: () => {
          throw new ConfigError("SUPABASE_ANON_KEY is missing");
        },
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("a factory returning nothing is a refusal, not a crash", async () => {
    const error = await refusalFrom(
      authenticateRequest(`Bearer ${JWT}`, prisma, { sessionVerifier: () => undefined }),
    );

    expect(error.detail).toMatch(/no identity provider is configured/i);
  });
});

// ---------------------------------------------------------------------------
// Phase 30: a browser cookie is the third way in
// ---------------------------------------------------------------------------

/**
 * The hybrid door.
 *
 * The property that matters is the *ordering*. A browser attaches its cookie to
 * every request to this origin, including the ones an integration makes through
 * it — so checking the cookie first would answer a machine caller as whoever
 * happened to be logged in on that machine. The header always wins, and these
 * tests are mostly about proving it.
 */
describe("a browser session is accepted when no header arrives", () => {
  /** A cookie store holding one signed-in person. */
  function cookieUser(user: { id: string; email: string; name?: string | null }) {
    const calls: number[] = [];

    return {
      calls,
      resolve: () => {
        calls.push(1);
        return Promise.resolve({
          id: user.id,
          email: user.email,
          name: user.name ?? null,
        });
      },
    };
  }

  test("a cookie identifies the person", async () => {
    const cookie = cookieUser({ id: "user-uuid", email: "alice@example.com", name: "Alice" });

    const principal = await authenticateRequest(null, prisma, {
      cookieUser: cookie.resolve,
    });

    // The same shape a bearer session produces, so no route had to change to
    // gain this — with one field that differs, because the difference matters.
    // The browser attached this credential, which is what makes a mutation
    // carrying it forgeable by a sibling subdomain, so it is the one the origin
    // check applies to.
    expect(principal).toEqual({
      kind: "session",
      viaCookie: true,
      userId: "user-uuid",
      email: "alice@example.com",
      label: "Alice",
    });
  });

  test("the label falls back to the email", async () => {
    const cookie = cookieUser({ id: "u1", email: "alice@example.com" });

    const principal = await authenticateRequest(null, prisma, {
      cookieUser: cookie.resolve,
    });

    expect(principal.label).toBe("alice@example.com");
  });

  test("no cookie and no header is still a refusal", async () => {
    await expect(
      authenticateRequest(null, prisma, { cookieUser: () => Promise.resolve(null) }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("with no cookie resolver at all, nothing changes", async () => {
    // Every caller that predates this option keeps working unchanged.
    await expect(authenticateRequest(null, prisma)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

describe("a header always beats a cookie", () => {
  test("an API key wins over a signed-in browser", async () => {
    armKey({ id: "key_1", name: "CI", organizationId: "org_1", revokedAt: null });
    const cookie = { calls: 0 };

    const principal = await authenticateRequest(`Bearer ${RAW_KEY}`, prisma, {
      cookieUser: () => {
        cookie.calls += 1;
        return Promise.resolve({ id: "person", email: "p@example.com", name: null });
      },
    });

    // The cookie is never even read. An integration running inside a logged-in
    // browser must act as the key it presented, not as the person at the
    // keyboard — and the cheapest way to guarantee that is not to look.
    expect(principal.kind).toBe("api-key");
    expect(cookie.calls).toBe(0);
  });

  test("a bearer session token wins too", async () => {
    const { verifier } = acceptingSession({ id: "bearer-user", email: "b@example.com" });
    let cookieRead = false;

    const principal = await authenticateRequest(`Bearer ${JWT}`, prisma, {
      sessionVerifier: () => verifier,
      cookieUser: () => {
        cookieRead = true;
        return Promise.resolve({ id: "cookie-user", email: "c@example.com", name: null });
      },
    });

    expect(principal.userId).toBe("bearer-user");
    expect(cookieRead).toBe(false);
  });

  test("a bad header is not rescued by a good cookie", async () => {
    armKey(null);
    let cookieRead = false;

    // The caller chose a credential and it was refused. Falling back to the
    // cookie would mean a revoked key silently keeps working for anyone whose
    // browser happens to be signed in.
    await expect(
      authenticateRequest(`Bearer ${RAW_KEY}`, prisma, {
        cookieUser: () => {
          cookieRead = true;
          return Promise.resolve({ id: "u", email: "u@example.com", name: null });
        },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect(cookieRead).toBe(false);
  });
});
