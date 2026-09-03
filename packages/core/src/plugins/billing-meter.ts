import type { StaticForgePlugin } from "./plugin.js";

/**
 * Counting what a tenant consumed, after it consumed it.
 *
 * ## Why metering is retrospective and quotas are not
 *
 * A run's real page count is not knowable when it is queued — the grid is
 * computed after the input loads, the AI pass skips cached and out-of-scope
 * pages, and a run can fail half way. Charging at enqueue time would bill for
 * work that was never done, which is the one billing error a customer never
 * forgives.
 *
 * So consumption is metered from lifecycle events, once the work is finished
 * and its verdict is durable. The ceiling that stops a tenant *starting* work
 * it cannot afford is a separate mechanism, checked before, and it lives in
 * `reserveQuota`.
 *
 * ## What changed in Phase 31, and why this plugin now reports negatives
 *
 * Retrospective metering alone left a race: nothing was written between a
 * quota check passing and the work finishing, so every concurrent caller read
 * the same total and every one of them passed. The gate now *holds* what it
 * admits — it writes its estimate as a usage row at admission time, so the
 * next caller's sum can see it.
 *
 * That makes this plugin's job subtraction rather than addition. It reports
 * the difference between what really happened and what was held, so:
 *
 * - a run that authored fewer pages than were held reports a **negative**
 *   amount, giving the excess back;
 * - a run that **failed** reports the whole hold back, because a failed run
 *   produced nothing a customer can use and the estimate must not stand;
 * - a sync, whose estimate is exactly right, reports zero and writes nothing.
 *
 * The early returns below are therefore no longer "return without metering".
 * Each one now has to give a hold back, and the difference matters: skipping
 * the write would leave an estimate charged for work that never happened,
 * which is precisely the over-billing this plugin exists to avoid.
 *
 * ## What this plugin cannot promise
 *
 * The same thing the audit logger cannot: delivery. It runs after the action,
 * under the bus's deadline, and a database unreachable for those two seconds
 * loses that row. The failure is loud — it throws, so the bus reports it
 * against this plugin by name — but the row is gone.
 *
 * That is a deliberate trade and it points the safe way. An un-metered
 * operation under-bills a customer; a meter that could fail a run would let a
 * billing plugin abort a paid, hour-long build. Losing revenue is recoverable.
 * Losing a customer's completed work is not.
 */

/** One thing worth counting. */
export interface UsageEvent {
  organizationId: string;
  /** Mirrors the `UsageMetric` enum in the schema. */
  metric: "AI_GENERATED_PAGES" | "SYNC_OPERATIONS";
  /** How many units the operation really consumed. */
  amount: number;
  /**
   * Units already held for it by the quota gate at admission.
   *
   * The writer stores the *difference*, so this is what stops an operation
   * being counted twice — once by the gate that admitted it and once by the
   * meter that saw it finish.
   */
  reservedUnits: number;
  /** What it happened to — a job id, a project id. */
  resourceId: string | null;
}

/**
 * Where a usage event goes.
 *
 * Injected, like the audit writer. The plugin contract hands a plugin no
 * database client, and this is why: what it may reach is decided by the
 * composition root in one place a reviewer can see, rather than by whatever the
 * plugin decided to import.
 */
export type UsageWriter = (event: UsageEvent) => Promise<void>;

/** Options for {@link createBillingMeterPlugin}. */
export interface BillingMeterOptions {
  /** Where usage goes. */
  write: UsageWriter;
  /**
   * Count syncs that changed nothing.
   *
   * On by default. A polling integration that finds no change still made a
   * call, still cost a query, and is still the lever somebody can pull in a
   * loop — so `SYNC_OPERATIONS` counts operations rather than outcomes. An
   * operator selling on changed-syncs can turn this off, but the default is
   * the honest reading of the metric's own name.
   */
  countUnchangedSyncs?: boolean;
}

/** The metric names this plugin writes. Stable: invoices are built on them. */
export const USAGE_METRICS = Object.freeze({
  aiGeneratedPages: "AI_GENERATED_PAGES",
  syncOperations: "SYNC_OPERATIONS",
} as const);

/**
 * Build the meter.
 *
 * @param options - The writer, and what to count.
 */
export function createBillingMeterPlugin(
  options: BillingMeterOptions,
): StaticForgePlugin {
  const { write, countUnchangedSyncs = true } = options;

  return {
    name: "billing-meter",
    description: "Records tenant usage from lifecycle events, for quotas and billing.",

    setup(hooks) {
      hooks.on("afterJobCompleted", async (payload) => {
        if (payload.organizationId === null) {
          // A local run with no tenant. There is nobody to bill, nothing was
          // held against anybody, and inventing an organization would put the
          // charge on somebody else's invoice.
          return;
        }

        // A failed run produced no pages a customer can use, and a run that
        // wrote nothing — every page cached, resumed or out of scope —
        // authored nothing either. Both are worth zero, and both still have to
        // be reported, because the hold taken at admission is standing against
        // the tenant until this says otherwise.
        const actual = payload.ok ? Math.max(0, payload.pageCount) : 0;

        await write({
          organizationId: payload.organizationId,
          metric: USAGE_METRICS.aiGeneratedPages,
          amount: actual,
          reservedUnits: payload.reservedUnits,
          // The job, not the project. A charge has to be traceable to the run
          // that caused it, and a project accumulates hundreds of them.
          resourceId: payload.jobId,
        });
      });

      hooks.on("afterProjectSync", async (payload) => {
        if (payload.organizationId === null) {
          return;
        }

        // An operator who has turned this off still has a hold to give back,
        // so this decides the *amount* rather than whether to write. Returning
        // early here would leave the gate's unit charged for an operation the
        // operator said not to charge for — the setting would raise the bill
        // it was set to lower.
        const actual = !countUnchangedSyncs && !payload.changed ? 0 : 1;

        await write({
          organizationId: payload.organizationId,
          metric: USAGE_METRICS.syncOperations,
          amount: actual,
          reservedUnits: payload.reservedUnits,
          resourceId: payload.projectId,
        });
      });
    },
  };
}

/** Whether the worker should meter usage to the database. */
export const BILLING_METER_ENV_VAR = "STATICFORGE_METER_USAGE";

/**
 * Read the meter's opt-in.
 *
 * Strictly opt-in and only the exact string `"true"`, matching every other
 * switch in this engine. A stray `=1` must not silently start writing billing
 * rows into a customer's database.
 */
export function isBillingMeterEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[BILLING_METER_ENV_VAR] === "true";
}
