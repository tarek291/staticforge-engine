import { describe, expect, test, vi } from "vitest";

import {
  BILLING_METER_ENV_VAR,
  USAGE_METRICS,
  createBillingMeterPlugin,
  isBillingMeterEnabled,
  type UsageEvent,
} from "./billing-meter.js";
import type { JobCompletedEvent, ProjectSyncEvent } from "./hooks.js";
import { registerPlugins } from "./plugin.js";

/**
 * The meter.
 *
 * Two ways to get billing wrong and they are not equally bad. Over-metering
 * charges a customer for work that did not happen, which is the error nobody
 * forgives; under-metering loses revenue, which is recoverable. Most of these
 * tests are about the first: a failed run, a cached run, a run with no tenant.
 */

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
    pageCount: 9,
    reservedUnits: 1,
    durationMs: 4321,
    completedAt: "2026-08-28T00:01:00.000Z",
    ...over,
  };
}

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

/** Install on a real bus and capture what it meters. */
function install(options: { write?: (event: UsageEvent) => Promise<void>; countUnchangedSyncs?: boolean } = {}) {
  const metered: UsageEvent[] = [];
  const failures: string[] = [];

  const write =
    options.write ??
    (async (event: UsageEvent) => {
      metered.push(event);
    });

  const { hooks } = registerPlugins(
    [
      createBillingMeterPlugin({
        write,
        ...(options.countUnchangedSyncs !== undefined
          ? { countUnchangedSyncs: options.countUnchangedSyncs }
          : {}),
      }),
    ],
    {
      onFailure: (failure) => {
        failures.push(
          failure.error instanceof Error ? failure.error.message : String(failure.error),
        );
      },
    },
  );

  return { hooks, metered, failures };
}

describe("finished work is metered", () => {
  test("a successful job meters the pages it actually wrote", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterJobCompleted", jobEvent({ pageCount: 9 }));

    expect(metered).toEqual([
      {
        organizationId: "org_1",
        metric: USAGE_METRICS.aiGeneratedPages,
        amount: 9,
        // The hold taken at admission travels with the report, so the writer
        // can store the difference rather than counting the run twice.
        reservedUnits: 1,
        resourceId: "job_1",
      },
    ]);
  });

  test("the charge is traceable to the run, not to the project", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterJobCompleted", jobEvent({ jobId: "job_77" }));

    // A project accumulates hundreds of runs. A charge nobody can trace to one
    // of them is a charge nobody can dispute or explain.
    expect(metered[0]?.resourceId).toBe("job_77");
  });

  test("a sync meters one operation", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterProjectSync", syncEvent());

    expect(metered).toEqual([
      {
        organizationId: "org_1",
        metric: USAGE_METRICS.syncOperations,
        amount: 1,
        // Held one, cost one. The writer settles a difference of zero and the
        // ledger keeps the single row the gate already wrote.
        reservedUnits: 1,
        resourceId: "prj_1",
      },
    ]);
  });

  test("a sync that changed nothing still counts, by default", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterProjectSync", syncEvent({ changed: false, jobId: null }));

    // `SYNC_OPERATIONS` counts operations, not outcomes. A polling integration
    // that finds no change still made the call and is still the lever somebody
    // can pull in a loop.
    expect(metered).toHaveLength(1);
  });

  test("an operator selling on changed syncs can say so", async () => {
    const { hooks, metered } = install({ countUnchangedSyncs: false });

    await hooks.emit("afterProjectSync", syncEvent({ changed: false }));
    await hooks.emit("afterProjectSync", syncEvent({ changed: true }));

    // Both are reported, and that is the point: the setting decides the
    // *amount*, not whether to speak. The unchanged sync reports zero against a
    // hold of one, which gives the gate's unit back — staying silent would have
    // left it charged, so the setting would have raised the bill it was set to
    // lower.
    expect(metered.map((entry) => entry.amount - entry.reservedUnits)).toEqual([
      -1, 0,
    ]);
  });
});

