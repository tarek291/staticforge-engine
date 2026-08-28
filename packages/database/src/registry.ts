import type { PrismaClient } from "@prisma/client";
import {
  ContentProfileSchema,
  TemplateDefinitionSchema,
  type ContentProfile,
  type TemplateDefinition,
} from "@staticforge/schemas";

import { withDbRetry } from "./retry.js";

/**
 * Loading templates and content profiles a tenant may use.
 *
 * These were compile-time constants, which made every new policy a code change
 * and a deploy — the wrong shape for something a tenant is meant to pick and
 * eventually buy. Moving them into rows makes them data.
 *
 * ## The database is not a trusted input
 *
 * That is the entire difficulty. A constant was checked by the compiler; a row
 * is checked by nobody until something checks it. So every definition is parsed
 * against the same schema the engine's own types come from, on the way out, and
 * a row that does not describe a real profile or template is refused rather
 * than half-applied.
 *
 * ## Refused, not skipped
 *
 * A corrupt row could be dropped from the registry, and the build would then
 * fail later with "unknown profile" — pointing at the page rather than at the
 * broken row, for a problem the page did not cause. Worse, a corrupt row whose
 * key shadows a global one would silently restore the global, and the tenant
 * would get a policy they had edited away from with no indication.
 *
 * So a malformed row is an error about *that row*, reported with its key and
 * the field that failed.
 */

/**
 * The owner a shipped, shared row carries.
 *
 * A sentinel rather than NULL. Postgres treats NULL as distinct from every
 * other NULL, so a unique constraint over a nullable owner would permit two
 * rows both claiming to be the global "default" — the one duplicate that must
 * be impossible. A real value makes the constraint enforce what it reads as.
 */
export const GLOBAL_OWNER_ID = "__global__";

/** A definition that does not satisfy its schema. */
export interface RegistryIssue {
  kind: "profile" | "template";
  key: string;
  path: string;
  message: string;
}

/** Thrown when any stored definition is unusable. Reports every one at once. */
export class RegistryLoadError extends Error {
  override readonly name = "RegistryLoadError";

  constructor(readonly issues: RegistryIssue[]) {
    super(
      `${issues.length} stored definition(s) are invalid: ` +
        issues
          .slice(0, 3)
          .map((issue) => `${issue.kind} "${issue.key}" — ${issue.path}: ${issue.message}`)
          .join("; ") +
        (issues.length > 3 ? " …" : ""),
    );
  }
}

/**
 * Rows a caller may use.
 *
 * Global rows, plus the caller's own. A row that is neither global nor owned
 * belongs to nobody, and is invisible here rather than treated as shared —
 * "not assigned yet" must never default to "available to everyone".
 */
function visibleTo(userId: string) {
  return { OR: [{ isGlobal: true }, { userId }] };
}

/**
 * Collapse global and tenant rows into one registry.
 *
 * A tenant's own row wins over a global one with the same key. That is the
 * point of tenant rows: overriding the shipped default is the ordinary case,
 * not a conflict. Applied after the read, because expressing "prefer mine"
 * in the query would cost a second round trip to say something this cheap.
 */
function collapse<T extends { key: string; userId: string }>(rows: T[]): T[] {
  const byKey = new Map<string, T>();

  for (const row of rows) {
    const existing = byKey.get(row.key);
    const existingIsGlobal = existing?.userId === GLOBAL_OWNER_ID;
    const incomingIsOwned = row.userId !== GLOBAL_OWNER_ID;

    if (existing === undefined || (existingIsGlobal && incomingIsOwned)) {
      byKey.set(row.key, row);
    }
  }

  return [...byKey.values()];
}

/**
 * Load the content profiles this caller may use.
 *
 * @param userId - The owner the caller is acting as.
 * @returns Profiles by key, ready to hand to the generator.
 * @throws {RegistryLoadError} If any stored definition is malformed.
 */
export async function loadProfileRegistry(
  userId: string,
  prisma: PrismaClient,
): Promise<Record<string, ContentProfile>> {
  const rows = await withDbRetry(() =>
    prisma.contentProfile.findMany({
      where: visibleTo(userId),
      select: { key: true, name: true, definition: true, userId: true },
    }),
  );

  const registry: Record<string, ContentProfile> = Object.create(null);
  const issues: RegistryIssue[] = [];

  for (const row of collapse(rows)) {
    const parsed = ContentProfileSchema.safeParse(row.definition);

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          kind: "profile",
          key: row.key,
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        });
      }
      continue;
    }

    // The row's key is what pages reference, so it wins over whatever `id` the
    // definition carries. A definition whose id disagreed with its key would
    // otherwise be resolvable under two names, only one of which is real.
    registry[row.key] = { ...parsed.data, id: row.key };
  }

  if (issues.length > 0) {
    throw new RegistryLoadError(issues);
  }

  return registry;
}

/** A template, as the engine consumes it. */
export interface ResolvedTemplate {
  key: string;
  name: string;
  definition: TemplateDefinition;
}

/**
 * Load the templates this caller may use.
 *
 * @throws {RegistryLoadError} If any stored definition is malformed.
 */
export async function loadTemplateRegistry(
  userId: string,
  prisma: PrismaClient,
): Promise<Record<string, ResolvedTemplate>> {
  const rows = await withDbRetry(() =>
    prisma.template.findMany({
      where: visibleTo(userId),
      select: { key: true, name: true, definition: true, userId: true },
    }),
  );

  const registry: Record<string, ResolvedTemplate> = Object.create(null);
  const issues: RegistryIssue[] = [];

  for (const row of collapse(rows)) {
    const parsed = TemplateDefinitionSchema.safeParse(row.definition);

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          kind: "template",
          key: row.key,
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        });
      }
      continue;
    }

    registry[row.key] = { key: row.key, name: row.name, definition: parsed.data };
  }

  if (issues.length > 0) {
    throw new RegistryLoadError(issues);
  }

  return registry;
}
