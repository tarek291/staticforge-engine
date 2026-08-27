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
  kind: "GENERATE" | "BUILD";
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  logs: string;
  exitCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  finished: boolean;
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

          <pre className="max-h-96 overflow-auto rounded-md bg-neutral-100 p-4 text-xs leading-relaxed dark:bg-neutral-900">
            {job.logs.length > 0 ? job.logs : "Waiting for output…"}
          </pre>

          {job.status === "COMPLETED" && (
            <p className="text-sm text-neutral-500">
              Reload to see the updated pages.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
