import { Prisma } from "@prisma/client";
import type { JobKind, JobStatus, PrismaClient } from "@prisma/client";

import { withDbRetry } from "./retry.js";

/**
 * Tenant-scoped reads and job bookkeeping.
 *
 * Every function here takes a `userId` and folds it into the `where` clause
 * rather than fetching a row and checking its owner afterwards. The difference
 * matters: a fetch-then-check leaks existence — a wrong owner and a missing id
 * become distinguishable — and it is one early `return` away from being skipped
 * entirely. Scoping in the query makes the wrong result unrepresentable.
 *
 * This lives in the database package, not the dashboard, so the isolation can
 * be tested against a mock instead of asserted by reading JSX.
 */

/**
 * The single operator this phase assumes.
 *
 * A placeholder for a session subject, not a substitute for one. Everything
 * that consumes it takes the id as an argument, so replacing this constant with
 * a real session is a change at the composition root and nowhere else.
 */
export const LOCAL_OPERATOR_ID = "local-operator";

/** Environment variable carrying the operator a spawned command acts as. */
export const OPERATOR_ID_ENV_VAR = "STATICFORGE_USER_ID";

/**
 * The operator this process is acting as.
 *
 * The engine's commands are spawned by the dashboard and run by hand, and both
 * now have to name an owner — every scoped query requires one. Reading it from
 * the environment rather than `argv` is the same choice the refresh feedback
 * makes: on Windows the spawn goes through a shell, and identity is not
 * something to hand to a shell parser.
 *
 * Falls back to {@link LOCAL_OPERATOR_ID} so a local run needs no setup, and so
 * this returns the value the schema's own column default already assumes.
 */
export function resolveOperatorId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[OPERATOR_ID_ENV_VAR];

  return value === undefined || value.trim() === ""
    ? LOCAL_OPERATOR_ID
    : value.trim();
}

/** A project as a listing shows it. */
export interface TenantProjectSummary {
  id: string;
  name: string;
  slug: string;
  locale: string;
  siteUrl: string | null;
  templateId: string;
  contentProfileId: string;
  workspaceName: string;
  businessName: string | null;
  serviceCount: number;
  locationCount: number;
  pageCount: number;
  /** Pages the service × city grid would produce. */
  expectedPages: number;
}

/** Everything a project's detail view needs. */
export interface TenantProjectDetail extends TenantProjectSummary {
  services: Array<{
    id: string;
    name: string;
    slug: string;
    templateId: string | null;
    contentProfileId: string | null;
  }>;
  locations: Array<{ id: string; name: string; city: string; state: string }>;
  pages: Array<{
    slug: string;
    title: string;
    templateId: string;
    contentProfileId: string;
    source: string;
    linkCount: number;
    updatedAt: string;
  }>;
  recentJobs: JobSummary[];
}

/** A job as the UI polls it. */
export interface JobSummary {
  id: string;
  kind: JobKind;
  status: JobStatus;
  logs: string;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Whether the job has stopped, either way. */
  finished: boolean;
  /** Whole percentage, 0-100, derived from the counts below. */
  progress: number;
  /** Pages this run expects, or `null` before it has loaded its input. */
  totalCount: number | null;
  completedCount: number;
  failedCount: number;
}

/** Shape a Prisma job row for transport. */
function toJobSummary(job: {
  id: string;
  kind: JobKind;
  status: JobStatus;
  logs: string;
  exitCode: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  progress: number;
  totalCount: number | null;
  completedCount: number;
  failedCount: number;
}): JobSummary {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    logs: job.logs,
    exitCode: job.exitCode,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    finished: job.status === "COMPLETED" || job.status === "FAILED",
    progress: job.progress,
    totalCount: job.totalCount,
    completedCount: job.completedCount,
    failedCount: job.failedCount,
  };
}

/** Whether the database answers at all. */
export async function isDatabaseReachable(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    // An unreachable database is an ordinary state: the engine also runs
    // entirely from local files.
    return false;
  }
}

