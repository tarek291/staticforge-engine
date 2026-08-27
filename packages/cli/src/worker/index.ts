import { hostname } from "node:os";
import { sleep } from "@staticforge/core";

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

/** Start a worker wired to the real database. */
export async function startDatabaseWorker(
  options: Omit<WorkerOptions, "instanceId"> & { instanceId?: string },
): Promise<WorkerHandle> {
  const deps = await createWorkerDeps();

  return startWorker(
    deps,
    { ...options, instanceId: options.instanceId ?? workerInstanceId() },
    sleep,
  );
}

export * from "./worker.js";
export * from "./run-engine.js";
