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

    expect(metered).toHaveLength(1);
  });
});

describe("work that produced nothing is not charged for", () => {
  test("a failed job meters nothing", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterJobCompleted", jobEvent({ ok: false, exitCode: 1 }));

    // Charging for the engine's own failure is the hardest charge to defend and
    // the easiest to avoid making.
    expect(metered).toEqual([]);
  });

  test("a run that wrote no pages meters nothing", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterJobCompleted", jobEvent({ pageCount: 0 }));

    // Every page cached, resumed, or out of scope. Nothing was authored, so
    // nothing is owed — which is the whole reason the count is read back from
    // the row rather than estimated from the grid.
    expect(metered).toEqual([]);
  });

  test("a run with no tenant meters nothing", async () => {
    const { hooks, metered } = install();

    await hooks.emit("afterJobCompleted", jobEvent({ organizationId: null }));
    await hooks.emit("afterProjectSync", syncEvent({ organizationId: null }));

    // A local run. There is nobody to bill, and inventing an organization would
    // put the charge on somebody else's invoice.
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