/** List the projects one user owns. */
export async function listProjectsForUser(
  userId: string,
  prisma: PrismaClient,
): Promise<TenantProjectSummary[]> {
  const projects = await prisma.project.findMany({
    where: { userId },
    orderBy: [{ workspaceId: "asc" }, { slug: "asc" }],
    include: {
      workspace: { select: { name: true } },
      business: { select: { name: true } },
      _count: { select: { services: true, locations: true, generatedPages: true } },
    },
  });

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    locale: project.locale,
    siteUrl: project.siteUrl,
    templateId: project.templateId,
    contentProfileId: project.contentProfileId,
    workspaceName: project.workspace.name,
    businessName: project.business?.name ?? null,
    serviceCount: project._count.services,
    locationCount: project._count.locations,
    pageCount: project._count.generatedPages,
    expectedPages: project._count.services * project._count.locations,
  }));
}

/**
 * Load one project a user owns.
 *
 * Returns `null` both when the project does not exist and when it belongs to
 * someone else. That the two are indistinguishable is the point: a caller
 * cannot use this to discover which ids are real.
 */
export async function getProjectForUser(
  projectId: string,
  userId: string,
  prisma: PrismaClient,
): Promise<TenantProjectDetail | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    include: {
      workspace: { select: { name: true } },
      business: { select: { name: true } },
      services: { orderBy: { slug: "asc" } },
      locations: { orderBy: { slug: "asc" } },
      generatedPages: { orderBy: { slug: "asc" } },
      jobs: { orderBy: { createdAt: "desc" }, take: 5 },
      _count: { select: { services: true, locations: true, generatedPages: true } },
    },
  });

  if (project === null) {
    return null;
  }

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    locale: project.locale,
    siteUrl: project.siteUrl,
    templateId: project.templateId,
    contentProfileId: project.contentProfileId,
    workspaceName: project.workspace.name,
    businessName: project.business?.name ?? null,
    serviceCount: project._count.services,
    locationCount: project._count.locations,
    pageCount: project._count.generatedPages,
    expectedPages: project._count.services * project._count.locations,

    services: project.services.map((service) => ({
      id: service.id,
      name: service.name,
      slug: service.slug,
      templateId: service.templateId,
      contentProfileId: service.contentProfileId,
    })),

    locations: project.locations.map((location) => ({
      id: location.id,
      name: location.name,
      city: location.city,
      state: location.state,
    })),

    pages: project.generatedPages.map((page) => ({
      slug: page.slug,
      title: page.title,
      templateId: page.templateId,
      contentProfileId: page.contentProfileId,
      source: page.source,
      linkCount: Array.isArray(page.links) ? page.links.length : 0,
      updatedAt: page.updatedAt.toISOString(),
    })),

    recentJobs: project.jobs.map(toJobSummary),
  };
}

/**
 * Record the intent to run the engine.
 *
 * Ownership is verified in the same call, not before it: a check-then-create
 * has a window in which the project could change hands, and more practically it
 * is a second place the scope could be forgotten.
 *
 * @returns The queued job, or `null` when the user does not own the project.
 */
export async function enqueueJob(
  projectId: string,
  userId: string,
  kind: JobKind,
  prisma: PrismaClient,
  target?: { slug: string; feedback: string },
): Promise<JobSummary | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });

  if (project === null) {
    return null;
  }

  const job = await prisma.generationJob.create({
    data: {
      projectId,
      userId,
      kind,
      status: "PENDING",
      ...(target !== undefined
        ? { targetSlug: target.slug, feedback: target.feedback }
        : {}),
    },
  });

  return toJobSummary(job);
}

/**
 * How long a claim on a running job holds without being renewed.
 *
 * Long enough that an ordinary pause — a slow provider call, a stalled build
 * step — does not look like death, short enough that a genuinely dead worker's
 * job is reclaimed while an operator is still watching it.
 */
export const JOB_LEASE_MS = 120_000;

