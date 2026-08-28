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
  countExpectedPages,
  saveRefreshedPage,
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
    prisma.project.findFirst.mockResolvedValue({
      id: "prj_1",
      organizationId: "org-1",
    } as never);
    // Phase 23: enqueuing is a write and is gated on `project:write`.
    prisma.organizationMember.findUnique.mockResolvedValue({
      role: "EDITOR",
    } as never);
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
    prisma.project.findFirst.mockResolvedValue({
      id: "prj_1",
      organizationId: "org-1",
    } as never);
    // Phase 23: enqueuing is a write and is gated on `project:write`.
    prisma.organizationMember.findUnique.mockResolvedValue({
      role: "EDITOR",
    } as never);
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
    prisma.project.findFirst.mockResolvedValue({
      id: "prj_1",
      organizationId: "org-1",
    } as never);
    // Phase 23: enqueuing is a write and is gated on `project:write`.
    prisma.organizationMember.findUnique.mockResolvedValue({
      role: "EDITOR",
    } as never);
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
  /** Arm the scoped write and report how many rows it claims to have hit. */
  function armWrite(count = 1): void {
    prisma.generationJob.updateMany.mockResolvedValue({ count } as never);
  }

  /** The `where` the write was built with. */
  function writeWhere(): Record<string, unknown> {
    return prisma.generationJob.updateMany.mock.calls[0]?.[0]?.where as Record<
      string,
      unknown
    >;
  }

  /** The `data` the write was built with. */
  function writeData(): Record<string, unknown> {
    return prisma.generationJob.updateMany.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
  }

  test("markJobRunning records when it started", async () => {
    armWrite();

    await markJobRunning("job_1", "local-operator", prisma);

    expect(writeData().status).toBe("RUNNING");
    expect(writeData().startedAt).toBeInstanceOf(Date);
  });

  test("markJobRunning claims the job for the instance running it", async () => {
    armWrite();

    const before = Date.now();
    await markJobRunning("job_1", "local-operator", prisma, {
      instanceId: "web-1",
      leaseMs: 60_000,
    });

    const data = writeData() as { lockedBy?: string; leaseExpiresAt?: Date };

    // Without a claim, "RUNNING" says only that some process once said so,
    // which is indistinguishable from a process that has since died.
    expect(data.lockedBy).toBe("web-1");
    expect(data.leaseExpiresAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
      before + 60_000,
    );
  });

  test("updateJobLogs replaces rather than appends", async () => {
    armWrite();

    await updateJobLogs("job_1", "partial output", "local-operator", prisma);

    // The caller owns and trims the buffer; a database-side append would grow
    // without bound on a job that prints megabytes.
    expect(writeData()).toEqual({ logs: "partial output" });
  });

  test("updateJobLogs renews the claim on the same write", async () => {
    armWrite();

    await updateJobLogs("job_1", "partial", "local-operator", prisma, {
      instanceId: "web-1",
    });

    const data = writeData() as { logs?: string; leaseExpiresAt?: Date };

    // The flush is the heartbeat. A second periodic write would double the cost
    // of the noisiest query in the system to say what this one already proves.
    expect(data.logs).toBe("partial");
    expect(data.leaseExpiresAt).toBeInstanceOf(Date);
  });

  test("finishJob completes on success", async () => {
    armWrite();

    await finishJob(
      "job_1",
      { ok: true, exitCode: 0, logs: "done" },
      "local-operator",
      prisma,
    );

    expect(writeData()).toMatchObject({
      status: "COMPLETED",
      exitCode: 0,
      logs: "done",
    });
  });

  test("finishJob fails on a non-zero exit", async () => {
    armWrite();

    await finishJob(
      "job_1",
      { ok: false, exitCode: 1, logs: "boom" },
      "local-operator",
      prisma,
    );

    expect(writeData()).toMatchObject({ status: "FAILED", exitCode: 1 });
  });

  test("finishJob releases the claim", async () => {
    armWrite();

    await finishJob(
      "job_1",
      { ok: true, exitCode: 0, logs: "done" },
      "local-operator",
      prisma,
    );

    expect(writeData()).toMatchObject({ lockedBy: null, leaseExpiresAt: null });
  });

  test("every lifecycle write is scoped to the job's owner", async () => {
    // An id is not a capability: it appears in a URL, a log line and a poller's
    // request. Knowing it must not mean being able to overwrite the logs or
    // mark the job failed.
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["markJobRunning", () => markJobRunning("job_1", "user_a", prisma)],
      ["updateJobLogs", () => updateJobLogs("job_1", "x", "user_a", prisma)],
      [
        "finishJob",
        () =>
          finishJob("job_1", { ok: true, exitCode: 0, logs: "" }, "user_a", prisma),
      ],
    ];

    for (const [name, write] of writes) {
      prisma.generationJob.updateMany.mockClear();
      armWrite();

      await write();

      expect(writeWhere(), `${name} is not scoped`).toEqual({
        id: "job_1",
        userId: "user_a",
      });
    }
  });

  test("a write that matches nothing reports it rather than claiming success", async () => {
    // "Not yours" and "already gone" both land here, and a caller that cannot
    // tell them from success would carry on against a job it does not hold.
    armWrite(0);

    await expect(markJobRunning("job_1", "user_other", prisma)).resolves.toBe(
      false,
    );
  });

  test("uses updateMany so the owner can be part of the condition", async () => {
    armWrite();

    await markJobRunning("job_1", "local-operator", prisma);

    // `update` wants a unique `where`, and an id is unique — which is the
    // problem: the scope would have to become a check on the result, which is
    // the pattern this module exists to avoid.
    expect(prisma.generationJob.update).not.toHaveBeenCalled();
    expect(prisma.generationJob.updateMany).toHaveBeenCalledTimes(1);
  });
});


