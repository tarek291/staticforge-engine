import type { OrgRole as PrismaOrgRole, PrismaClient } from "@prisma/client";
import {
  canPerform,
  describeRoleRefusal,
  isOrgRole,
  roleSatisfies,
  type OrgCapability,
  type OrgRoleName,
} from "@staticforge/core";

import { withDbRetry } from "./retry.js";

/**
 * The authorisation gate.
 *
 * One function that every write goes through, rather than a check per route.
 * A check per route is a check somebody forgets to add to route number nine,
 * and the evidence that they forgot is a customer's VIEWER deleting a project.
 *
 * ## Why it throws
 *
 * A boolean return would make the safe path and the unsafe path look the same
 * at the call site: `await canWrite(...)` compiles, does the query, discards the
 * answer, and carries on writing. Throwing means forgetting to handle the
 * refusal fails loudly rather than silently allowing it — the failure mode
 * points the right way.
 *
 * ## Why the two refusals are worded differently
 *
 * A **non-member** is told only that they have no access, in language identical
 * to what a non-existent organization would produce. Distinguishing the two
 * would turn this gate into a way to enumerate tenants: try an id, and a
 * different message means it is real.
 *
 * A **member with too weak a role** is told their role and what the action
 * needs. That is not a leak — they already know the organization exists and
 * what their own role is — and withholding it produces a support thread instead
 * of a self-service fix.
 */

/**
 * Compile-time proof that core's role union and the Prisma enum are the same
 * set.
 *
 * If a role is added to the schema and not to `OrgRoleName`, this stops
 * compiling. Without it the new role would flow into `roleSatisfies`, be
 * rejected by `isOrgRole`, and deny every member who holds it — safe, but
 * discovered by an outage rather than by a build.
 */
export type OrgRoleParity = [OrgRoleName] extends [PrismaOrgRole]
  ? [PrismaOrgRole] extends [OrgRoleName]
    ? true
    : never
  : never;

/** See {@link OrgRoleParity}. */
export const ORG_ROLES_IN_SYNC: OrgRoleParity = true;

/** A refusal by the authorisation gate. */
export class AccessDeniedError extends Error {
  override readonly name = "AccessDeniedError";

  /** The organization the check was against. */
  readonly organizationId: string;

  /** Who was refused. */
  readonly userId: string;

  /** What the action needed. */
  readonly requiredRole: OrgRoleName;

  /**
   * What the caller actually held, or `null` when they are not a member.
   *
   * Carried on the error rather than only in the message so a route can answer
   * `404` for a non-member and `403` for an under-privileged one without
   * parsing prose — while the *message* stays identical for the first case.
   */
  readonly heldRole: OrgRoleName | null;

  constructor(details: {
    organizationId: string;
    userId: string;
    requiredRole: OrgRoleName;
    heldRole: OrgRoleName | null;
    message: string;
  }) {
    super(details.message);
    this.organizationId = details.organizationId;
    this.userId = details.userId;
    this.requiredRole = details.requiredRole;
    this.heldRole = details.heldRole;
  }
}

/**
 * Read a user's role in an organization.
 *
 * @returns The role, or `null` when there is no membership row — which is also
 * the answer for an organization that does not exist. The two are deliberately
 * the same.
 */
export async function resolveRole(
  organizationId: string,
  userId: string,
  prisma: PrismaClient,
): Promise<OrgRoleName | null> {
  const membership = await withDbRetry(() =>
    prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true },
    }),
  );

  if (membership === null || membership === undefined) {
    return null;
  }

  // Validated rather than cast. A row holding a role this build does not know
  // is not a role; treating it as one would mean comparing an unknown string
  // numerically and trusting whatever falls out.
  return isOrgRole(membership.role) ? membership.role : null;
}

