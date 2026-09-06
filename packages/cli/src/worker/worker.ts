import { noopHookBus, type HookBus } from "@staticforge/core";

import { runEngine, type EngineResult } from "./run-engine.js";

/**
 * The queue worker.
 *
 * A loop, not a server. It claims a job, runs the engine, records the verdict,
 * and asks for the next one. Everything that makes it survivable lives in two
 * places: the lease it renews while it works, and the fact that a run skips
 * pages a previous attempt already wrote.
 *
 * ## Why this is a separate process
 *
 * Until now the Next.js server ran the engine itself. That coupling had a cost
 * that only appears in production: an HTTP process holding an hour-long build
 * cannot be restarted, replicated or deployed without destroying work, so the
 * web tier could not scale and could not ship. Splitting them means the server
 * writes a row and answers, and the thing that does the work can be restarted
 * at any moment — because a lease lapses, another worker reclaims the job, and
 * the run continues from where it stopped.
 *
 * ## What it deliberately does not do
 *
 * No prefetching, no concurrency within a worker, no priority. One job at a
 * time, oldest first. Concurrency is adding a second worker, which the claim
 * already makes safe; the alternative — a worker juggling several runs — buys
 * throughput this workload does not need and costs the property that a crashed
 * worker loses exactly one job's progress.
 */

/** The subset of the database module the worker needs, injected for testing. */
export interface WorkerDeps {
  claimNextJob: (options: {
    instanceId: string;
    leaseMs?: number;
  }) => Promise<ClaimedJobLike | null>;
  renewJobLease: (jobId: string, instanceId: string) => Promise<boolean>;
  updateJobLogs: (jobId: string, logs: string, userId: string) => Promise<boolean>;
  finishJob: (
    jobId: string,
    outcome: { ok: boolean; exitCode: number; logs: string },
    userId: string,
  ) => Promise<boolean>;
  countExpectedPages: (projectId: string, userId: string) => Promise<number | null>;
  /**
   * How many pages a finished job actually recorded.
   *
   * Read after the run rather than estimated before it, because the estimate
   * and the outcome differ for every run worth metering — a scoped run touches
   * a fraction of the project, a cached one authors nothing, and a failed one
   * may have written half. Optional so an existing caller keeps working; the
   * meter simply has nothing to charge without it.
   */
  readCompletedPages?: (jobId: string, userId: string) => Promise<number>;
  /**
   * Give back quota holds whose settlement event never landed.
   *
   * Called on the idle tick, where by definition there is nothing more urgent
   * to do. The meter runs on the plugin bus, which absorbs listener failures so
   * that a billing plugin can never abort a paid run — a trade worth making,
   * and one that means "the event fired" is not evidence the settlement was
   * written. A worker that dies between the two loses the only record that
   * anything was owed back.
   *
   * This is what turns that from permanent into late. Optional, so a caller
   * that has not wired it keeps working — it degrades to the previous
   * behaviour, which over-counts a tenant's own usage against their ceiling
   * rather than under-counting it.
   */
  reconcileHolds?: () => Promise<{ settled: number; adjusted: number }>;
  runEngine: typeof runEngine;
}

/** What the worker needs to know about a claimed job. */
export interface ClaimedJobLike {
  id: string;
  projectId: string;
  userId: string;
  /** The organization this job belongs to, for the audit trail. */
  organizationId: string | null;
  /**
   * Quota units held for this run when it was admitted.
   *
   * Carried from the row rather than recomputed, because the estimate was made
   * in another process and only the row remembers it. The meter gives it back
   * against what the run actually authored.
   */
  reservedUnits?: number;
  kind: "GENERATE" | "BUILD" | "REFRESH";
  locale: string;
  targetSlug: string | null;
  feedback: string | null;
  /** Pages this run may re-author. Empty means a full run. */
  targetSlugs: string[];
  completedCount: number;
  resumed: boolean;
}

/** Options for {@link runWorkerOnce} and {@link startWorker}. */
export interface WorkerOptions {
  repoRoot: string;
  /** Identity this worker claims jobs under. */
  instanceId: string;
  /** How long a claim holds without renewal. */
  leaseMs?: number;
  /** How often to renew the claim while a job runs. */
  heartbeatMs?: number;
  /** How often to flush captured output to the job row. */
  logFlushMs?: number;
  /** How long to wait after finding no work. */
  idleMs?: number;
  log?: (message: string) => void;
  /**
   * Lifecycle bus. Defaults to one with nothing installed.
   *
   * Always present rather than optional at the emission site, so the code that
   * announces a finished job never branches on whether anyone is listening —
   * an `if` that is almost always false is an `if` that eventually gets it
   * wrong.
   */
  hooks?: HookBus;
}

