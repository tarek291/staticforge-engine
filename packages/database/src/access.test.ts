import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import {
  AccessDeniedError,
  ORG_ROLES_IN_SYNC,
  organizationOfProject,
  requireCapability,
  requireProjectCapability,
  requireRole,
  resolveRole,
} from "./access.js";

/**
 * The authorisation gate.
 *
 * Two kinds of test, and the second matters more. The first checks that the
 * right people get through. The second checks that the wrong ones do not, and
 * that the refusal says only what it should — an authorisation error that
 * distinguishes "you are not a member" from "there is no such organization" is
 * a tenant enumeration API with a 403 in front of it.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

/**
 * The refusal a call produced.
 *
 * Also asserts that it produced one: a `.catch()` that silently returns the
 * resolved value would let a test about denial pass against code that allowed.
 */
async function refusalFrom(call: Promise<unknown>): Promise<AccessDeniedError> {
  try {
    await call;
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected an AccessDeniedError, but the call resolved.");
}

/** Arm the membership lookup. `null` means no membership row. */
function armRole(role: string | null): void {
  prisma.organizationMember.findUnique.mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (role === null ? null : { role }) as any,
  );
}

/** Arm the project lookup the project-scoped gate does first. */
function armProject(organizationId: string | null): void {
  prisma.project.findUnique.mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (organizationId === null ? null : { organizationId }) as any,
  );
}

describe("a member with enough rank passes", () => {
  test("an OWNER satisfies every requirement", async () => {
    armRole("OWNER");

    await expect(requireRole("org_1", "u1", "OWNER", prisma)).resolves.toBe("OWNER");
    await expect(requireRole("org_1", "u1", "EDITOR", prisma)).resolves.toBe("OWNER");
    await expect(requireRole("org_1", "u1", "VIEWER", prisma)).resolves.toBe("OWNER");
  });

  test("the held role is returned, so a caller needs no second query", async () => {
    armRole("EDITOR");

    expect(await requireRole("org_1", "u1", "VIEWER", prisma)).toBe("EDITOR");
  });

  test("the lookup is keyed on the pair, not scanned", async () => {
    armRole("EDITOR");

    await requireRole("org_1", "u1", "EDITOR", prisma);

    expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
      where: { organizationId_userId: { organizationId: "org_1", userId: "u1" } },
      select: { role: true },
    });
  });
});

describe("a VIEWER is refused anything that writes", () => {
  test("requireRole throws for a VIEWER asked for EDITOR", async () => {
    armRole("VIEWER");

    await expect(requireRole("org_1", "u1", "EDITOR", prisma)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  test("requireCapability refuses project:write", async () => {
    armRole("VIEWER");

    await expect(
      requireCapability("org_1", "u1", "project:write", prisma),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  test("a VIEWER may still read", async () => {
    armRole("VIEWER");

    await expect(
      requireCapability("org_1", "u1", "project:read", prisma),
    ).resolves.toBe("VIEWER");
  });

  test("the refusal names both roles, because the member may act on it", async () => {
    armRole("VIEWER");

    const error = await refusalFrom(requireRole("org_1", "u1", "EDITOR", prisma));

    expect(error.message).toContain("VIEWER");
    expect(error.message).toContain("EDITOR");
    expect(error.heldRole).toBe("VIEWER");
    expect(error.requiredRole).toBe("EDITOR");
  });
});

describe("an EDITOR is refused what outlives them", () => {
  test("an EDITOR cannot delete a project", async () => {
    armRole("EDITOR");

    await expect(
      requireCapability("org_1", "u1", "project:delete", prisma),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  test("an EDITOR cannot manage members", async () => {
    armRole("EDITOR");

    const error = await refusalFrom(requireCapability("org_1", "u1", "member:manage", prisma));

    // Otherwise the boundary is decorative: an EDITOR who can grant EDITOR has
    // OWNER in every way that matters.
    expect(error.requiredRole).toBe("OWNER");
    expect(error.heldRole).toBe("EDITOR");
  });

  test("an EDITOR can still write", async () => {
    armRole("EDITOR");

    await expect(
      requireCapability("org_1", "u1", "project:write", prisma),
    ).resolves.toBe("EDITOR");
  });
});

describe("a non-member learns nothing", () => {
  test("no membership is a refusal, not a pass", async () => {
    armRole(null);

    await expect(requireRole("org_1", "u1", "VIEWER", prisma)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  test("the message does not say whether the organization exists", async () => {
    armRole(null);

    const error = await refusalFrom(requireRole("org_1", "u1", "VIEWER", prisma));

    // Identical wording whether or not `org_1` is real. A different message per
    // case would let a caller confirm an id by the error it produced.
    expect(error.message).toBe('No access to organization "org_1".');
    expect(error.heldRole).toBeNull();
    expect(error.message).not.toMatch(/not found|does not exist|no such org/i);
  });

  test("heldRole is null, so a route can answer 404 rather than 403", async () => {
    armRole(null);

    const error = await refusalFrom(requireRole("org_1", "u1", "OWNER", prisma));

    expect(error.heldRole).toBeNull();
  });

  test("resolveRole reports absence rather than throwing", async () => {
    armRole(null);

    expect(await resolveRole("org_1", "u1", prisma)).toBeNull();
  });
});

describe("a role the build does not recognise is not a role", () => {
  test("an unknown stored role resolves to no access", async () => {
    // A row written by a newer deployment, or by hand. Treating it as a role
    // would mean deciding access by comparing an unknown string numerically.
    armRole("SUPERUSER");

    expect(await resolveRole("org_1", "u1", prisma)).toBeNull();
    await expect(requireRole("org_1", "u1", "VIEWER", prisma)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
  });

  test("core's roles and the Prisma enum are the same set", () => {
    // Compile-time really, but asserted so the guard is visible in the suite:
    // a role added to the schema and not to `OrgRoleName` would deny every
    // member holding it, and that should be found by a build, not an outage.
    expect(ORG_ROLES_IN_SYNC).toBe(true);
  });
});

describe("the project-scoped gate resolves the organization itself", () => {
  test("it checks against the project's organization, not one it was handed", async () => {
    armProject("org_real");
    armRole("OWNER");

    const result = await requireProjectCapability(
      "prj_1",
      "u1",
      "project:write",
      prisma,
    );

    // A caller holding only a project id cannot accidentally check against an
    // organization it happens to be a member of.
    expect(result.organizationId).toBe("org_real");
    expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
      where: { organizationId_userId: { organizationId: "org_real", userId: "u1" } },
      select: { role: true },
    });
  });

  test("a VIEWER is refused on a project they can see", async () => {
    armProject("org_real");
    armRole("VIEWER");

    await expect(
      requireProjectCapability("prj_1", "u1", "project:write", prisma),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  test("a project that does not exist refuses without a membership lookup", async () => {
    armProject(null);

    const error = await refusalFrom(requireProjectCapability(
      "prj_gone",
      "u1",
      "project:write",
      prisma,
    ));

    expect(error).toBeInstanceOf(AccessDeniedError);
    expect(error.heldRole).toBeNull();
    // Nothing was asked about membership, so nothing about it can leak.
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  test("organizationOfProject reports absence as null", async () => {
    armProject(null);

    expect(await organizationOfProject("prj_gone", prisma)).toBeNull();
  });
});
