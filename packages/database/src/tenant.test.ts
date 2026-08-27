import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import {
  LOCAL_OPERATOR_ID,
  enqueueJob,
  failOrphanedJobs,
  finishJob,
  getJobForUser,
  getProjectForUser,
  isDatabaseReachable,
  listProjectsForUser,
  markJobRunning,
  updateJobLogs,
} from "./tenant.js";

/**
 * Tenant isolation is a property of the *query*, not of the caller.
 *
 * These tests assert that every read carries a `userId` filter. That is a
 * stronger guarantee than checking the returned rows, because a fetch-then-
 * filter would pass a returned-rows test while still pulling another tenant's
 * data across the wire — and would leak existence through the difference
 * between "not found" and "not yours".
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

const OTHER_USER = "someone-else";

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "prj_1",
    name: "Site",
    slug: "site",
    description: null,
    locale: "de",
    siteUrl: "https://www.example.de",
    templateId: "default",
    contentProfileId: "default",
    userId: LOCAL_OPERATOR_ID,
    workspaceId: "ws_1",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    workspace: { name: "Workspace" },
    business: { name: "Business" },
    services: [],
    locations: [],
    generatedPages: [],
    jobs: [],
    _count: { services: 2, locations: 3, generatedPages: 6 },
    ...overrides,
  };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    kind: "BUILD",
    status: "PENDING",
    logs: "",
    exitCode: null,
    projectId: "prj_1",
    userId: LOCAL_OPERATOR_ID,
    createdAt: new Date("2026-01-01T10:00:00Z"),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scoping
// ---------------------------------------------------------------------------

describe("listProjectsForUser", () => {
  test("filters on the owning user", async () => {
    prisma.project.findMany.mockResolvedValue([] as never);

    await listProjectsForUser(LOCAL_OPERATOR_ID, prisma);

    expect(prisma.project.findMany.mock.calls[0]?.[0]?.where).toEqual({
      userId: LOCAL_OPERATOR_ID,
    });
  });

  test("never queries without a scope", async () => {
    prisma.project.findMany.mockResolvedValue([] as never);

    await listProjectsForUser(OTHER_USER, prisma);

    const where = prisma.project.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toBeDefined();
    expect((where as { userId?: string }).userId).toBe(OTHER_USER);
  });

  test("shapes rows for transport, with the expected-page grid", async () => {
    prisma.project.findMany.mockResolvedValue([projectRow()] as never);

    const [project] = await listProjectsForUser(LOCAL_OPERATOR_ID, prisma);

    expect(project).toMatchObject({
      id: "prj_1",
      siteUrl: "https://www.example.de",
      serviceCount: 2,
      locationCount: 3,
      pageCount: 6,
      // 2 × 3: the grid says six pages should exist, and six do.
      expectedPages: 6,
    });
  });

  test("carries no Date or Decimal across the boundary", async () => {
    prisma.project.findMany.mockResolvedValue([projectRow()] as never);

    const [project] = await listProjectsForUser(LOCAL_OPERATOR_ID, prisma);

    for (const value of Object.values(project ?? {})) {
      expect(value instanceof Date, "Dates cannot cross to a client component").toBe(
        false,
      );
    }
  });
});

describe("getProjectForUser", () => {
  test("scopes on both the id and the user", async () => {
    prisma.project.findFirst.mockResolvedValue(projectRow() as never);

    await getProjectForUser("prj_1", LOCAL_OPERATOR_ID, prisma);

    expect(prisma.project.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "prj_1",
      userId: LOCAL_OPERATOR_ID,
    });
  });

  test("returns null for a project owned by someone else", async () => {
    // The query itself matches nothing, so the row never leaves the database.
    prisma.project.findFirst.mockResolvedValue(null as never);

    expect(await getProjectForUser("prj_1", OTHER_USER, prisma)).toBeNull();
  });

  test("cannot be used to discover which ids exist", async () => {
    prisma.project.findFirst.mockResolvedValue(null as never);

    const missing = await getProjectForUser("no-such-project", LOCAL_OPERATOR_ID, prisma);
    const forbidden = await getProjectForUser("prj_1", OTHER_USER, prisma);

    // Indistinguishable by design.
    expect(missing).toBe(forbidden);
  });

  test("includes only the five most recent jobs", async () => {
    prisma.project.findFirst.mockResolvedValue(projectRow() as never);

    await getProjectForUser("prj_1", LOCAL_OPERATOR_ID, prisma);

    expect(prisma.project.findFirst.mock.calls[0]?.[0]?.include?.jobs).toEqual({
      orderBy: { createdAt: "desc" },
      take: 5,
    });
  });
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

describe("enqueueJob", () => {
  test("verifies ownership in the same query, not before it", async () => {
    prisma.project.findFirst.mockResolvedValue({ id: "prj_1" } as never);
    prisma.generationJob.create.mockResolvedValue(jobRow() as never);

    await enqueueJob("prj_1", LOCAL_OPERATOR_ID, "BUILD", prisma);

    expect(prisma.project.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "prj_1",
      userId: LOCAL_OPERATOR_ID,
    });
  });

  test("refuses to queue work against another tenant's project", async () => {
    prisma.project.findFirst.mockResolvedValue(null as never);

    expect(await enqueueJob("prj_1", OTHER_USER, "BUILD", prisma)).toBeNull();
    // And crucially, creates nothing.
    expect(prisma.generationJob.create).not.toHaveBeenCalled();
  });

  test("stamps the job with the owner, so reads need no join", async () => {
    prisma.project.findFirst.mockResolvedValue({ id: "prj_1" } as never);
    prisma.generationJob.create.mockResolvedValue(jobRow() as never);

    await enqueueJob("prj_1", LOCAL_OPERATOR_ID, "GENERATE", prisma);

    expect(prisma.generationJob.create.mock.calls[0]?.[0]?.data).toMatchObject({
      projectId: "prj_1",
      userId: LOCAL_OPERATOR_ID,
      kind: "GENERATE",
      status: "PENDING",
    });
  });

  test("starts a job pending and unfinished", async () => {
    prisma.project.findFirst.mockResolvedValue({ id: "prj_1" } as never);
    prisma.generationJob.create.mockResolvedValue(jobRow() as never);

    const job = await enqueueJob("prj_1", LOCAL_OPERATOR_ID, "BUILD", prisma);

    expect(job).toMatchObject({ status: "PENDING", finished: false, exitCode: null });
  });
});

describe("getJobForUser", () => {
  test("scopes on the user, not only the job id", async () => {
    prisma.generationJob.findFirst.mockResolvedValue(jobRow() as never);

    await getJobForUser("job_1", LOCAL_OPERATOR_ID, prisma);

    expect(prisma.generationJob.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "job_1",
      userId: LOCAL_OPERATOR_ID,
    });
  });

  test("hides another tenant's job entirely", async () => {
    prisma.generationJob.findFirst.mockResolvedValue(null as never);

    expect(await getJobForUser("job_1", OTHER_USER, prisma)).toBeNull();
  });

  test("reports a completed job as finished", async () => {
    prisma.generationJob.findFirst.mockResolvedValue(
      jobRow({
        status: "COMPLETED",
        exitCode: 0,
        completedAt: new Date("2026-01-01T10:01:00Z"),
      }) as never,
    );

    expect(await getJobForUser("job_1", LOCAL_OPERATOR_ID, prisma)).toMatchObject({
      status: "COMPLETED",
      finished: true,
      exitCode: 0,
    });
  });

  test("reports a failed job as finished too", async () => {
    prisma.generationJob.findFirst.mockResolvedValue(
      jobRow({ status: "FAILED", exitCode: 1 }) as never,
    );

    // A poller must stop on either outcome, not only on success.
    expect((await getJobForUser("job_1", LOCAL_OPERATOR_ID, prisma))?.finished).toBe(
      true,
    );
  });

  test("serialises every timestamp", async () => {
    prisma.generationJob.findFirst.mockResolvedValue(
      jobRow({ startedAt: new Date("2026-01-01T10:00:30Z") }) as never,
    );

    const job = await getJobForUser("job_1", LOCAL_OPERATOR_ID, prisma);

    expect(job?.createdAt).toBe("2026-01-01T10:00:00.000Z");
    expect(job?.startedAt).toBe("2026-01-01T10:00:30.000Z");
    expect(job?.completedAt).toBeNull();
  });
});

describe("job lifecycle writes", () => {
  test("markJobRunning records when it started", async () => {
    prisma.generationJob.update.mockResolvedValue(jobRow() as never);

    await markJobRunning("job_1", prisma);

    const data = prisma.generationJob.update.mock.calls[0]?.[0]?.data as {
      status?: string;
      startedAt?: Date;
    };
    expect(data.status).toBe("RUNNING");
    expect(data.startedAt).toBeInstanceOf(Date);
  });

  test("updateJobLogs replaces rather than appends", async () => {
    prisma.generationJob.update.mockResolvedValue(jobRow() as never);

    await updateJobLogs("job_1", "partial output", prisma);

    // The caller owns and trims the buffer; a database-side append would grow
    // without bound on a job that prints megabytes.
    expect(prisma.generationJob.update.mock.calls[0]?.[0]?.data).toEqual({
      logs: "partial output",
    });
  });

  test("finishJob completes on success", async () => {
    prisma.generationJob.update.mockResolvedValue(jobRow() as never);

    await finishJob("job_1", { ok: true, exitCode: 0, logs: "done" }, prisma);

    expect(prisma.generationJob.update.mock.calls[0]?.[0]?.data).toMatchObject({
      status: "COMPLETED",
      exitCode: 0,
      logs: "done",
    });
  });

  test("finishJob fails on a non-zero exit", async () => {
    prisma.generationJob.update.mockResolvedValue(jobRow() as never);

    await finishJob("job_1", { ok: false, exitCode: 1, logs: "boom" }, prisma);

    expect(prisma.generationJob.update.mock.calls[0]?.[0]?.data).toMatchObject({
      status: "FAILED",
      exitCode: 1,
    });
  });
});

describe("failOrphanedJobs", () => {
  test("fails anything left pending or running", async () => {
    prisma.generationJob.updateMany.mockResolvedValue({ count: 2 } as never);

    const failed = await failOrphanedJobs(prisma);

    // A job row outlives the process updating it; without this, a dev-server
    // restart mid-build leaves a job spinning and a poller waiting forever.
    expect(prisma.generationJob.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      status: { in: ["PENDING", "RUNNING"] },
    });
    expect(failed).toBe(2);
  });

  test("does not touch finished jobs", async () => {
    prisma.generationJob.updateMany.mockResolvedValue({ count: 0 } as never);

    await failOrphanedJobs(prisma);

    const where = prisma.generationJob.updateMany.mock.calls[0]?.[0]?.where as {
      status?: { in?: string[] };
    };
    expect(where.status?.in).not.toContain("COMPLETED");
    expect(where.status?.in).not.toContain("FAILED");
  });
});

describe("isDatabaseReachable", () => {
  test("is true when a query answers", async () => {
    prisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }] as never);

    expect(await isDatabaseReachable(prisma)).toBe(true);
  });

  test("is false rather than throwing when it does not", async () => {
    prisma.$queryRaw.mockRejectedValue(new Error("ECONNREFUSED") as never);

    // An unreachable database is an ordinary state, not an exception: the
    // engine runs entirely from local files too.
    expect(await isDatabaseReachable(prisma)).toBe(false);
  });
});

describe("LOCAL_OPERATOR_ID", () => {
  test("matches the column default, so existing rows are reachable", () => {
    // The Prisma default was chosen to equal this constant; a mismatch would
    // make every seeded project invisible to the dashboard.
    expect(LOCAL_OPERATOR_ID).toBe("local-operator");
  });
});