/** A worker's claim on the jobs it is running. */
export interface JobLease {
  /**
   * Stable identity of the server instance.
   *
   * Stable across a restart of the *same* instance, and distinct between
   * instances — a hostname or a deployment slot, not a pid. That is what makes
   * "this instance's own leftovers" a safe thing to reclaim on boot while
   * another instance's live jobs are not.
   */
  instanceId: string;
  /** How long the claim holds. Defaults to {@link JOB_LEASE_MS}. */
  leaseMs?: number;
}

/** When a claim taken now would lapse. */
function leaseDeadline(lease: JobLease, now: Date): Date {
  return new Date(now.getTime() + (lease.leaseMs ?? JOB_LEASE_MS));
}

/**
 * Mark a job as started and claim it for this instance.
 *
 * The claim is what makes the job's liveness observable from another process.
 * Without it, "RUNNING" means only that some process once said so, which is
 * indistinguishable from a process that has since died.
 *
 * ## Why these writes take an owner, and why they use `updateMany`
 *
 * Every write below addresses a job by id alone unless the owner is part of the
 * `where`. An id is not a capability: it appears in a URL, a log line and a
 * poller's request, so "knows the id" cannot be allowed to mean "may overwrite
 * the logs" or "may mark it failed".
 *
 * `updateMany` rather than `update` because `update` wants a unique `where`,
 * and an id *is* unique — which is exactly the problem: the scope would have to
 * be a separate check on the result, which is the pattern this module exists to
 * avoid. `updateMany` takes the whole condition, so a job belonging to someone
 * else matches nothing.
 *
 * Each returns whether it actually hit a row, so a caller can tell "done" from
 * "not yours" instead of assuming the first.
 *
 * @returns Whether the job was found and updated.
 */
export async function markJobRunning(
  jobId: string,
  userId: string,
  prisma: PrismaClient,
  lease?: JobLease,
): Promise<boolean> {
  const now = new Date();

  // Retried: losing this to a dropped connection leaves a job that a worker
  // believes it started and the database believes is still queued.
  const { count } = await withDbRetry(() =>
    prisma.generationJob.updateMany({
      where: { id: jobId, userId },
      data: {
        status: "RUNNING",
        startedAt: now,
        ...(lease === undefined
          ? {}
          : {
              lockedBy: lease.instanceId,
              leaseExpiresAt: leaseDeadline(lease, now),
            }),
      },
    }),
  );

  return count > 0;
}

/**
 * Append progress to a running job, and renew its claim.
 *
 * Scoped to the owner for the same reason the rest are: an unscoped log write
 * lets anyone holding a job id overwrite what an operator is reading.
 *
 * Replaces rather than concatenates: the caller owns the buffer and has already
 * trimmed it, and a database-side append would grow without bound on a job that
 * prints megabytes.
 *
 * The lease rides along on this write rather than taking one of its own. The
 * flush already runs on a timer for exactly as long as the job does, so it is
 * the heartbeat — and a second periodic write would double the cost of the
 * noisiest query in the system to say something this one already proves.
 *
 * Deliberately *not* wrapped in {@link withDbRetry}, unlike every other write
 * here. The flush already repeats every couple of seconds with the same buffer,
 * so the next tick is the retry — a backoff loop inside one tick would only
 * risk overlapping with it, on the highest-frequency query in the system, to
 * re-send a log line that is about to be sent again anyway. The lease is what
 * makes that safe: it outlives several missed flushes.
 */
export async function updateJobLogs(
  jobId: string,
  logs: string,
  userId: string,
  prisma: PrismaClient,
  lease?: JobLease,
): Promise<boolean> {
  const { count } = await prisma.generationJob.updateMany({
    where: { id: jobId, userId },
    data: {
      logs,
      ...(lease === undefined
        ? {}
        : { leaseExpiresAt: leaseDeadline(lease, new Date()) }),
    },
  });

  return count > 0;
}

/**
 * Close a job out, either way.
 *
 * The claim is released explicitly. A finished job holding a lease would be
 * invisible to orphan recovery, which is correct but only by accident; clearing
 * it makes "has a lease" mean "is being worked on" and nothing else.
 */
