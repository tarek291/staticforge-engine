import type { JobKind, JobStatus, PrismaClient } from "@prisma/client";

import { withDbRetry } from "./retry.js";
import { JOB_LEASE_MS, type JobLease } from "./tenant.js";

/**
 * The job table, used as a queue.
 *
 * There is no broker here and deliberately so. A separate queue would be a
 * second thing to run, a second thing to secure, and a second place for the
 * truth about a run to live — for a workload measured in jobs per hour, not per
 * second. Postgres already holds the row that a dashboard polls and an operator
 * reads; making it the queue as well means the claim and the record of what was
 * claimed are the same write.
 *
 * ## What makes a claim safe without `FOR UPDATE SKIP LOCKED`
 *
 * A worker picks a candidate and then claims it with a *conditional* update:
 * the `where` repeats the condition that made the job claimable in the first
 * place. Two workers that pick the same row both issue that update; Postgres
 * serialises them, the first changes the row so the second's `where` no longer
 * matches, and it updates zero rows and moves on. The claim is decided by the
 * database, not by the gap between reading and writing.
 *
 * That is enough here. `SKIP LOCKED` wins under heavy contention, at the cost
 * of raw SQL and a transaction held open across the read; with a handful of
 * workers and jobs that run for minutes, a lost race costs one extra query.
 */

/** A job a worker has taken responsibility for. */
export interface ClaimedJob {
  id: string;
  projectId: string;
  userId: string;
  /**
   * The organization this job belongs to.
   *
   * Read on the claim, from the project, so the lifecycle event the worker
   * emits can be scoped to a tenant. An audit row that cannot say which
   * organization it belongs to is one that organization can never be shown.
   */
  organizationId: string;
  kind: JobKind;
  status: JobStatus;
  locale: string;
  targetSlug: string | null;
  feedback: string | null;
  /**
   * Pages this run may re-author, or empty for a full run.
   *
   * Carried on the claim rather than re-read later: the worker spawns the
   * engine from what it claimed, and a scope fetched separately is a scope that
   * can disagree with the row the lease is held on.
   */
  targetSlugs: string[];
  /** Pages already finished by an earlier attempt at this job. */
  completedCount: number;
  totalCount: number | null;
  /** Whether this claim picked up work an earlier attempt left unfinished. */
  resumed: boolean;
  /**
   * Quota units held when this job was admitted.
   *
   * Carried on the claim for the same reason the scope is: the hold was taken
   * in another process, and the row is the only place it is written down. The
   * meter nets it against what the run actually authored, so a worker that
   * lost this number would leave an estimate charged for work that may never
   * have happened.
   */
  reservedUnits: number;
}

/** Options for {@link claimNextJob}. */
export interface ClaimOptions {
  /** Identity of the worker taking the claim. */
  instanceId: string;
  /** How long the claim holds without renewal. Defaults to {@link JOB_LEASE_MS}. */
  leaseMs?: number;
  /** Injected so the reclaim window is testable without waiting for a clock. */
  now?: Date;
}

/**
 * Take the next job that needs a worker, or return `null`.
 *
 * Two kinds of job are claimable, and the second is what makes an interrupted
 * run recoverable rather than lost:
 *
 * - **`PENDING`** — enqueued and never started.
 * - **`RUNNING` with a lapsed lease** — a worker took it and stopped renewing,
 *   because it crashed, was redeployed, or lost the database. The row still
 *   carries how far that attempt got.
 *
 * Reclaiming beats failing. Phase 13 closed lapsed jobs out as failures, which
 * was right when nothing could resume them; now that a run skips the pages a
 * previous attempt already wrote, throwing the work away would mean re-buying
 * content the tenant has already paid for.
 *
 * Oldest first, so a job cannot be starved by newer ones arriving.
 *
 * @param prisma - The client to claim with.
 * @param options - Worker identity and lease length.
 * @returns The claimed job, or `null` when there is nothing to do or another
 * worker won the race.
 */
