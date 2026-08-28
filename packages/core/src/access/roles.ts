/**
 * What a member of an organization may do.
 *
 * Pure: no database, no client, no I/O. The decision "does this role satisfy
 * that requirement" is arithmetic over a fixed ordering, and keeping it here
 * means the dashboard can grey out a button using exactly the rule the server
 * enforces — rather than a second, hand-written copy that drifts until the UI
 * offers an action the API refuses.
 *
 * ## Why a rank and not a permission matrix
 *
 * A matrix invites per-action exceptions, and the first exception is the one
 * nobody reviews. Three ordered roles answer every question this product has,
 * and where an action needs more than "may write" — deleting a project,
 * changing who has access — it is expressed as *requiring OWNER*, not as a flag
 * bolted onto EDITOR.
 *
 * ## Why absence is a value here
 *
 * `undefined` means "not a member", and every function in this module treats it
 * as a denial rather than as a missing argument. An authorisation helper that
 * threw on absence would push the most security-relevant branch out to every
 * caller, and the caller that forgets it is the one that fails open.
 */

/** A role, as stored. Mirrors the `OrgRole` enum in the Prisma schema. */
export type OrgRoleName = "OWNER" | "EDITOR" | "VIEWER";

/**
 * The ordering. Higher satisfies lower.
 *
 * Numbers rather than an array index, so a role inserted in the middle later is
 * a deliberate renumbering rather than a silent shift of everything above it.
 */
export const ORG_ROLE_RANK: Readonly<Record<OrgRoleName, number>> = Object.freeze({
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
});

/** Every role, weakest first. */
export const ORG_ROLES: readonly OrgRoleName[] = Object.freeze([
  "VIEWER",
  "EDITOR",
  "OWNER",
] as const);

/**
 * Whether a value is a role this system knows.
 *
 * Used on data coming *out* of the database. A row holding a role this build
 * does not recognise — written by a newer deployment, or by hand — must not be
 * compared numerically against anything: `undefined >= 2` is `false`, which
 * happens to be safe, but relying on a coercion for a security decision is how
 * the next refactor introduces a hole.
 */
export function isOrgRole(value: unknown): value is OrgRoleName {
  // Set membership, not `in`. `"constructor" in ORG_ROLE_RANK` is true — the
  // operator walks the prototype chain — so `in` would accept `constructor`,
  // `toString` and every other inherited key as a role name. Nothing downstream
  // would then compare successfully, so this happens to fail closed today; a
  // recogniser that is only accidentally right is one the next refactor breaks.
  return typeof value === "string" && KNOWN_ROLES.has(value);
}

/** Own keys only. See {@link isOrgRole}. */
const KNOWN_ROLES: ReadonlySet<string> = new Set<string>(["VIEWER", "EDITOR", "OWNER"]);

/**
 * Whether a held role meets a requirement.
 *
 * @param held - The role the user actually has, or `undefined`/unknown when
 * they are not a member.
 * @param required - The minimum role the action needs.
 * @returns Whether to allow. Fails closed on anything it does not recognise.
 */
export function roleSatisfies(held: unknown, required: OrgRoleName): boolean {
  if (!isOrgRole(held)) {
    return false;
  }

  return ORG_ROLE_RANK[held] >= ORG_ROLE_RANK[required];
}

/**
 * Named things a caller can want to do.
 *
 * The list is short on purpose. A capability per API endpoint would be a
 * permission matrix wearing different clothes; these are the four distinctions
 * the product actually makes, and every endpoint maps onto one of them.
 */
export type OrgCapability =
  /** Read a project and its pages. */
  | "project:read"
  /** Change content or run the engine — editing, syncing, generating. */
  | "project:write"
  /** Delete a project and everything under it. */
  | "project:delete"
  /** Add, remove, or re-role a member. */
  | "member:manage";

/**
 * The minimum role each capability needs.
 *
 * Two entries carry the requirements this phase exists for. `project:write` is
 * EDITOR, so a VIEWER cannot sync, generate, or edit a page — a viewer who
 * could trigger a paid AI run would make "read only" meaningless in the one
 * dimension that has a bill attached. `project:delete` and `member:manage` are
 * OWNER, so an EDITOR cannot destroy a project or grant themselves help doing
 * it: both are actions whose damage outlives the person taking them.
 */
export const CAPABILITY_MINIMUM_ROLE: Readonly<Record<OrgCapability, OrgRoleName>> =
  Object.freeze({
    "project:read": "VIEWER",
    "project:write": "EDITOR",
    "project:delete": "OWNER",
    "member:manage": "OWNER",
  });

/**
 * Whether a held role can exercise a capability.
 *
 * @param held - The role the user has, or `undefined` when they are not a member.
 * @param capability - What they are trying to do.
 */
export function canPerform(held: unknown, capability: OrgCapability): boolean {
  return roleSatisfies(held, CAPABILITY_MINIMUM_ROLE[capability]);
}

/**
 * One line explaining a refusal, for a member.
 *
 * Only ever shown to someone who *is* a member: they already know the
 * organization exists, so naming their role tells them nothing they could not
 * read off their own profile, and saves a support thread. A non-member is told
 * nothing at all — see `requireRole` in `@staticforge/database`.
 */
export function describeRoleRefusal(held: OrgRoleName, required: OrgRoleName): string {
  return (
    `This action needs the ${required} role and you have ${held}. ` +
    `Ask an OWNER of this organization to change your role.`
  );
}
