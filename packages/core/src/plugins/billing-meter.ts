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
 * `checkQuota`.
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
  /** How many units. */
  amount: number;
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
          // A local run with no tenant. There is nobody to bill, and inventing
          // an organization would put the charge on somebody else's invoice.
          return;
        }

        if (!payload.ok) {
          // A failed run produced no pages a customer can use. Metering it
          // would charge for the engine's own failure, which is the charge
          // hardest to defend and the easiest to avoid making.
          return;
        }

        if (payload.pageCount <= 0) {
          // A run that wrote nothing — every page cached, resumed or out of
          // scope. Nothing was authored, so nothing is owed.
          return;
        }

        await write({
          organizationId: payload.organizationId,
          metric: USAGE_METRICS.aiGeneratedPages,
          amount: payload.pageCount,
          // The job, not the project. A charge has to be traceable to the run
          // that caused it, and a project accumulates hundreds of them.
          resourceId: payload.jobId,
        });
      });

      hooks.on("afterProjectSync", async (payload) => {
        if (payload.organizationId === null) {
          return;
        }

        if (!countUnchangedSyncs && !payload.changed) {
          return;
        }

        await write({
          organizationId: payload.organizationId,
          metric: USAGE_METRICS.syncOperations,
          amount: 1,
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