export async function claimNextJob(
  prisma: PrismaClient,
  options: ClaimOptions,
): Promise<ClaimedJob | null> {
  const now = options.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? JOB_LEASE_MS));

  /** What "claimable" means, expressed once so the read and the write agree. */
  const claimable = [
    { status: "PENDING" as const },
    { status: "RUNNING" as const, leaseExpiresAt: { lt: now } },
  ];

  const candidate = await withDbRetry(() =>
    prisma.generationJob.findFirst({
      where: { OR: claimable },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true },
    }),
  );

  if (candidate === null) {
    return null;
  }

  // The conditional claim. `OR: claimable` is repeated here on purpose: if
  // another worker took this row between the read above and this write, its
  // status and lease no longer satisfy the condition and this updates nothing.
  const { count } = await withDbRetry(() =>
    prisma.generationJob.updateMany({
      where: { id: candidate.id, OR: claimable },
      data: {
        status: "RUNNING",
        startedAt: now,
        lockedBy: options.instanceId,
        leaseExpiresAt,
      },
    }),
  );

  if (count === 0) {
    // Lost the race. The caller polls again rather than retrying here, so a
    // contended queue drains instead of two workers spinning on one row.
    return null;
  }

  const job = await withDbRetry(() =>
    prisma.generationJob.findFirst({
      where: { id: candidate.id },
      select: {
        id: true,
        projectId: true,
        userId: true,
        kind: true,
        status: true,
        targetSlug: true,
        feedback: true,
        targetSlugs: true,
        completedCount: true,
        totalCount: true,
        reservedUnits: true,
        project: { select: { locale: true, organizationId: true } },
      },
    }),
  );

  if (job === null) {
    // Deleted between the claim and the read — its project was removed, and the
    // row cascaded away. There is nothing left to run.
    return null;
  }

  return {
    id: job.id,
    projectId: job.projectId,
    userId: job.userId,
    organizationId: job.project.organizationId,
    kind: job.kind,
    status: job.status,
    locale: job.project.locale,
    targetSlug: job.targetSlug,
    feedback: job.feedback,
    targetSlugs: job.targetSlugs,
    completedCount: job.completedCount,
    totalCount: job.totalCount,
    resumed: candidate.status === "RUNNING",
    reservedUnits: job.reservedUnits,
  };
}

/**
 * Extend the claim on a job this worker holds.
 *
 * Scoped to `lockedBy`, so only the holder can renew. A worker that lost its
 * claim — because its lease lapsed and another worker reclaimed the job — gets
 * `false` and can stop rather than carry on writing to a run it no longer owns.
 *
 * @returns Whether the claim was still ours to extend.
 */
export async function renewJobLease(
  jobId: string,
  lease: JobLease,
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await withDbRetry(() =>
    prisma.generationJob.updateMany({
      where: { id: jobId, lockedBy: lease.instanceId },
      data: {
        leaseExpiresAt: new Date(now.getTime() + (lease.leaseMs ?? JOB_LEASE_MS)),
      },
    }),
  );

  return count > 0;
}

/** Counts a run reports as it works. */
export interface JobProgressReport {
  /** Total pages this run expects. Pass once, when the run knows. */
  totalCount?: number;
  /** Pages finished so far, including ones an earlier attempt had written. */
  completedCount?: number;
  /** Pages this run could not produce. */
  failedCount?: number;
}

/**
 * Turn counts into the whole percentage the dashboard binds to.
 *
 * Clamped to 0-100 and floored, so a progress bar never overruns and never
 * reads 100 before the run has actually finished. A run with no total yet
 * reports 0 rather than dividing by nothing.
 */
export function computeProgress(
  completedCount: number,
  failedCount: number,
  totalCount: number | null | undefined,
): number {
  if (totalCount === null || totalCount === undefined || totalCount <= 0) {
    return 0;
  }

  const done = Math.max(0, completedCount) + Math.max(0, failedCount);

  return Math.max(0, Math.min(100, Math.floor((done / totalCount) * 100)));
}

/**
 * Record how far a run has got.
 *
 * `progress` is derived here rather than sent by the caller, so the percentage
 * and the counts on the same row cannot disagree — a progress bar that says 80%
 * beside "12/500" is worse than no progress bar.
 *
 * Scoped to the job's owner, like every other write to this table: a job id
 * appears in a URL and a log line, and knowing one must not mean being able to
 * rewrite someone's run.
 *
 * @returns Whether the job was found and updated.
 */
export async function reportJobProgress(
  jobId: string,
  report: JobProgressReport,
  userId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  const current = await withDbRetry(() =>
    prisma.generationJob.findFirst({
      where: { id: jobId, userId },
      select: { totalCount: true, completedCount: true, failedCount: true },
    }),
  );

  if (current === null) {
    return false;
  }

  const totalCount = report.totalCount ?? current.totalCount;
  const completedCount = report.completedCount ?? current.completedCount;
  const failedCount = report.failedCount ?? current.failedCount;

  const { count } = await withDbRetry(() =>
    prisma.generationJob.updateMany({
      where: { id: jobId, userId },
      data: {
        totalCount,
        completedCount,
        failedCount,
        progress: computeProgress(completedCount, failedCount, totalCount),
      },
    }),
  );

  return count > 0;
}
