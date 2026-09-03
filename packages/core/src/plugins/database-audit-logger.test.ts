import { describe, expect, test, vi } from "vitest";

import {
  AUDIT_ACTIONS,
  DATABASE_AUDIT_ENV_VAR,
  createDatabaseAuditLoggerPlugin,
  isDatabaseAuditEnabled,
  type AuditRecord,
} from "./database-audit-logger.js";
import type { JobCompletedEvent, ProjectSyncEvent } from "./hooks.js";
import { registerPlugins } from "./plugin.js";

/**
 * The audit trail, as a table.
 *
 * The tests worth having here are about *completeness* and *scoping*. An audit
 * log that quietly drops the failures, or that writes rows nobody can attribute
 * to a tenant, is worse than none: it is a control that was bought, is
 * believed, and does not work.
 */

/** A sync event, as the sync layer emits one. */
function syncEvent(over: Partial<ProjectSyncEvent> = {}): ProjectSyncEvent {
  return {
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
    reservedUnits: 1,
    syncedAt: "2026-08-28T00:00:00.000Z",
    ...over,
  };
}

/** A finished job, as the worker emits one. */
function jobEvent(over: Partial<JobCompletedEvent> = {}): JobCompletedEvent {
  return {
    jobId: "job_1",
    projectId: "prj_1",
    userId: "u1",
    organizationId: "org_1",
    kind: "GENERATE",
    ok: true,
    exitCode: 0,
    resumed: false,
    reservedUnits: 1,
    pageCount: 9,
    durationMs: 4321,
    completedAt: "2026-08-28T00:01:00.000Z",
    ...over,
  };
}

/** Install the plugin on a real bus and capture what it writes. */
function install(options: { write?: (record: AuditRecord) => Promise<void> } = {}) {
  const written: AuditRecord[] = [];
  const failures: string[] = [];

  const write =
    options.write ??
    (async (record: AuditRecord) => {
      written.push(record);
    });

  const { hooks, installed } = registerPlugins(
    [createDatabaseAuditLoggerPlugin({ write })],
    {
      onFailure: (failure) => {
        failures.push(
          failure.error instanceof Error
            ? failure.error.message
            : String(failure.error),
        );
      },
    },
  );

  return { hooks, written, failures, installed };
}

describe("events reach the table", () => {
  test("a sync is recorded with its organization and its cause", async () => {
    const { hooks, written } = install();

    await hooks.emit("afterProjectSync", syncEvent());

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: AUDIT_ACTIONS.projectSynced,
      resourceId: "prj_1",
      userId: "u1",
      organizationId: "org_1",
    });
  });

  test("the sync record links the change to the run it bought", async () => {
    const { hooks, written } = install();

    await hooks.emit("afterProjectSync", syncEvent({ jobId: "job_9", scopedPages: 3 }));

    // A trail that records "a sync happened" without what it cost cannot answer
    // the question an invoice raises.
    expect(written[0]?.details).toMatchObject({
      jobId: "job_9",
      scopedPages: 3,
      servicesUpdated: 1,
    });
  });

  test("a completed job is recorded against the job, not the project", async () => {
    const { hooks, written } = install();

    await hooks.emit("afterJobCompleted", jobEvent());

    // `resourceId` is the thing the action happened to. The project is context
    // and lives in `details`.
    expect(written[0]).toMatchObject({
      action: AUDIT_ACTIONS.jobCompleted,
      resourceId: "job_1",
      organizationId: "org_1",
    });
    expect(written[0]?.details).toMatchObject({ projectId: "prj_1", kind: "GENERATE" });
  });

  test("a failed job is recorded too", async () => {
    const { hooks, written } = install();

    await hooks.emit("afterJobCompleted", jobEvent({ ok: false, exitCode: 1 }));

    // "Nothing ran" and "it ran and failed" are different answers to the same
    // question, and only one of them means somebody should read a log.
    expect(written).toHaveLength(1);
    expect(written[0]?.details).toMatchObject({ ok: false, exitCode: 1 });
  });

  test("a sync that changed nothing is still recorded by default", async () => {
    const { hooks, written } = install();

    await hooks.emit("afterProjectSync", syncEvent({ changed: false, jobId: null }));

    // A sync that found nothing to do is still somebody's credential reaching
    // this system. Volume is a retention policy problem; completeness is not
    // something to trade for it by default.
    expect(written).toHaveLength(1);
    expect(written[0]?.details).toMatchObject({ changed: false });
  });

  test("unchanged syncs can be skipped when volume matters", async () => {
    const written: AuditRecord[] = [];
    const { hooks } = registerPlugins([
      createDatabaseAuditLoggerPlugin({
        write: async (record) => {
          written.push(record);
        },
        skipUnchangedSyncs: true,
      }),
    ]);

    await hooks.emit("afterProjectSync", syncEvent({ changed: false }));
    await hooks.emit("afterProjectSync", syncEvent({ changed: true }));

    expect(written).toHaveLength(1);
    expect(written[0]?.details).toMatchObject({ changed: true });
  });
});