export async function finishJob(
  jobId: string,
  outcome: { ok: boolean; exitCode: number; logs: string },
  userId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  // The worst write in the system to lose: a run that finished but could not
  // say so leaves a job reading RUNNING until its lease lapses, and an operator
  // watching a completed build that never completes.
  const { count } = await withDbRetry(() =>
    prisma.generationJob.updateMany({
      where: { id: jobId, userId },
      data: {
        status: outcome.ok ? "COMPLETED" : "FAILED",
        exitCode: outcome.exitCode,
        logs: outcome.logs,
        completedAt: new Date(),
        lockedBy: null,
        leaseExpiresAt: null,
      },
    }),
  );

  return count > 0;
}

/**
 * How many pages a run for this project is expected to produce.
 *
 * The service x location grid, which is what `buildPages` walks. Used to budget
 * a run's timeout: a flat limit either kills a large project or gives a small
 * one an hour to hang in, and only the caller's own project may be measured, so
 * this is scoped like every other read here.
 *
 * @returns The expected page count, or `null` when the project is not the
 * caller's — the same answer as a project that does not exist.
 */
export async function countExpectedPages(
  projectId: string,
  userId: string,
  prisma: PrismaClient,
): Promise<number | null> {
  const project = await withDbRetry(() =>
    prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { _count: { select: { services: true, locations: true } } },
    }),
  );

  return project === null
    ? null
    : project._count.services * project._count.locations;
}

/** Read one job a user owns, or `null`. */
export async function getJobForUser(
  jobId: string,
  userId: string,
  prisma: PrismaClient,
): Promise<JobSummary | null> {
  const job = await prisma.generationJob.findFirst({
    where: { id: jobId, userId },
  });

  return job === null ? null : toJobSummary(job);
}

/** How long a job may sit unclaimed before it is assumed abandoned. */
export const PENDING_GRACE_MS = 300_000;

/** Knobs for {@link failOrphanedJobs}. */
export interface OrphanRecoveryOptions {
  /**
   * This instance's identity. Jobs it still holds a claim on are reclaimed
   * unconditionally: the instance is booting, so nothing it owned survived.
   */
  instanceId?: string;
  /** How long an unclaimed PENDING job may wait. Defaults to {@link PENDING_GRACE_MS}. */
  pendingGraceMs?: number;
  /** Injected so the recovery window is testable without waiting for a clock. */
  now?: Date;
}

/**
 * Fail every job that nothing is working on any more.
 *
 * ## Why this is not "everything still RUNNING"
 *
 * A job row outlives the process that was updating it, so a restart mid-build
 * would otherwise leave a job spinning forever and a poller waiting on it. The
 * obvious fix — fail everything PENDING or RUNNING at startup — is correct for
 * exactly one deployment: a single process on a single machine. The moment a
 * second instance exists, every cold start becomes an act of sabotage, failing
 * work that another instance is doing *right now*, for every tenant at once.
 *
 * So liveness is read from the lease instead of from the status, and a job is
 * reclaimed only when one of three things is true:
 *
 * - **This instance holds it.** It is booting; nothing it owned is alive.
 * - **Its lease has lapsed.** The owner stopped renewing, whatever became of it.
 * - **It was never claimed and has waited too long.** A PENDING row nothing
 *   picked up. The grace period is what keeps a job enqueued moments ago from
 *   being destroyed by a concurrent boot.
 *
 * A job another instance is actively renewing matches none of these, which is
 * the whole point.
 *
 * @param prisma - The client to write with.
 * @param options - This instance's identity and the recovery window.
 * @returns How many jobs were closed out.
 */
