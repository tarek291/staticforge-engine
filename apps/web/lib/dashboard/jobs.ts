import {
  finishJob,
  markJobRunning,
  prisma,
  updateJobLogs,
  type JobKind,
  type JobLease,
} from "@staticforge/database";

import { instanceId } from "./instance";
import { runGenerate, runPipeline, runRefresh } from "./run-command";

/**
 * Runs a queued job in the background.
 *
 * Generating five hundred pages takes minutes; an HTTP request that waits for
 * it will be cut off by a proxy, a browser, or a platform timeout long before
 * it finishes. So the request records the intent and returns, and the work
 * outlives it.
 *
 * ## What this is and is not
 *
 * This is an in-process worker, not a queue. It survives the request but not
 * the server: a restart mid-run leaves a row saying RUNNING that nothing will
 * ever finish, which is why `failOrphanedJobs` exists and why the dashboard
 * calls it at startup. A real queue — a separate worker reading from the
 * database — is the next step, and the `GenerationJob` row is already the
 * handoff point it would use.
 *
 * ## The lease is what makes that safe with more than one instance
 *
 * A job is claimed for this instance when it starts, and the claim is renewed
 * by the same timer that flushes the logs — so "this job is alive" is a fact
 * another instance can read from the row rather than infer from its own uptime.
 * Recovery then reclaims only jobs whose claim lapsed, instead of everything
 * that happens to say RUNNING, which is what allowed a cold start to kill work
 * belonging to every other tenant.
 */

/** How often progress is written back while a job runs. */
const LOG_FLUSH_MS = 2000;

/** Jobs started by this process, so a second click cannot double-run one. */
const inFlight = new Set<string>();

/**
 * Start a job, returning immediately.
 *
 * Deliberately not awaited by the caller. Failures are recorded on the job row
 * rather than thrown, because by the time one happens there is no request left
 * to answer.
 */
export function startJob(
  jobId: string,
  projectId: string,
  kind: JobKind,
  locale: string,
  userId: string,
  /** Pages this run is expected to produce, for the timeout budget. */
  pageCount: number,
  target?: { slug: string; feedback: string },
): void {
  if (inFlight.has(jobId)) {
    return;
  }

  inFlight.add(jobId);

  void run(jobId, projectId, kind, locale, userId, pageCount, target).finally(
    () => {
      inFlight.delete(jobId);
    },
  );
}

async function run(
  jobId: string,
  projectId: string,
  kind: JobKind,
  locale: string,
  userId: string,
  pageCount: number,
  target?: { slug: string; feedback: string },
): Promise<void> {
  const lease: JobLease = { instanceId: instanceId() };

  try {
    await markJobRunning(jobId, userId, prisma, lease);

    // Flush partial output on a timer, so a poller sees the run progressing
    // rather than a blank screen followed by a verdict.
    let latest = "";
    const flush = setInterval(() => {
      // The flush is also the heartbeat: it renews the claim on this job, so a
      // run that is genuinely progressing is never mistaken for an orphan.
      void updateJobLogs(jobId, latest, userId, prisma, lease).catch(() => {
        // A failed log write must not abort the run it is only reporting on.
      });
    }, LOG_FLUSH_MS);

    const onOutput = (output: string): void => {
      latest = output;
    };

    const result =
      kind === "REFRESH"
        ? await runRefresh(projectId, target, locale, userId, onOutput)
        : kind === "BUILD"
          ? await runPipeline(projectId, locale, userId, pageCount, onOutput)
          : await runGenerate(projectId, locale, userId, pageCount, onOutput);

    clearInterval(flush);

    await finishJob(
      jobId,
      { ok: result.ok, exitCode: result.exitCode, logs: result.output },
      userId,
      prisma,
    );
  } catch (error: unknown) {
    // The worker itself failed — a database write, say. Record it on the job,
    // since nothing else is listening.
    await finishJob(
      jobId,
      {
        ok: false,
        exitCode: -1,
        logs:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      },
      userId,
      prisma,
    ).catch(() => {
      // Nothing left to do: the row will be closed out as orphaned at startup.
    });
  }
}
