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
 *
 * ## Why there is no production default
 *
 * There was one: an unset variable meant `"local-operator"`, the identity the
 * CLI runs as and the OWNER the seed installs. Convenient, and the wrong shape
 * for a privilege boundary.
 *
 * Nothing reachable over HTTP can currently *be* `"local-operator"` — a session
 * id is the provider's UUID and a key principal is `apikey:…` — so this was not
 * an open door. But it was a door held shut by facts about other modules rather
 * than by anything here, and the list of ways a `userId` gets set is exactly the
 * list of things that change. `STATICFORGE_USER_ID` already overrides it for the
 * CLI; one future import path, admin tool or fixture that trusts a supplied id
 * turns a guessable constant into platform authority.
 *
 * So outside development the fallback is gone. An unset variable means **there
 * is no platform operator**, and every platform operation refuses until somebody
 * names one. That is a deployment that cannot set quotas rather than a
 * deployment where a well-known string can — and of the two ways to be wrong,
 * that is the recoverable one.
 *
 * Development keeps the default, because the alternative is an environment
 * variable required to run the seed on a laptop, and a required variable with an
 * obvious value is a variable that gets exported in a shell profile and then
 * copied into production.
 */

/** The identity this deployment treats as the platform itself. */
export const PLATFORM_OPERATOR_ENV_VAR = "STATICFORGE_PLATFORM_OPERATOR";

/**
 * Development-only fallback — the same principal the CLI runs as.
 *
 * Applied when `NODE_ENV` is not `"production"`. In production an unset variable
 * means there is no platform operator at all; see the note above.
 */
export const DEFAULT_PLATFORM_OPERATOR = "local-operator";

/**
 * Whether this process is a production deployment.
 *
 * Anything that is not literally `"production"` is treated as development,
 * which is the direction that fails safe: a production box whose `NODE_ENV` is
 * unset or misspelt gets the *stricter* behaviour, not the looser one. The
 * opposite default would hand the fallback to exactly the deployment careless
 * enough to lose its `NODE_ENV`.
 */
function isProduction(env: NodeJS.ProcessEnv): boolean {
  return env["NODE_ENV"] === "production";
}

/**
 * Who this deployment accepts as the platform, or `null` when nobody is.
 *
 * @returns The configured identity; in development, `"local-operator"` when
 * unset; in production, `null` — which no principal can equal, so every
 * platform operation refuses.
 */
export function platformOperatorId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env[PLATFORM_OPERATOR_ENV_VAR]?.trim();

  if (configured !== undefined && configured !== "") {
    return configured;
  }

  return isProduction(env) ? null : DEFAULT_PLATFORM_OPERATOR;
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

  const operator = platformOperatorId(env);

  // `null` means no operator is configured, and the comparison has to be made
  // explicitly rather than left to `===`. It would be correct by accident today
  // — no principal is `null` — but the guard is the point: the answer to "is
  // this the platform" when there is no platform must be no, stated once, here.
  if (operator === null) {
    return false;
  }

  return actingUserId === operator;
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
    const configured = platformOperatorId(env) !== null;

    throw new UnauthorizedError(
      `This is a platform operation and "${
        typeof actingUserId === "string" ? actingUserId : "(none)"
      }" is not the platform operator. No tenant role grants it.` +
        (configured
          ? ""
          : ` No platform operator is configured: set ${PLATFORM_OPERATOR_ENV_VAR}.`),
    );
  }

  return actingUserId as string;
}