/**
 * Refuse unless the user holds at least `requiredRole` in the organization.
 *
 * The gate every write is expected to pass through. It reads one indexed row
 * and is cheap enough that there is no argument for skipping it on a path
 * "that already checked".
 *
 * @param organizationId - The organization the resource belongs to.
 * @param userId - The caller.
 * @param requiredRole - The minimum role the action needs.
 * @param prisma - The client to read with. Injected so the gate is testable
 * against a mock with no database.
 * @returns The role actually held, so a caller that wants to vary behaviour by
 * role does not need a second query.
 * @throws {AccessDeniedError} If the user is not a member, or holds a weaker
 * role than the action requires.
 */
export async function requireRole(
  organizationId: string,
  userId: string,
  requiredRole: OrgRoleName,
  prisma: PrismaClient,
): Promise<OrgRoleName> {
  const held = await resolveRole(organizationId, userId, prisma);

  if (held === null) {
    throw new AccessDeniedError({
      organizationId,
      userId,
      requiredRole,
      heldRole: null,
      // Identical to what a non-existent organization produces. An id that
      // answered differently would be an id an attacker could confirm.
      message: `No access to organization "${organizationId}".`,
    });
  }

  if (!roleSatisfies(held, requiredRole)) {
    throw new AccessDeniedError({
      organizationId,
      userId,
      requiredRole,
      heldRole: held,
      message: describeRoleRefusal(held, requiredRole),
    });
  }

  return held;
}

/**
 * Refuse unless the user may exercise a capability.
 *
 * The form most call sites should use: `"project:write"` says what the code is
 * about to do, where `"EDITOR"` says only how much rank it happens to need
 * today. If the minimum for writing ever changes, it changes in one map rather
 * than at every call site that spelled out a role.
 *
 * @throws {AccessDeniedError} As {@link requireRole}.
 */
export async function requireCapability(
  organizationId: string,
  userId: string,
  capability: OrgCapability,
  prisma: PrismaClient,
): Promise<OrgRoleName> {
  const held = await resolveRole(organizationId, userId, prisma);

  if (held !== null && canPerform(held, capability)) {
    return held;
  }

  // Delegated rather than duplicated, so the two refusal messages cannot drift
  // apart — and so a capability whose minimum role changes cannot keep quoting
  // the old one.
  return requireRole(
    organizationId,
    userId,
    CAPABILITY_ROLE[capability],
    prisma,
  );
}

/** Local alias, so this module does not re-export core's map by accident. */
const CAPABILITY_ROLE: Readonly<Record<OrgCapability, OrgRoleName>> = {
  "project:read": "VIEWER",
  "project:write": "EDITOR",
  "project:delete": "OWNER",
  "member:manage": "OWNER",
};

/**
 * The organization a project belongs to.
 *
 * Read on its own rather than folded into a wider query, because the gate has
 * to run *before* the code that would otherwise have loaded the project — an
 * authorisation check that happens after the read it protects has already
 * disclosed the thing it was protecting.
 *
 * @returns The organization id, or `null` when the project does not exist.
 */
export async function organizationOfProject(
  projectId: string,
  prisma: PrismaClient,
): Promise<string | null> {
  const project = await withDbRetry(() =>
    prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true },
    }),
  );

  return project?.organizationId ?? null;
}

/**
 * Refuse unless the user may exercise a capability on a project.
 *
 * Resolves the project's organization first, so a caller holding only a project
 * id — which is every route — cannot accidentally check against the wrong
 * organization by passing one it happened to have.
 *
 * A project that does not exist refuses with the same shape as one the caller
 * cannot reach, for the reason every other refusal here does.
 *
 * @throws {AccessDeniedError} If the project is unreachable or the role is too
 * weak.
 */
export async function requireProjectCapability(
  projectId: string,
  userId: string,
  capability: OrgCapability,
  prisma: PrismaClient,
): Promise<{ organizationId: string; role: OrgRoleName }> {
  const organizationId = await organizationOfProject(projectId, prisma);

  if (organizationId === null) {
    throw new AccessDeniedError({
      organizationId: "",
      userId,
      requiredRole: CAPABILITY_ROLE[capability],
      heldRole: null,
      message: `No access to project "${projectId}".`,
    });
  }

  const role = await requireCapability(organizationId, userId, capability, prisma);

  return { organizationId, role };
}
