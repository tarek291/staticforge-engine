import { hostname } from "node:os";
import {
  createAuditLoggerPlugin,
  createBillingMeterPlugin,
  createBuildTriggerFromEnv,
  createDatabaseAuditLoggerPlugin,
  isAuditLogEnabled,
  isBillingMeterEnabled,
  isDatabaseAuditEnabled,
  registerPlugins,
  sleep,
  type AuditRecordWriter,
  type HookBus,
  type StaticForgePlugin,
  type UsageWriter,
} from "@staticforge/core";

import { installCrashGuard } from "./crash-guard.js";
import { runEngine } from "./run-engine.js";
import {
  startWorker,
  type ClaimedJobLike,
  type WorkerDeps,
  type WorkerHandle,
  type WorkerOptions,
} from "./worker.js";

/**
 * Wiring the worker to the real database.
 *
 * The loop itself knows nothing about Prisma — it takes the operations it needs
 * as functions, which is what lets the whole of it be exercised against fakes
 * with no database and no subprocess. This module is the one place that turns
 * those into real queries, and it imports the database package dynamically for
 * the same reason the generator does: a machine that only ever runs the local
 * file pipeline should not pay to construct a client.
 */

/** Environment variable naming this worker, for the lease it takes. */
export const INSTANCE_ID_ENV_VAR = "STATICFORGE_INSTANCE_ID";

/**
 * Stable identity of this worker.
 *
 * Stable across a restart of the same machine or container, and distinct
 * between workers. Overridable, because a scheduler that reuses hostnames
 * across replicas would otherwise give two workers one identity — and a lease
 * only means something if the name on it is unique.
 */
export function workerInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[INSTANCE_ID_ENV_VAR]?.trim();

  return configured === undefined || configured === ""
    ? `${hostname()}:worker`
    : configured;
}

/** Build the worker's dependencies against the real database. */
export async function createWorkerDeps(): Promise<WorkerDeps> {
  const {
    claimNextJob,
    countExpectedPages,
    finishJob,
    getJobForUser,
    prisma,
    renewJobLease,
    updateJobLogs,
  } = await import("@staticforge/database");

  return {
    claimNextJob: (options) =>
      claimNextJob(prisma, options).then((job) =>
        job === null ? null : (job as unknown as ClaimedJobLike),
      ),
    renewJobLease: (jobId, instanceId) =>
      renewJobLease(jobId, { instanceId }, prisma),
    updateJobLogs: (jobId, logs, userId) =>
      updateJobLogs(jobId, logs, userId, prisma),
    finishJob: (jobId, outcome, userId) => finishJob(jobId, outcome, userId, prisma),
    countExpectedPages: (projectId, userId) =>
      countExpectedPages(projectId, userId, prisma),
    readCompletedPages: async (jobId, userId) =>
      (await getJobForUser(jobId, userId, prisma))?.completedCount ?? 0,
    runEngine,
  };
}

/**
 * The plugins this worker installs.
 *
 * A list, not a discovery mechanism. Loading plugins from a directory or a
 * config file means a deployment can gain third-party code without anyone
 * changing a file that gets reviewed — which is how a supply chain becomes an
 * attack surface. Installing one stays an explicit edit here.
 *
 * The audit logger is opt-in on top of that: a second stream of output is not
 * something to start writing because a variable was almost set.
 */