describe("a record can always be attributed", () => {
  test("every record carries the acting user", async () => {
    const { hooks, written } = install();

    await hooks.emit("afterProjectSync", syncEvent({ userId: "alice" }));
    await hooks.emit("afterJobCompleted", jobEvent({ userId: "bob" }));

    expect(written.map((record) => record.userId)).toEqual(["alice", "bob"]);
  });

  test("a run outside an organization records null rather than guessing", async () => {
    const { hooks, written } = install();

    await hooks.emit("afterProjectSync", syncEvent({ organizationId: null }));

    // A record with no home is still better than no record, and it is invisible
    // to a tenant-scoped read — which is correct, because it did not happen to
    // a tenant. Inventing an organization would put it in someone's trail.
    expect(written[0]?.organizationId).toBeNull();
  });

  test("the action names are stable, because filters are built against them", () => {
    expect(AUDIT_ACTIONS.projectSynced).toBe("project.synced");
    expect(AUDIT_ACTIONS.jobCompleted).toBe("job.completed");
  });
});

describe("a failed write is loud, and never fatal", () => {
  test("a write failure is reported against this plugin by name", async () => {
    const { hooks, failures } = install({
      write: () => Promise.reject(new Error("connection refused")),
    });

    const result = await hooks.emit("afterJobCompleted", jobEvent());

    // Reported rather than swallowed: a trail with a hole nobody knows about is
    // the failure mode this whole feature exists to prevent.
    expect(failures).toEqual(["connection refused"]);
    expect(result.failures[0]?.plugin).toBe("database-audit-logger");
  });

  test("a write failure does not fail the run it was recording", async () => {
    const { hooks } = install({
      write: () => Promise.reject(new Error("connection refused")),
    });

    // The job is done and the row is written. Making the trail able to fail a
    // run would mean a plugin can abort a paid, hour-long build — which is why
    // this is best-effort, and why the failure has to be visible instead.
    await expect(hooks.emit("afterJobCompleted", jobEvent())).resolves.toMatchObject({
      delivered: 0,
    });
  });

  test("one failing event does not stop the next one being recorded", async () => {
    const written: AuditRecord[] = [];
    let first = true;

    const { hooks } = install({
      write: async (record) => {
        if (first) {
          first = false;
          throw new Error("transient");
        }
        written.push(record);
      },
    });

    await hooks.emit("afterJobCompleted", jobEvent({ jobId: "job_1" }));
    await hooks.emit("afterJobCompleted", jobEvent({ jobId: "job_2" }));

    expect(written.map((record) => record.resourceId)).toEqual(["job_2"]);
  });
});

describe("configuration by opt-in", () => {
  test("nothing is written unless the variable is exactly true", () => {
    expect(isDatabaseAuditEnabled({})).toBe(false);
    expect(isDatabaseAuditEnabled({ [DATABASE_AUDIT_ENV_VAR]: "1" })).toBe(false);
    expect(isDatabaseAuditEnabled({ [DATABASE_AUDIT_ENV_VAR]: "TRUE" })).toBe(false);
    expect(isDatabaseAuditEnabled({ [DATABASE_AUDIT_ENV_VAR]: "true" })).toBe(true);
  });

  test("the plugin holds no client of its own", () => {
    // The contract, asserted: it is given a writer and has no way to reach a
    // database except through it. What it may touch is decided in one visible
    // place by the composition root.
    const write = vi.fn();
    const plugin = createDatabaseAuditLoggerPlugin({ write });

    expect(Object.keys(plugin).sort()).toEqual(["description", "name", "setup"]);
    expect(plugin.name).toBe("database-audit-logger");
  });
});