/** Heartbeat comfortably inside the lease, so one missed tick is not fatal. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/** How often partial output reaches the job row. */
export const DEFAULT_LOG_FLUSH_MS = 2_000;

/** How long to sleep when the queue is empty. */
export const DEFAULT_IDLE_MS = 3_000;

/** What one pass of the loop did. */
export interface WorkerTick {
  /** The job that was claimed, or `null` when the queue was empty. */
  jobId: string | null;
  /** Whether the run succeeded. Undefined when nothing was claimed. */
  ok?: boolean;
  /** Whether this claim picked up an interrupted attempt. */
  resumed?: boolean;
  /** The project the claimed job belonged to. Undefined when none was. */
  projectId?: string;
}

/**
 * Claim one job and run it to completion.
 *
 * Returns rather than throwing, for the same reason the pipeline does: the loop
 * around it needs to keep going, and a failure is a verdict to record on the
 * job row rather than an exception to propagate out of a daemon.
 *
 * @returns What happened, so a caller can drive the loop or assert on one pass.
 */
export async function runWorkerOnce(
  deps: WorkerDeps,
  options: WorkerOptions,
): Promise<WorkerTick> {
  const log = options.log ?? (() => {});

  const job = await deps.claimNextJob({
    instanceId: options.instanceId,
    ...(options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : {}),
  });

  if (job === null) {
    return { jobId: null };
  }

  log(
    `▸ ${job.kind} ${job.id} (project ${job.projectId})` +
      (job.targetSlugs.length > 0
        ? ` — scoped to ${job.targetSlugs.length} page(s)`
        : "") +
      (job.resumed ? ` — resuming from ${job.completedCount} page(s)` : ""),
  );

  // The grid this run will walk, for the timeout budget. A project that is not
  // the job owner's cannot be measured, and a run that cannot be measured gets
  // the base allowance rather than an unbounded one.
  const pageCount = (await deps.countExpectedPages(job.projectId, job.userId)) ?? 0;

  let latest = "";
  let holdsClaim = true;

  // The heartbeat is what tells every other worker this job is alive. It is
  // kept apart from the log flush because a job can be working hard and
  // printing nothing, and silence must not read as death.
  const heartbeat = setInterval(() => {
    void deps
      .renewJobLease(job.id, options.instanceId)
      .then((held) => {
        if (!held) {
          // Another worker reclaimed this job while we were working on it, which
          // means our lease lapsed. Say so; the run itself is left to finish,
          // because killing it would abandon pages it has already written and
          // the reclaiming worker will skip whatever landed.
          holdsClaim = false;
          log(`  ! lost the claim on ${job.id}; another worker has taken it`);
        }
      })
      .catch(() => {
        // A failed renewal is not fatal on its own: the lease outlives several
        // missed ticks by design.
      });
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  const flush = setInterval(() => {
    void deps.updateJobLogs(job.id, latest, job.userId).catch(() => {
      // A failed log write must not abort the run it is only reporting on.
    });
  }, options.logFlushMs ?? DEFAULT_LOG_FLUSH_MS);

  let result: EngineResult;

  try {
    result = await deps.runEngine({
      repoRoot: options.repoRoot,
      kind: job.kind,
      projectId: job.projectId,
      userId: job.userId,
      locale: job.locale,
      jobId: job.id,
      pageCount,
      onlySlugs: job.targetSlugs,
      target:
        job.targetSlug !== null && job.feedback !== null
          ? { slug: job.targetSlug, feedback: job.feedback }
          : undefined,
      onOutput: (output) => {
        latest = output;
      },
    });
  } catch (error: unknown) {
    // `runEngine` does not reject, so reaching here is a bug in the worker
    // rather than a failed build — recorded on the job all the same, because
    // nothing else is listening.
    result = {
      ok: false,
      exitCode: -1,
      output:
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      durationMs: 0,
    };
  } finally {
    clearInterval(heartbeat);
    clearInterval(flush);
  }

  if (!holdsClaim) {
    // The job belongs to someone else now. Writing a verdict would overwrite
    // whatever they are doing with a run they did not perform.
    log(`  · ${job.id} finished, but the claim was lost; leaving the row alone`);
    return {
      jobId: job.id,
      ok: result.ok,
      resumed: job.resumed,
      projectId: job.projectId,
    };
  }

  await deps.finishJob(
    job.id,
    { ok: result.ok, exitCode: result.exitCode, logs: result.output },
    job.userId,
  );

  // Read after `finishJob`, so the number is the one the row will keep. A
  // failure here is not worth failing the run over: the pages are written and
  // the verdict is recorded, so the worst case is an unmetered job, which
  // under-bills rather than losing work.
  const pagesWritten = await (
    deps.readCompletedPages?.(job.id, job.userId) ?? Promise.resolve(0)
  ).catch(() => 0);

  // Announced after the verdict is durable, not before. A plugin told a job
  // succeeded must be able to rely on that being true even if this worker dies
  // in the next instant — and every listener failure here is absorbed, because
  // a run that finished is finished whatever an audit logger thinks.
  await (options.hooks ?? noopHookBus()).emit("afterJobCompleted", {
    jobId: job.id,
    projectId: job.projectId,
    userId: job.userId,
    organizationId: job.organizationId,
    kind: job.kind,
    ok: result.ok,
    exitCode: result.exitCode,
    resumed: job.resumed,
    pageCount: pagesWritten,
    // Defaulted rather than required, so a caller built before this column
    // existed still compiles. Zero is the honest reading for one: nothing was
    // held, so nothing is owed back.
    reservedUnits: job.reservedUnits ?? 0,
    durationMs: result.durationMs,
    completedAt: new Date().toISOString(),
  });

  log(
    `  ${result.ok ? "✓" : "✗"} ${job.id} — exit ${result.exitCode} in ` +
      `${Math.round(result.durationMs / 1000)}s`,
  );

  return {
    jobId: job.id,
    ok: result.ok,
    resumed: job.resumed,
    projectId: job.projectId,
  };
}

/** Stops a running worker loop. */
export interface WorkerHandle {
  stop: () => void;
  /** Resolves once the loop has finished the job it is on and exited. */
  done: Promise<void>;
}

/**
 * Run the loop until stopped.
 *
 * Stopping is cooperative and finishes the current job rather than abandoning
 * it: a worker told to stop mid-run that dropped the job would leave a lease to
 * lapse and another worker to redo the tail of it, which is exactly the waste
 * the lease exists to avoid. A worker that is *killed* still loses nothing
 * durable — that is what the lease and the resume are for.
 */
export function startWorker(
  deps: WorkerDeps,
  options: WorkerOptions,
  sleepFn: (ms: number) => Promise<void>,
): WorkerHandle {
  let running = true;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const hooks = options.hooks ?? noopHookBus();

  // Work done since this worker was last idle. The drain event is emitted from
  // these on the *transition* to empty, and they reset immediately after: a
  // worker polling an empty queue every few seconds must announce a drain once,
  // not twenty times a minute, or every listener acting on it — a deploy
  // trigger above all — acts on it just as often.
  let succeeded = 0;
  let failed = 0;
  let projects = new Set<string>();

  const announceDrain = async (
    reason: "queue-empty" | "worker-stopping",
  ): Promise<void> => {
    if (succeeded + failed === 0) {
      return;
    }

    const payload = {
      instanceId: options.instanceId,
      succeeded,
      failed,
      projectIds: [...projects],
      reason,
      drainedAt: new Date().toISOString(),
    };

    // Reset before emitting, not after. A listener that takes seconds must not
    // leave a window in which a second drain reports the same work again, and
    // emit never rejects, so there is no failure path that would want the
    // counters back.
    succeeded = 0;
    failed = 0;
    projects = new Set<string>();

    await hooks.emit("afterQueueDrained", payload);
  };

  const report = options.log ?? ((): void => {});

  const done = (async () => {
    while (running) {
      const tick = await runWorkerOnce(deps, options);

      if (tick.jobId !== null) {
        if (tick.ok === true) {
          succeeded += 1;
        } else {
          failed += 1;
        }

        if (tick.projectId !== undefined) {
          projects.add(tick.projectId);
        }

        // A busy queue drains without pausing between jobs.
        continue;
      }

      // The queue was observed empty, which is the only evidence this worker
      // ever gets that the content is settled.
      await announceDrain("queue-empty");

      // An idle worker is the right place to give back holds whose settlement
      // event was lost. Never while jobs are waiting: this reads and writes the
      // same tables the queue does, and a reconciler that competed with real
      // work would trade a billing correction for a slower build.
      //
      // Failures are absorbed and reported. Reconciliation is a correction, and
      // a correction that could stop a worker claiming its next job would be a
      // worse fault than the one it fixes.
      if (deps.reconcileHolds !== undefined) {
        try {
          const reconciled = await deps.reconcileHolds();

          if (reconciled.settled > 0) {
            report(
              `  · settled ${reconciled.settled} stranded quota hold(s), ` +
                `${reconciled.adjusted} unit(s) adjusted`,
            );
          }
        } catch (error: unknown) {
          report(
            `  ! could not reconcile quota holds: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (running) {
        await sleepFn(idleMs);
      }
    }

    // Stopped part-way through a stretch. The queue may well not be empty, so
    // this is not the same claim as above and says so — but staying silent
    // would leave pages that were generated, never announced, and therefore
    // never published, with the site stale and nothing reporting why.
    await announceDrain("worker-stopping");
  })();

  return {
    stop: () => {
      running = false;
    },
    done,
  };
}
