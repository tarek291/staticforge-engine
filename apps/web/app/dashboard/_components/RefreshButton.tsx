"use client";

import { useEffect, useState, type ReactElement } from "react";

/**
 * Per-page revision control.
 *
 * Opens an inline field for the feedback, queues a REFRESH job, and polls it —
 * the same async path the project-wide buttons use, because a rewrite is one
 * model call and can still outlast a request.
 */

interface Job {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  logs: string;
  exitCode: number | null;
  finished: boolean;
}

interface Props {
  projectId: string;
  slug: string;
  locale: string;
}

const POLL_MS = 1500;

export function RefreshButton({ projectId, slug, locale }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (job === null || job.finished) {
      return;
    }

    const timer = setInterval(() => {
      void fetch(`/api/dashboard/jobs/${job.id}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((next: Job | null) => {
          if (next !== null) setJob(next);
        })
        .catch(() => {
          // A dropped poll is not a failed job; the next tick retries.
        });
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [job]);

  async function submit(): Promise<void> {
    const trimmed = feedback.trim();

    if (trimmed.length === 0) {
      setError("Say what should change.");
      return;
    }

    setError(null);
    setJob(null);

    try {
      const response = await fetch("/api/dashboard/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          kind: "REFRESH",
          slug,
          feedback: trimmed,
          locale,
        }),
      });

      const body: unknown = await response.json();

      if (response.status !== 202) {
        setError((body as { error?: string }).error ?? `HTTP ${response.status}`);
        return;
      }

      setJob(body as Job);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  const running = job !== null && !job.finished;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs underline underline-offset-4 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        optimize
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={feedback}
          disabled={running}
          onChange={(event) => setFeedback(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
            if (event.key === "Escape") setOpen(false);
          }}
          placeholder="What should change?"
          className="w-64 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
        />
        <button
          type="button"
          disabled={running}
          onClick={() => void submit()}
          className="rounded-md bg-neutral-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          {running ? "…" : "revise"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-neutral-500 underline underline-offset-4"
        >
          cancel
        </button>
      </div>

      {error !== null && <p className="text-xs text-red-600">{error}</p>}

      {job !== null && (
        <p className="text-xs">
          <span
            className={
              job.status === "COMPLETED"
                ? "text-emerald-600 dark:text-emerald-400"
                : job.status === "FAILED"
                  ? "text-red-600 dark:text-red-400"
                  : "text-neutral-500"
            }
          >
            {job.status === "COMPLETED"
              ? "✓ revised — reload to see it"
              : job.status === "FAILED"
                ? `✗ ${job.logs.split("\n").filter(Boolean).slice(-1)[0] ?? "failed"}`
                : "revising…"}
          </span>
        </p>
      )}
    </div>
  );
}
