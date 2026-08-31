import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";
import { API_KEY_PREFIX, UnauthorizedError } from "@staticforge/core";

import { AccessDeniedError, requireProjectCapability } from "./access.js";
import { authenticateRequest } from "./authenticate.js";

/**
 * The two gates a locked-down write route runs, in order.
 *
 * `apps/web` has no test runner, so the route itself is three lines of glue
 * over these two calls — which is the point of extracting them. What is
 * asserted here is the pair's behaviour and their *ordering*, because that is
 * what the route can get wrong: authenticating after reading a project would
 * let an anonymous caller measure which ids exist, and checking a capability
 * without authenticating first would check it against a userId nobody proved.
 *
 * The three outcomes the patch endpoint has to produce:
 *
 *   no credential   -> 401, from `authenticateRequest`
 *   VIEWER          -> 403, from `requireProjectCapability`
 *   EDITOR or OWNER -> through
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

const RAW_KEY = `${API_KEY_PREFIX}${"k".repeat(43)}`;

/** A caller holding a valid key for `org_1`. */
function armAuthenticatedKey(): void {
  prisma.apiKey.findUnique.mockResolvedValue({
    id: "key_1",
    name: "editor key",
    organizationId: "org_1",
    revokedAt: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/** The project the patch names, and the caller's role in its organization. */
function armProject(organizationId: string | null, role: string | null): void {
  prisma.project.findUnique.mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (organizationId === null ? null : { organizationId }) as any,
  );
  prisma.organizationMember.findUnique.mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (role === null ? null : { role }) as any,
  );
}

/** Run both gates the way a locked-down route does. */
async function patchGates(
  header: string | null,
  projectId = "prj_1",
): Promise<{ status: 200 | 401 | 403 | 404; role?: string }> {
  let principal;

  try {
    principal = await authenticateRequest(header, prisma);
  } catch (error: unknown) {
    if (error instanceof UnauthorizedError) {
      return { status: 401 };
    }
    throw error;
  }

  try {
    const { role } = await requireProjectCapability(
      projectId,
      principal.userId,
      "project:write",
      prisma,
    );

    return { status: 200, role };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return { status: error.heldRole === null ? 404 : 403 };
    }
    throw error;
  }
}

describe("an unauthenticated patch is refused", () => {
  test("no header is 401", async () => {
    expect(await patchGates(null)).toEqual({ status: 401 });
  });

  test("a header with no credential is 401", async () => {
    for (const header of ["", "Bearer", "Bearer ", "Basic c2VjcmV0"]) {
      expect(await patchGates(header)).toEqual({ status: 401 });
    }
  });

  test("an unknown key is 401", async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null as never);

    expect(await patchGates(`Bearer ${RAW_KEY}`)).toEqual({ status: 401 });
  });

  test("nothing about the project is read before the caller is known", async () => {
    await patchGates(null);

    // A route that read first would let an anonymous request measure which
    // project ids exist. This is the ordering the endpoint depends on, and the
    // only place it is asserted.
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });
});

describe("an authenticated VIEWER is refused", () => {
  test("a VIEWER gets 403, not 401", async () => {
    armAuthenticatedKey();
    armProject("org_1", "VIEWER");

    // They proved who they are. What they lack is the role, and saying 401
    // would send them to re-authenticate a credential that is working fine.
    expect(await patchGates(`Bearer ${RAW_KEY}`)).toEqual({ status: 403 });
  });

  test("the refusal names the role, because the member can act on it", async () => {
    armAuthenticatedKey();
    armProject("org_1", "VIEWER");

    let error: AccessDeniedError | undefined;

    try {
      await requireProjectCapability("prj_1", "apikey:key_1", "project:write", prisma);
    } catch (thrown: unknown) {
      error = thrown as AccessDeniedError;
    }

    // Asserted rather than assumed: a capture that quietly kept `undefined`
    // would make this pass against code that allowed the write.
    expect(error).toBeInstanceOf(AccessDeniedError);
    expect(error?.heldRole).toBe("VIEWER");
    expect(error?.requiredRole).toBe("EDITOR");
  });

  test("a read-only API key is refused exactly as a read-only person is", async () => {
    armAuthenticatedKey();
    armProject("org_1", "VIEWER");

    // The key authenticated, and the role gate does not care that it is a
    // machine. That is the payoff of a key being a member rather than a
    // parallel permission path.
    expect(await patchGates(`Bearer ${RAW_KEY}`)).toEqual({ status: 403 });
  });
});

describe("an EDITOR or OWNER is let through", () => {
  test("an EDITOR passes", async () => {
    armAuthenticatedKey();
    armProject("org_1", "EDITOR");

    expect(await patchGates(`Bearer ${RAW_KEY}`)).toEqual({
      status: 200,
      role: "EDITOR",
    });
  });

  test("an OWNER passes", async () => {
    armAuthenticatedKey();
    armProject("org_1", "OWNER");

    expect(await patchGates(`Bearer ${RAW_KEY}`)).toEqual({
      status: 200,
      role: "OWNER",
    });
  });

  test("the capability is checked against the project's own organization", async () => {
    armAuthenticatedKey();
    armProject("org_actual", "EDITOR");

    await patchGates(`Bearer ${RAW_KEY}`);

    // Not against the organization the credential happens to name. A caller
    // holding only a project id must not be checked against one it belongs to.
    expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_userId: {
          organizationId: "org_actual",
          userId: "apikey:key_1",
        },
      },
      select: { role: true },
    });
  });
});

describe("a project in another organization is not there", () => {
  test("a non-member gets 404, indistinguishable from a missing project", async () => {
    armAuthenticatedKey();
    armProject("org_someone_else", null);

    const crossTenant = await patchGates(`Bearer ${RAW_KEY}`);

    armAuthenticatedKey();
    armProject(null, null);
    const missing = await patchGates(`Bearer ${RAW_KEY}`, "prj_imaginary");

    // Two different answers would turn a valid credential into a probe for
    // every other tenant's project ids.
    expect(crossTenant).toEqual({ status: 404 });
    expect(missing).toEqual({ status: 404 });
  });
});
