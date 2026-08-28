import { describe, expect, test } from "vitest";

import {
  CAPABILITY_MINIMUM_ROLE,
  ORG_ROLES,
  ORG_ROLE_RANK,
  canPerform,
  describeRoleRefusal,
  isOrgRole,
  roleSatisfies,
  type OrgCapability,
  type OrgRoleName,
} from "./roles.js";

/**
 * The authorisation rule, in isolation.
 *
 * Every test here is about a *denial*, because that is the direction this code
 * fails silently in. A gate that wrongly refuses produces a support ticket
 * within the hour; a gate that wrongly allows produces nothing at all until
 * somebody notices a deleted project.
 */

describe("the ordering is the whole model", () => {
  test("OWNER outranks EDITOR outranks VIEWER", () => {
    expect(ORG_ROLE_RANK.OWNER).toBeGreaterThan(ORG_ROLE_RANK.EDITOR);
    expect(ORG_ROLE_RANK.EDITOR).toBeGreaterThan(ORG_ROLE_RANK.VIEWER);
  });

  test("a role satisfies itself", () => {
    for (const role of ORG_ROLES) {
      expect(roleSatisfies(role, role)).toBe(true);
    }
  });

  test("a stronger role satisfies a weaker requirement", () => {
    expect(roleSatisfies("OWNER", "EDITOR")).toBe(true);
    expect(roleSatisfies("OWNER", "VIEWER")).toBe(true);
    expect(roleSatisfies("EDITOR", "VIEWER")).toBe(true);
  });

  test("a weaker role never satisfies a stronger requirement", () => {
    expect(roleSatisfies("VIEWER", "EDITOR")).toBe(false);
    expect(roleSatisfies("VIEWER", "OWNER")).toBe(false);
    expect(roleSatisfies("EDITOR", "OWNER")).toBe(false);
  });
});

describe("anything unrecognised is a denial", () => {
  test("no membership is refused", () => {
    // `undefined` means "not a member" and is handled here rather than pushed
    // out to every caller. The caller that forgets is the one that fails open.
    expect(roleSatisfies(undefined, "VIEWER")).toBe(false);
    expect(roleSatisfies(null, "VIEWER")).toBe(false);
  });

  test("a role this build does not know is refused", () => {
    // A row written by a newer deployment, or by hand. Comparing it numerically
    // would mean a security decision resting on a coercion.
    expect(roleSatisfies("SUPERUSER", "VIEWER")).toBe(false);
    expect(roleSatisfies("owner", "VIEWER")).toBe(false);
    expect(isOrgRole("owner")).toBe(false);
  });

  test("non-strings are refused", () => {
    for (const value of [3, true, {}, [], () => {}]) {
      expect(roleSatisfies(value, "VIEWER")).toBe(false);
    }
  });

  test("a value matching an Object prototype key is not a role", () => {
    // `"constructor" in ORG_ROLE_RANK` is true on a plain object. It is not a
    // role, and a membership check that said otherwise would let a crafted
    // string pass the recogniser.
    expect(isOrgRole("constructor")).toBe(false);
    expect(isOrgRole("toString")).toBe(false);
    expect(roleSatisfies("constructor", "VIEWER")).toBe(false);
  });
});

describe("a VIEWER may read and nothing else", () => {
  test("a VIEWER can read", () => {
    expect(canPerform("VIEWER", "project:read")).toBe(true);
  });

  test("a VIEWER cannot write, which is what blocks syncing and generating", () => {
    // The requirement this phase exists for. A viewer who could trigger a run
    // would make "read only" meaningless in the one dimension with a bill.
    expect(canPerform("VIEWER", "project:write")).toBe(false);
  });

  test("a VIEWER cannot delete or manage members", () => {
    expect(canPerform("VIEWER", "project:delete")).toBe(false);
    expect(canPerform("VIEWER", "member:manage")).toBe(false);
  });
});

describe("an EDITOR may change content but not who has access", () => {
  test("an EDITOR can read and write", () => {
    expect(canPerform("EDITOR", "project:read")).toBe(true);
    expect(canPerform("EDITOR", "project:write")).toBe(true);
  });

  test("an EDITOR cannot delete a project", () => {
    // Deleting cascades through every page, job and audit-relevant row under
    // it. The damage outlives the person doing it.
    expect(canPerform("EDITOR", "project:delete")).toBe(false);
  });

  test("an EDITOR cannot add a member", () => {
    // Otherwise the boundary is decorative: an EDITOR who can grant EDITOR can
    // grant it to anyone, and the role stops describing a limit.
    expect(canPerform("EDITOR", "member:manage")).toBe(false);
  });
});

describe("an OWNER may do everything", () => {
  test("every capability is open to an OWNER", () => {
    for (const capability of Object.keys(CAPABILITY_MINIMUM_ROLE) as OrgCapability[]) {
      expect(canPerform("OWNER", capability)).toBe(true);
    }
  });

  test("every capability names a role that exists", () => {
    for (const required of Object.values(CAPABILITY_MINIMUM_ROLE)) {
      expect(isOrgRole(required)).toBe(true);
    }
  });
});

describe("the refusal message", () => {
  test("names both the held role and the required one", () => {
    const message = describeRoleRefusal("VIEWER", "EDITOR");

    expect(message).toContain("VIEWER");
    expect(message).toContain("EDITOR");
  });

  test("tells the reader who can fix it", () => {
    // A refusal that does not say what to do next becomes a support thread.
    expect(describeRoleRefusal("EDITOR", "OWNER")).toMatch(/OWNER/);
  });
});

describe("the tables stay in step with each other", () => {
  test("every role has a rank", () => {
    for (const role of ORG_ROLES) {
      expect(typeof ORG_ROLE_RANK[role]).toBe("number");
    }
  });

  test("ranks are distinct, so no two roles are silently equivalent", () => {
    const ranks = ORG_ROLES.map((role: OrgRoleName) => ORG_ROLE_RANK[role]);

    expect(new Set(ranks).size).toBe(ranks.length);
  });

  test("the tables are frozen, so a caller cannot promote itself at runtime", () => {
    // Not paranoia about a hostile caller so much as about a plugin or a test
    // helper mutating shared state and leaving every later check wrong.
    expect(Object.isFrozen(ORG_ROLE_RANK)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_MINIMUM_ROLE)).toBe(true);
  });
});
