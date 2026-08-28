import { hostname } from "node:os";
import {
  createAuditLoggerPlugin,
  isAuditLogEnabled,
  registerPlugins,
  sleep,
  type HookBus,
  type StaticForgePlugin,
} from "@staticforge/core";

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
): StaticForgePlugin[] {
  return isAuditLogEnabled(env) ? [createAuditLoggerPlugin()] : [];
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

  return startWorker(
    deps,
    {
      ...options,
      instanceId: options.instanceId ?? workerInstanceId(),
      hooks: buildHookBus(options.plugins ?? defaultPlugins(), log),
    },
    sleep,
  );
}

export * from "./worker.js";
export * from "./run-engine.js";