describe("work that produced nothing is not charged for", () => {
  test("a failed job reports zero, and gives its hold back", async () => {
    const { hooks, metered } = install();

    await hooks.emit(
      "afterJobCompleted",
      jobEvent({ ok: false, exitCode: 1, reservedUnits: 4 }),
    );

    // Charging for the engine's own failure is the hardest charge to defend and
    // the easiest to avoid making. Before Phase 31 that meant staying silent;
    // now silence would leave the four units held at admission standing against
    // the tenant, so the refusal has to be *stated* to be honoured.
    expect(metered[0]?.amount).toBe(0);
    expect(metered[0]?.reservedUnits).toBe(4);
  });

  test("a run that wrote no pages gives its whole hold back", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterJobCompleted", jobEvent({ pageCount: 0, reservedUnits: 3 }));

    // Every page cached, resumed, or out of scope. Nothing was authored, so
    // nothing is owed — which is the whole reason the count is read back from
    // the row rather than estimated from the grid.
    expect(metered[0]?.amount).toBe(0);
    expect(metered[0]?.reservedUnits).toBe(3);
  });

  test("a run that authored less than it held reports the shortfall", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterJobCompleted", jobEvent({ pageCount: 2, reservedUnits: 10 }));

    // The writer stores `actual - held`, so this is a credit of eight. An
    // append-only ledger cannot correct a charge by editing it; a negative row
    // is how the correction stays readable next to what it corrects.
    const entry = metered[0];

    expect(entry === undefined ? null : entry.amount - entry.reservedUnits).toBe(-8);
  });

  test("a run with no tenant meters nothing", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterJobCompleted", jobEvent({ organizationId: null }));
    await hooks.emit("afterProjectSync", syncEvent({ organizationId: null }));

    // A local run. There is nobody to bill, nothing was held against anybody,
    // and inventing an organization would put the charge on somebody else's
    // invoice. This is the one case that still reports nothing at all — there
    // is no hold to give back.
    expect(metered).toEqual([]);
  });
});

describe("a failed meter write is loud, and never fatal", () => {
  test("the failure is reported against this plugin by name", async () => {
    const { hooks, failures } = install({
      write: () => Promise.reject(new Error("connection refused")),
    });

    const result = await hooks.emit("afterJobCompleted", jobEvent());

    expect(failures).toEqual(["connection refused"]);
    expect(result.failures[0]?.plugin).toBe("billing-meter");
  });

  test("it does not fail the run it was counting", async () => {
    const { hooks } = install({
      write: () => Promise.reject(new Error("connection refused")),
    });

    // Losing revenue is recoverable. Losing a customer's completed work is not,
    // and a billing plugin able to fail a run could do exactly that.
    await expect(hooks.emit("afterJobCompleted", jobEvent())).resolves.toMatchObject({
      delivered: 0,
    });
  });

  test("one lost row does not stop the next being written", async () => {
    const metered: UsageEvent[] = [];
    let first = true;

    const { hooks } = install({
      write: async (event) => {
        if (first) {
          first = false;
          throw new Error("transient");
        }
        metered.push(event);
      },
    });

    await hooks.emit("afterJobCompleted", jobEvent({ jobId: "job_1" }));
    await hooks.emit("afterJobCompleted", jobEvent({ jobId: "job_2" }));

    expect(metered.map((event) => event.resourceId)).toEqual(["job_2"]);
  });
});

describe("configuration and contract", () => {
  test("metric names are stable, because invoices are built on them", () => {
    expect(USAGE_METRICS.aiGeneratedPages).toBe("AI_GENERATED_PAGES");
    expect(USAGE_METRICS.syncOperations).toBe("SYNC_OPERATIONS");
  });

  test("nothing is metered unless the variable is exactly true", () => {
    expect(isBillingMeterEnabled({})).toBe(false);
    expect(isBillingMeterEnabled({ [BILLING_METER_ENV_VAR]: "1" })).toBe(false);
    expect(isBillingMeterEnabled({ [BILLING_METER_ENV_VAR]: "TRUE" })).toBe(false);
    expect(isBillingMeterEnabled({ [BILLING_METER_ENV_VAR]: "true" })).toBe(true);
  });

  test("the plugin holds no database client of its own", () => {
    const plugin = createBillingMeterPlugin({ write: vi.fn() });

    // The contract, asserted: it is given a writer and has no way to reach a
    // database except through it.
    expect(Object.keys(plugin).sort()).toEqual(["description", "name", "setup"]);
    expect(plugin.name).toBe("billing-meter");
  });
});