export function defaultPlugins(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = () => {},
  auditWriter?: AuditRecordWriter,
  usageWriter?: UsageWriter,
): StaticForgePlugin[] {
  const plugins: StaticForgePlugin[] = [];

  if (isAuditLogEnabled(env)) {
    plugins.push(createAuditLoggerPlugin());
  }

  // The database audit trail. Opt-in and *given* its writer rather than
  // building one: the plugin contract hands a plugin no database client, and
  // this is the one visible place that decides what it may reach.
  if (auditWriter !== undefined && isDatabaseAuditEnabled(env)) {
    plugins.push(createDatabaseAuditLoggerPlugin({ write: auditWriter }));
  }

  // The billing meter, given its writer for the same reason the audit logger is.
  // Opt-in: a worker that started writing usage rows into a customer's database
  // because a variable was almost set is a worker that produced an invoice
  // nobody can explain.
  if (usageWriter !== undefined && isBillingMeterEnabled(env)) {
    plugins.push(createBillingMeterPlugin({ write: usageWriter }));
  }

  // Configured by presence: a worker with no deploy hook is the ordinary local
  // case and gets no plugin and no warning. A hook that is present and unusable
  // is the opposite — somebody configured a deployment and got it wrong — so it
  // is reported here rather than thrown, because the jobs still need doing and
  // a worker that refuses to boot over a bad URL turns a stale site into an
  // idle queue.
  try {
    const trigger = createBuildTriggerFromEnv(env, { log });

    if (trigger !== undefined) {
      plugins.push(trigger);
    }
  } catch (error: unknown) {
    log(
      `  ! deploy hook is configured but unusable, so nothing will be ` +
        `published automatically: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return plugins;
}

/**
 * Build the lifecycle bus this worker emits on.
 *
 * Setup failures are reported and survived. A worker that refused to boot
 * because one audit logger had a typo would be a worse outcome than a worker
 * running without it — the jobs still need doing.
 *
 * @param log - Where plugin failures are reported. The worker passes its own
 * logger, so a misbehaving plugin appears where an operator already looks.
 */
export function buildHookBus(
  plugins: readonly StaticForgePlugin[],
  log: (message: string) => void,
): HookBus {
  const { hooks, installed, failed } = registerPlugins(plugins, {
    onFailure: (failure) => {
      log(
        `  ! plugin "${failure.plugin}" ${failure.reason} on ${failure.hook}: ` +
          `${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      );
    },
  });

  if (installed.length > 0) {
    log(`  plugins: ${installed.join(", ")}`);
  }

  for (const failure of failed) {
    log(
      `  ! plugin "${failure.plugin}" failed to install and was skipped: ` +
        `${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
    );
  }

  return hooks;
}

/** Start a worker wired to the real database. */
export async function startDatabaseWorker(
  options: Omit<WorkerOptions, "instanceId"> & {
    instanceId?: string;
    plugins?: readonly StaticForgePlugin[];
  },
): Promise<WorkerHandle> {
  const deps = await createWorkerDeps();
  const log = options.log ?? (() => {});

  // Installed before any plugin can start a promise. The bus abandons listeners
  // that overrun its deadline and never sees the ones a plugin fires without
  // awaiting, so a detached rejection would otherwise end this process — taking
  // a half-finished paid build with it, on every worker at once, because they
  // are all running the same plugin.
  installCrashGuard({ log });

  // Built here, in the composition root, and handed to the plugin rather than
  // reached for by it.
  const { createAuditWriter, prisma, reconcileStrandedHolds, settleUsageEvent } =
    await import("@staticforge/database");
  const auditWriter = createAuditWriter(prisma);

  // Settles rather than records. The quota gate held an estimate when this work
  // was admitted, so writing the true figure on top of it would count the
  // operation twice; what goes in the ledger is the difference, which is
  // negative when a run authored less than it held and zero when the estimate
  // was exact.
  //
  // For a job the adjustment and the `settledAt` stamp commit together, which
  // makes this idempotent: if the reconciler below has already given the hold
  // back, this writes nothing rather than crediting the tenant twice.
  const usageWriter: UsageWriter = async (event) => {
    await settleUsageEvent(event, prisma);
  };

  return startWorker(
    {
      ...deps,
      // The safety net under the line above. The bus is best-effort by design,
      // so a settlement can be lost; this finds finished jobs still holding
      // units and gives them back on the next idle tick.
      reconcileHolds: () => reconcileStrandedHolds(prisma),
    },
    {
      ...options,
      instanceId: options.instanceId ?? workerInstanceId(),
      hooks: buildHookBus(
        options.plugins ?? defaultPlugins(process.env, log, auditWriter, usageWriter),
        log,
      ),
    },
    sleep,
  );
}

export * from "./crash-guard.js";
export * from "./worker.js";
export * from "./run-engine.js";