export async function failOrphanedJobs(
  prisma: PrismaClient,
  options: OrphanRecoveryOptions = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const pendingCutoff = new Date(
    now.getTime() - (options.pendingGraceMs ?? PENDING_GRACE_MS),
  );

  const abandoned: Prisma.GenerationJobWhereInput[] = [
    { leaseExpiresAt: { lt: now } },
    { leaseExpiresAt: null, createdAt: { lt: pendingCutoff } },
  ];

  if (options.instanceId !== undefined) {
    abandoned.unshift({ lockedBy: options.instanceId });
  }

  // Retried: this runs once at boot, and a connection that was not ready yet is
  // the single most likely moment for it to fail.
  const result = await withDbRetry(() =>
    prisma.generationJob.updateMany({
      where: {
        status: { in: ["PENDING", "RUNNING"] },
        OR: abandoned,
      },
      data: {
        status: "FAILED",
        exitCode: -1,
        completedAt: now,
        lockedBy: null,
        leaseExpiresAt: null,
      },
    }),
  );

  return result.count;
}

// ---------------------------------------------------------------------------
// Single-page reads and writes, for the refresh loop
// ---------------------------------------------------------------------------

/** One stored page, in the engine's shape. */
export interface StoredPage {
  slug: string;
  locale: string;
  title: string;
  metaDescription: string;
  h1: string;
  content: unknown;
  schemaOrg: unknown;
  templateId: string;
  contentProfileId: string;
  businessId: string;
  serviceId: string;
  locationId: string;
  links: unknown;
  generation?: unknown;
}

/**
 * Read one page a user owns.
 *
 * Scoped through the project, so a page is unreachable unless its project is —
 * the same guarantee, applied one level down rather than restated.
 */
export async function getPageForUser(
  projectId: string,
  slug: string,
  userId: string,
  prisma: PrismaClient,
): Promise<StoredPage | null> {
  const page = await prisma.generatedPage.findFirst({
    where: { projectId, slug, project: { userId } },
  });

  if (page === null) {
    return null;
  }

  return {
    slug: page.slug,
    locale: page.locale,
    title: page.title,
    metaDescription: page.metaDescription,
    h1: page.h1,
    content: page.content,
    schemaOrg: page.schemaOrg,
    templateId: page.templateId,
    contentProfileId: page.contentProfileId,
    // The page row does not store businessId — a project has exactly one
    // business — so the caller supplies it from the project payload.
    businessId: "",
    serviceId: page.serviceId,
    locationId: page.locationId,
    links: page.links,
    // A template page has no provenance, and the column holds NULL. Zod's
    // `.optional()` means absent, not null, so the two are reconciled here —
    // at the boundary, once, rather than at every call site.
    generation: page.generation === null ? undefined : page.generation,
  };
}

/**
 * Replace one page's authored content after a revision.
 *
 * Deliberately narrow: it writes only the fields a refresh may change, so a
 * mistake upstream cannot move a slug or clear a link graph through this path.
 * `slug` appears only in the `where`.
 *
 * Scoped through the project relation, so the page is unreachable unless its
 * project is — the same guarantee `getPageForUser` gives on the read side,
 * applied to the write that follows it rather than assumed from it.
 *
 * @returns Whether the page was found and rewritten.
 */
export async function saveRefreshedPage(
  projectId: string,
  page: {
    slug: string;
    title: string;
    metaDescription: string;
    h1: string;
    content: unknown;
    /**
     * Realigned structured data, when the caller derived it.
     *
     * Not a field an editor or a model may set — it is computed from the copy
     * that just changed. Optional because a caller that did not recompute it
     * should leave the stored value alone rather than blank it.
     */
    schemaOrg?: unknown;
    generation?: unknown;
  },
  userId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  // Retried: this lands immediately after a paid authoring call, so losing it
  // to a connection blip means paying again for the same revision.
  const { count } = await withDbRetry(() =>
    prisma.generatedPage.updateMany({
      where: { projectId, slug: page.slug, project: { userId } },
      data: {
        title: page.title,
        metaDescription: page.metaDescription,
        h1: page.h1,
        content: page.content as Prisma.InputJsonObject,
        ...(page.schemaOrg === undefined
          ? {}
          : { schemaOrg: page.schemaOrg as Prisma.InputJsonObject }),
        generation:
          page.generation === undefined
            ? Prisma.DbNull
            : (page.generation as Prisma.InputJsonObject),
        source: "MANUAL",
      },
    }),
  );

  return count > 0;
}
