import { UnauthorizedError } from "@staticforge/core";

/**
 * The boundary above every tenant.
 *
 * ## Why a quota cannot be guarded by a tenant capability
 *
 * The obvious fix for an ungated `setQuota` is `requireCapability(org, user,
 * "member:manage")` — the strictest thing a tenant role can be asked for. It is
 * also the wrong fix, and worse than leaving it ungated: `member:manage` is
 * held by OWNER, every organization has an OWNER, and the OWNER is the person
 * the quota exists to bill. A gate they satisfy is a gate that lets them raise
 * their own spending cap, which converts a commercial limit into a suggestion
 * and does it while looking like a security improvement.
 *
 * Some operations do not belong to any tenant. Setting a plan's ceiling is one:
 * it is sold, not self-served. So it is guarded by a different question — is
 * this the platform, rather than a customer of it — and no tenant role can ever
 * answer yes.
 *
 * ## What this is today, and what it is not
 *
 * A single operator identity, the same one the CLI runs as. That is honest for
 * a system with one operator and it is explicitly *not* a permission model: it
 * cannot express two administrators, an audit of who changed a limit, or a
 * support engineer with read-only access to billing.
 *
 * What it does provide is a boundary that exists in code rather than in a
 * convention about which functions routes are allowed to call. When a real
 * platform-admin role arrives, this is the one place it replaces.
 */

/** The identity this deployment treats as the platform itself. */
export const PLATFORM_OPERATOR_ENV_VAR = "STATICFORGE_PLATFORM_OPERATOR";

/** Fallback platform identity — the same principal the CLI runs as. */
export const DEFAULT_PLATFORM_OPERATOR = "local-operator";

/**
 * Who this deployment accepts as the platform.
 *
 * Overridable, because "the operator is called local-operator" is true of a
 * laptop and of nowhere else.
 */
export function platformOperatorId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[PLATFORM_OPERATOR_ENV_VAR]?.trim();

  return configured === undefined || configured === ""
    ? DEFAULT_PLATFORM_OPERATOR
    : configured;
}

/**
 * Whether a principal is the platform rather than a tenant.
 *
 * An API-key principal is never the platform, whatever its id. Keys are issued
 * *to* organizations by definition, so a key that satisfied this check would be
 * a tenant credential holding platform authority — and it would be issued by
 * the very function this guards.
 */
export function isPlatformOperator(
  actingUserId: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof actingUserId !== "string" || actingUserId === "") {
    return false;
  }

  if (actingUserId.startsWith("apikey:")) {
    return false;
  }

  return actingUserId === platformOperatorId(env);
}

/**
 * Refuse unless the caller is the platform.
 *
 * Throws `UnauthorizedError` rather than `AccessDeniedError` deliberately: this
 * is not "your role is too weak", which invites an operator to go and ask for a
 * bigger one. There is no tenant role that satisfies it, and the message should
 * not suggest otherwise.
 *
 * @throws {UnauthorizedError} For any tenant principal, any API key, and any
 * absent or malformed identity.
 */
export function requirePlatformOperator(
  actingUserId: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isPlatformOperator(actingUserId, env)) {
    throw new UnauthorizedError(
      `This is a platform operation and "${
        typeof actingUserId === "string" ? actingUserId : "(none)"
      }" is not the platform operator. No tenant role grants it.`,
    );
  }

  return actingUserId as string;
}
