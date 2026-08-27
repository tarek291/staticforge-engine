"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";

/**
 * The operator's two buttons, and the job they start.
 *
 * The request no longer waits for the work. It queues a job, gets a 202 back,
 * and this component polls the job row until it stops — which is the only shape
 * that survives a five-hundred-page build without a proxy cutting the
 * connection.
 *
 * The only client component in the repository: the *generated* pages still ship
 * no JavaScript at all.
 */

interface Job {
  id: string;
  kind: "GENERATE" | "BUILD" | "REFRESH";
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  logs: string;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  finished: boolean;
  progress: number;
  totalCount: number | null;
  completedCount: number;
  failedCount: number;
}

/**
 * How far along a run is, in the two forms a person reads differently.
 *
 * The bar answers "roughly how much is left" at a glance; the count answers
 * "is it actually moving" — which is the question that matters during the
 * twenty minutes a five-hundred-page run spends looking identical. Both come
 * from the same row, so they cannot disagree.
 *
 * A queued job has no total yet and says so, rather than drawing an empty bar
 * that is indistinguishable from a stalled one.
 */
function JobProgress({ job }: { job: Job }): ReactElement {
  const known = job.totalCount !== null && job.totalCount > 0;
  const done = job.completedCount + job.failedCount;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-neutral-500">
          {known
            ? `${done}/${job.totalCount} pages`
            : job.status === "PENDING"
              ? "Waiting for a worker to pick this up"
              : "Counting pages…"}
          {job.failedCount > 0 && (
            <span className="text-red-600 dark:text-red-400">
              {" "}
              · {job.failedCount} failed
            </span>
          )}
        </span>
        {known && (
          <span className="font-mono tabular-nums text-neutral-500">
            {job.progress}%
          </span>
        )}
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? job.progress : undefined}
        aria-label={`${job.kind.toLowerCase()} progress`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
      >
        <div
          className={
            "h-full rounded-full transition-[width] duration-500 ease-out " +
            (job.status === "FAILED"
              ? "bg-red-500"
              : job.status === "COMPLETED"
                ? "bg-emerald-500"
                : "bg-neutral-900 dark:bg-white")
          }
          // Width is the one thing here that cannot come from a class: it is a
          // continuous value from the server, not one of a fixed set.
          style={{ width: `${known ? job.progress : 0}%` }}
        />
      </div>
    </div>
  );
}

interface Props {
  projectId: string;
  locale: string;
}

/** How often to ask the server how a job is doing. */
const POLL_MS = 1500;

export function ControlPanel({ projectId, locale }: Props): ReactElement {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  // Held in a ref so the polling effect can clear itself without the interval
  // becoming a dependency of its own cleanup.
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (job === null || job.finished) {
      if (timer.current !== null) {
        clearInterval(timer.current);
        timer.current = null;
      }
      return;
    }

    const jobId = job.id;

    timer.current = setInterval(() => {
      void fetch(`/api/dashboard/jobs/${jobId}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((next: Job | null) => {
          if (next !== null) setJob(next);
        })
        .catch(() => {
          // A dropped poll is not a failed job. The next tick retries; if the
          // server is gone for good, the operator will see the logs stop.
        });
    }, POLL_MS);

    return () => {
      if (timer.current !== null) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [job]);

  async function start(kind: "GENERATE" | "BUILD"): Promise<void> {
    setStarting(kind);
    setError(null);
    setJob(null);

    try {
      const response = await fetch("/api/dashboard/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, kind, locale }),
      });

      const body: unknown = await response.json();

      if (response.status !== 202) {
        setError((body as { error?: string }).error ?? `HTTP ${response.status}`);
        return;
      }

      setJob(body as Job);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(null);
    }
  }

  const busy = starting !== null || (job !== null && !job.finished);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void start("GENERATE")}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          Generate pages
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => void start("BUILD")}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-neutral-700"
        >
          Generate + validate + build
        </button>

        {job !== null && !job.finished && (
          <span className="text-sm text-neutral-500">
            {job.status === "PENDING" ? "Queued…" : "Running…"} job {job.id}
          </span>
        )}
      </div>

      {error !== null && (
        <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {job !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            <span
              className={
                job.status === "COMPLETED"
                  ? "font-medium text-emerald-600 dark:text-emerald-400"
                  : job.status === "FAILED"
                    ? "font-medium text-red-600 dark:text-red-400"
                    : "font-medium text-neutral-500"
              }
            >
              {job.status === "COMPLETED"
                ? "✓ Completed"
                : job.status === "FAILED"
                  ? `✗ Failed${job.exitCode !== null ? ` (exit ${job.exitCode})` : ""}`
                  : job.status}
            </span>
            <span className="text-neutral-500"> · {job.kind.toLowerCase()}</span>
          </p>

          <JobProgress job={job} />

          <pre className="max-h-96 overflow-auto rounded-md bg-neutral-100 p-4 text-xs leading-relaxed dark:bg-neutral-900">
            {job.logs.length > 0 ? job.logs : "Waiting for output…"}
          </pre>

          {job.status === "COMPLETED" && (
            <p className="text-sm text-neutral-500">
              Reload to see the updated pages.
            </p>
          )}

          {job.status === "PENDING" && (
            <p className="text-sm text-neutral-500">
              Queued. A worker picks this up on its next poll — start one with{" "}
              <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-xs dark:bg-neutral-900">
                pnpm staticforge worker
              </code>
              .
            </p>
          )}
        </div>
      )}
    </section>
  );
}
