import {
  finishJob,
  markJobRunning,
  prisma,
  updateJobLogs,
  type JobKind,
} from "@staticforge/database";

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
  target?: { slug: string; feedback: string },
): void {
  if (inFlight.has(jobId)) {
    return;
  }

  inFlight.add(jobId);

  void run(jobId, projectId, kind, locale, target).finally(() => {
    inFlight.delete(jobId);
  });
}

async function run(
  jobId: string,
  projectId: string,
  kind: JobKind,
  locale: string,
  target?: { slug: string; feedback: string },
): Promise<void> {
  try {
    await markJobRunning(jobId, prisma);

    // Flush partial output on a timer, so a poller sees the run progressing
    // rather than a blank screen followed by a verdict.
    let latest = "";
    const flush = setInterval(() => {
      if (latest.length > 0) {
        void updateJobLogs(jobId, latest, prisma).catch(() => {
          // A failed log write must not abort the run it is only reporting on.
        });
      }
    }, LOG_FLUSH_MS);

    const onOutput = (output: string): void => {
      latest = output;
    };

    const result =
      kind === "REFRESH"
        ? await runRefresh(projectId, target, locale, onOutput)
        : kind === "BUILD"
          ? await runPipeline(projectId, locale, onOutput)
          : await runGenerate(projectId, locale, onOutput);

    clearInterval(flush);

    await finishJob(
      jobId,
      { ok: result.ok, exitCode: result.exitCode, logs: result.output },
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
      prisma,
    ).catch(() => {
      // Nothing left to do: the row will be closed out as orphaned at startup.
    });
  }
}
