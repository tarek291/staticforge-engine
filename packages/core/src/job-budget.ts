/**
 * How long a generation run may take before it is assumed hung.
 *
 * A fixed timeout cannot serve this workload. The job system exists because a
 * five-hundred-page run outlives an HTTP request — and a flat ten minutes then
 * killed every such run before it could finish, so the mechanism built to allow
 * long work was the thing forbidding it. The number has to come from the size
 * of the work instead.
 *
 * The budget is deliberately generous. A timeout here is a safety net for a
 * process that has genuinely stopped responding, not a schedule: killing a
 * healthy run costs an operator the whole pass and, when authoring is on, the
 * money already spent on it. Being late to notice a hang is much cheaper than
 * being early to kill progress.
 */

/** Fixed overhead: process start, input load, validation, build, publish. */
export const BASE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Per-page allowance when the AI authoring pass is on.
 *
 * Each page is one paced provider call: a fixed delay between calls plus the
 * model's own latency, which for a long structured answer is tens of seconds.
 */
export const AI_MS_PER_PAGE = 30_000;

/**
 * Per-page allowance for a deterministic run.
 *
 * Template assembly is in-memory and measured in milliseconds; this covers the
 * per-page file write and leaves headroom for a slow disk.
 */
export const TEMPLATE_MS_PER_PAGE = 250;

/**
 * Ceiling on any single run.
 *
 * Past this, a run is not slow, it is stuck — and an unbounded timeout would
 * pin a worker forever on a job nothing will ever finish.
 */
export const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** What the run has to get through. */
export interface CommandWorkload {
  /**
   * Pages this run is expected to produce. Zero when it cannot be known — the
   * budget then falls back to the base allowance rather than guessing.
   */
  pageCount: number;
  /** Whether the AI authoring pass will run, which dominates the cost per page. */
  aiEnabled: boolean;
}

/**
 * Budget one run.
 *
 * @param workload - Size of the run and whether authoring is on.
 * @returns The timeout in milliseconds, clamped to {@link MAX_TIMEOUT_MS}.
 */
export function computeCommandTimeoutMs(workload: CommandWorkload): number {
  const perPage = workload.aiEnabled ? AI_MS_PER_PAGE : TEMPLATE_MS_PER_PAGE;
  const pages = Number.isFinite(workload.pageCount)
    ? Math.max(0, Math.trunc(workload.pageCount))
    : 0;

  return Math.min(BASE_TIMEOUT_MS + pages * perPage, MAX_TIMEOUT_MS);
}

/** Render a budget for a log line, so an operator can see what it was given. */
export function describeBudget(timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);

  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