describe("failOrphanedJobs", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");

  /** The `where` the recovery scan was built with. */
  function recoveryWhere(): {
    status?: { in?: string[] };
    OR?: Array<Record<string, unknown>>;
  } {
    return prisma.generationJob.updateMany.mock.calls[0]?.[0]?.where as {
      status?: { in?: string[] };
      OR?: Array<Record<string, unknown>>;
    };
  }

  test("closes out abandoned work and reports how much", async () => {
    prisma.generationJob.updateMany.mockResolvedValue({ count: 2 } as never);

    const failed = await failOrphanedJobs(prisma, { instanceId: "web-1", now });

    expect(recoveryWhere().status?.in).toEqual(["PENDING", "RUNNING"]);
    expect(failed).toBe(2);
  });

  test("never fails everything that merely says RUNNING", async () => {
    prisma.generationJob.updateMany.mockResolvedValue({ count: 0 } as never);

    await failOrphanedJobs(prisma, { instanceId: "web-1", now });

    // The status alone must never be the whole condition. A second instance is
    // doing real work under exactly that description, for every tenant at once,
    // and a cold start that matched on status would destroy all of it.
    const where = recoveryWhere();
    expect(where.OR).toBeDefined();
    expect(where.OR?.length).toBeGreaterThan(0);
  });

  test("reclaims this instance's own leftovers, and lapsed claims", async () => {
    prisma.generationJob.updateMany.mockResolvedValue({ count: 0 } as never);

    await failOrphanedJobs(prisma, {
      instanceId: "web-1",
      now,
      pendingGraceMs: 300_000,
    });

    const or = recoveryWhere().OR ?? [];

    // Booting, so nothing this instance still holds survived.
    expect(or).toContainEqual({ lockedBy: "web-1" });
    // A claim nobody renewed, whatever became of its owner.
    expect(or).toContainEqual({ leaseExpiresAt: { lt: now } });
    // Never claimed at all, and old enough that nothing is going to.
    expect(or).toContainEqual({
      leaseExpiresAt: null,
      createdAt: { lt: new Date(now.getTime() - 300_000) },
    });
  });

  test("leaves a job another instance is still renewing alone", async () => {
    prisma.generationJob.updateMany.mockResolvedValue({ count: 0 } as never);

    await failOrphanedJobs(prisma, { instanceId: "web-1", now });

    const or = recoveryWhere().OR ?? [];

    // A live job on web-2 matches none of the three: its lockedBy is not ours,
    // its lease is in the future, and it is not unclaimed.
    expect(or).not.toContainEqual({ lockedBy: "web-2" });
    expect(or.some((clause) => "leaseExpiresAt" in clause)).toBe(true);
  });

  test("without an instance id, only lapsed claims are reclaimed", async () => {
    prisma.generationJob.updateMany.mockResolvedValue({ count: 0 } as never);

    await failOrphanedJobs(prisma, { now });

    const or = recoveryWhere().OR ?? [];
    expect(or.some((clause) => "lockedBy" in clause)).toBe(false);
    expect(or).toContainEqual({ leaseExpiresAt: { lt: now } });
  });

  test("does not touch finished jobs", async () => {
    prisma.generationJob.updateMany.mockResolvedValue({ count: 0 } as never);

    await failOrphanedJobs(prisma);

    const where = recoveryWhere();
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

describe("saveRefreshedPage", () => {
  const page = {
    slug: "bueroreinigung-duisburg",
    title: "T",
    metaDescription: "M",
    h1: "H",
    content: { hero: { heading: "x" } },
  };

  test("is scoped through the project relation", async () => {
    prisma.generatedPage.updateMany.mockResolvedValue({ count: 1 } as never);

    await saveRefreshedPage("prj_1", page, "local-operator", prisma);

    // The page is unreachable unless its project is — the same guarantee
    // getPageForUser gives on the read side, applied to the write that follows
    // it rather than assumed from it.
    expect(prisma.generatedPage.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      projectId: "prj_1",
      slug: "bueroreinigung-duisburg",
      project: { userId: "local-operator" },
    });
  });

  test("reports a miss instead of silently succeeding", async () => {
    prisma.generatedPage.updateMany.mockResolvedValue({ count: 0 } as never);

    // A refresh that writes nothing must not let the caller go on to write the
    // static file, or the output would claim a revision the database refused.
    await expect(
      saveRefreshedPage("prj_1", page, "user_other", prisma),
    ).resolves.toBe(false);
  });

  test("still writes only the fields a refresh may change", async () => {
    prisma.generatedPage.updateMany.mockResolvedValue({ count: 1 } as never);

    await saveRefreshedPage("prj_1", page, "local-operator", prisma);

    const data = prisma.generatedPage.updateMany.mock.calls[0]?.[0]
      ?.data as Record<string, unknown>;

    // A mistake upstream must not be able to move a slug or clear a link graph
    // through this path.
    expect(Object.keys(data).sort()).toEqual(
      ["content", "generation", "h1", "metaDescription", "source", "title"].sort(),
    );
    expect(data.source).toBe("MANUAL");
  });
});

describe("countExpectedPages", () => {
  test("multiplies the service x location grid the generator walks", async () => {
    prisma.project.findFirst.mockResolvedValue({
      _count: { services: 5, locations: 40 },
    } as never);

    await expect(
      countExpectedPages("prj_1", "local-operator", prisma),
    ).resolves.toBe(200);
  });

  test("is scoped, and a foreign project counts as nothing rather than zero", async () => {
    prisma.project.findFirst.mockResolvedValue(null as never);

    await expect(
      countExpectedPages("prj_1", "user_other", prisma),
    ).resolves.toBeNull();

    expect(prisma.project.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "prj_1",
      userId: "user_other",
    });
  });
});
