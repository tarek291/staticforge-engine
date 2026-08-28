import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuditRecord } from "@staticforge/core";

import { withDbRetry } from "./retry.js";

/**
 * Writing and reading the audit trail.
 *
 * The table is append-only by convention — nothing here updates or deletes a
 * row, and nothing cascades into it. A trail that can be edited by the same
 * credential that performs the actions is a trail that answers whatever the
 * last writer wanted it to.
 */

/** One stored audit entry, as a reader sees it. */
export interface AuditEntry extends AuditRecord {
  id: string;
  createdAt: string;
}

/**
 * Record that something happened.
 *
 * Retried, because a lost audit row is a gap in the answer to a question
 * somebody will ask later, and the retry costs nothing when the write succeeds
 * first time.
 *
 * `details` is stored as given. It is the one place in this schema without a
 * shape contract, deliberately: an audit trail whose fields are pinned stops
 * recording the ones added after it, which are exactly the ones an
 * investigation needs.
 *
 * @param record - What happened, to what, caused by whom.
 * @param prisma - The client to write with.
 * @returns The id of the row written.
 */
export async function recordAuditEvent(
  record: AuditRecord,
  prisma: PrismaClient,
): Promise<string> {
  const row = await withDbRetry(() =>
    prisma.auditLog.create({
      data: {
        action: record.action,
        resourceId: record.resourceId,
        userId: record.userId,
        organizationId: record.organizationId,
        details: record.details as Prisma.InputJsonObject,
      },
      select: { id: true },
    }),
  );

  return row.id;
}

/** Options for {@link listAuditEvents}. */
export interface AuditQuery {
  /** Most rows to return. Capped, because this is rendered. */
  limit?: number;
  /** Only entries for one action, e.g. `project.synced`. */
  action?: string;
  /** Only entries touching one resource. */
  resourceId?: string;
}

/** The largest page this will return, whatever a caller asks for. */
export const MAX_AUDIT_PAGE = 200;

/**
 * Read an organization's audit trail.
 *
 * Scoped to one organization and nothing else. There is no unscoped read here
 * on purpose: the first convenience function that returns "all recent activity"
 * is the one that ends up behind a dashboard route, and an audit trail that
 * leaks across tenants is worse than none — it is a breach recorded in the
 * product that was sold as the safeguard.
 *
 * Callers must still check that the caller may read this organization;
 * `requireRole` is that check, and it is deliberately not called here so this
 * module stays a data accessor rather than half a gate.
 *
 * @returns Newest first.
 */
export async function listAuditEvents(
  organizationId: string,
  prisma: PrismaClient,
  query: AuditQuery = {},
): Promise<AuditEntry[]> {
  const rows = await withDbRetry(() =>
    prisma.auditLog.findMany({
      where: {
        organizationId,
        ...(query.action !== undefined ? { action: query.action } : {}),
        ...(query.resourceId !== undefined ? { resourceId: query.resourceId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(1, query.limit ?? 50), MAX_AUDIT_PAGE),
    }),
  );

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    resourceId: row.resourceId,
    userId: row.userId,
    organizationId: row.organizationId,
    details: (row.details ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * An audit writer bound to a client.
 *
 * What the plugin is handed at construction. The plugin contract gives a plugin
 * no database handle of its own — this is the seam where the composition root
 * decides what it may reach, in one visible place.
 */
export function createAuditWriter(
  prisma: PrismaClient,
): (record: AuditRecord) => Promise<void> {
  return async (record) => {
    await recordAuditEvent(record, prisma);
  };
}
