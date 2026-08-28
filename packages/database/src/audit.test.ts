import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";
import {
  createDatabaseAuditLoggerPlugin,
  registerPlugins,
  type AuditRecord,
} from "@staticforge/core";

import {
  MAX_AUDIT_PAGE,
  createAuditWriter,
  listAuditEvents,
  recordAuditEvent,
} from "./audit.js";

/**
 * The audit trail reaching the database.
 *
 * `database-audit-logger.test.ts` proves the plugin produces the right records.
 * This proves the records become rows, and — the half that carries the security
 * property — that reading them cannot cross a tenant boundary.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" } as any);
});

/** The `data` the last create was called with. */
function createdData(): Record<string, unknown> {
  const call = prisma.auditLog.create.mock.calls[0]?.[0] as
    | { data: Record<string, unknown> }
    | undefined;

  if (call === undefined) {
    throw new Error("auditLog.create was never called.");
  }

  return call.data;
}

const RECORD: AuditRecord = {
  action: "project.synced",
  resourceId: "prj_1",
  userId: "u1",
  organizationId: "org_1",
  details: { changed: true, jobId: "job_1" },
};

describe("a record becomes a row", () => {
  test("every field is written", async () => {
    await recordAuditEvent(RECORD, prisma);

    expect(createdData()).toMatchObject({
      action: "project.synced",
      resourceId: "prj_1",
      userId: "u1",
      organizationId: "org_1",
      details: { changed: true, jobId: "job_1" },
    });
  });

  test("the row id is returned", async () => {
    expect(await recordAuditEvent(RECORD, prisma)).toBe("audit_1");
  });

  test("details are stored as given, not reshaped", async () => {
    await recordAuditEvent(
      { ...RECORD, details: { anythingAtAll: [1, 2], nested: { ok: true } } },
      prisma,
    );

    // The one place in this schema without a shape contract. An audit trail
    // whose fields are pinned stops recording the ones added after it, which
    // are exactly the ones an investigation needs.
    expect(createdData()["details"]).toEqual({
      anythingAtAll: [1, 2],
      nested: { ok: true },
    });
  });

  test("a record outside an organization is still written", async () => {
    await recordAuditEvent({ ...RECORD, organizationId: null }, prisma);

    expect(createdData()["organizationId"]).toBeNull();
  });

  test("nothing here updates or deletes", async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);

    await recordAuditEvent(RECORD, prisma);
    await listAuditEvents("org_1", prisma);

    // Append-only by construction. A trail the acting credential can edit is a
    // trail that answers whatever the last writer wanted it to.
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.deleteMany).not.toHaveBeenCalled();
  });
});

describe("the plugin's records reach the table through the injected writer", () => {
  test("a job completion emitted on a real bus is written as a row", async () => {
    const { hooks } = registerPlugins([
      createDatabaseAuditLoggerPlugin({ write: createAuditWriter(prisma) }),
    ]);

    const result = await hooks.emit("afterJobCompleted", {
      jobId: "job_7",
      projectId: "prj_1",
      userId: "u1",
      organizationId: "org_1",
      kind: "GENERATE",
      ok: true,
      exitCode: 0,
      resumed: false,
      durationMs: 1000,
      completedAt: "2026-08-28T00:00:00.000Z",
    });

    // The whole path: lifecycle event → plugin → injected writer → row.
    expect(result.failures).toEqual([]);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(createdData()).toMatchObject({
      action: "job.completed",
      resourceId: "job_7",
      userId: "u1",
      organizationId: "org_1",
    });
  });

  test("a sync emitted on a real bus is written as a row", async () => {
    const { hooks } = registerPlugins([
      createDatabaseAuditLoggerPlugin({ write: createAuditWriter(prisma) }),
    ]);

    await hooks.emit("afterProjectSync", {
      projectId: "prj_1",
      userId: "u1",
      organizationId: "org_1",
      changed: true,
      jobId: "job_1",
      servicesAdded: 0,
      servicesUpdated: 1,
      servicesRemoved: 0,
      locationsAdded: 0,
      locationsUpdated: 0,
      locationsRemoved: 0,
      scopedPages: 3,
      syncedAt: "2026-08-28T00:00:00.000Z",
    });

    expect(createdData()).toMatchObject({
      action: "project.synced",
      resourceId: "prj_1",
      organizationId: "org_1",
    });
  });
});

describe("reading a trail cannot cross a tenant", () => {
  beforeEach(() => {
    prisma.auditLog.findMany.mockResolvedValue([]);
  });

  /** The arguments the last read was built with. */
  function readArgs(): { where: Record<string, unknown>; take: number } {
    return prisma.auditLog.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      take: number;
    };
  }

  test("every read is scoped to one organization", async () => {
    await listAuditEvents("org_1", prisma);

    // There is deliberately no unscoped read in this module. The first
    // convenience function returning "all recent activity" is the one that ends
    // up behind a dashboard route.
    expect(readArgs().where["organizationId"]).toBe("org_1");
  });

  test("filters narrow the scope, they never replace it", async () => {
    await listAuditEvents("org_1", prisma, {
      action: "job.completed",
      resourceId: "job_7",
    });

    expect(readArgs().where).toEqual({
      organizationId: "org_1",
      action: "job.completed",
      resourceId: "job_7",
    });
  });

  test("newest first", async () => {
    await listAuditEvents("org_1", prisma);

    const call = prisma.auditLog.findMany.mock.calls[0]?.[0] as { orderBy: unknown };

    expect(call.orderBy).toEqual({ createdAt: "desc" });
  });

  test("an absurd page size is capped rather than honoured", async () => {
    await listAuditEvents("org_1", prisma, { limit: 100_000 });

    expect(readArgs().take).toBe(MAX_AUDIT_PAGE);
  });

  test("a nonsense page size falls back to something renderable", async () => {
    await listAuditEvents("org_1", prisma, { limit: 0 });
    expect(readArgs().take).toBeGreaterThan(0);
  });

  test("rows come back with details defaulted rather than undefined", async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      {
        id: "audit_1",
        action: "job.completed",
        resourceId: "job_1",
        userId: "u1",
        organizationId: "org_1",
        details: null,
        createdAt: new Date("2026-08-28T00:00:00.000Z"),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    const [entry] = await listAuditEvents("org_1", prisma);

    expect(entry?.details).toEqual({});
    expect(entry?.createdAt).toBe("2026-08-28T00:00:00.000Z");
  });
});
