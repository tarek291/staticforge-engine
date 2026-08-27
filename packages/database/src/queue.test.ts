import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import {
  claimNextJob,
  computeProgress,
  renewJobLease,
  reportJobProgress,
} from "./queue.js";

/**
 * The queue's two hard properties.
 *
 * One: a claim is decided by the database, not by the gap between reading a row
 * and writing it — two workers that pick the same job must not both get it.
 *
 * Two: a job whose worker died is *reclaimed*, not failed. Phase 13 closed
 * lapsed jobs out as failures, which was right when nothing could resume them.
 * Now that a run skips pages a previous attempt wrote, failing one throws away
 * content the tenant has already paid for.
 */

let prisma: DeepMockProxy<PrismaClient>;

const NOW = new Date("2026-08-27T12:00:00.000Z");

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

/** A row as the post-claim read returns it. */
function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    projectId: "prj_1",
    userId: "local-operator",
    kind: "GENERATE",
    status: "RUNNING",
    targetSlug: null,
    feedback: null,
    completedCount: 0,
    totalCount: null,
    project: { locale: "de" },
    ...over,
  };
}

/**
 * Arm the three queries a claim makes.
 *
 * @param candidate - What the candidate scan finds, or `null` for an empty queue.
 * @param claimed - How many rows the conditional claim updated.
 */
function armClaim(
  candidate: { id: string; status: string } | null,
  claimed = 1,
  row = jobRow(),
): void {
  prisma.generationJob.findFirst
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .mockResolvedValueOnce(candidate as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .mockResolvedValueOnce(row as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.generationJob.updateMany.mockResolvedValue({ count: claimed } as any);
}

describe("claimNextJob", () => {
  test("returns null when the queue is empty", async () => {
    armClaim(null);

    await expect(
      claimNextJob(prisma, { instanceId: "w1", now: NOW }),
    ).resolves.toBeNull();

    expect(prisma.generationJob.updateMany).not.toHaveBeenCalled();
  });

  test("claims a PENDING job and stamps it with this worker", async () => {
    armClaim({ id: "job_1", status: "PENDING" });

    const job = await claimNextJob(prisma, { instanceId: "w1", now: NOW });

    expect(job?.id).toBe("job_1");

    const data = prisma.generationJob.updateMany.mock.calls[0]?.[0]?.data as {
      status?: string;
      lockedBy?: string;
      leaseExpiresAt?: Date;
    };

    expect(data.status).toBe("RUNNING");
    expect(data.lockedBy).toBe("w1");
    expect(data.leaseExpiresAt?.getTime() ?? 0).toBeGreaterThan(NOW.getTime());
  });

  test("the claim repeats the condition that made the job claimable", async () => {
    armClaim({ id: "job_1", status: "PENDING" });

    await claimNextJob(prisma, { instanceId: "w1", now: NOW });

    // This is the whole safety argument. If another worker took the row between
    // the scan and this write, its status and lease no longer satisfy the
    // condition, so this updates nothing rather than stealing the job.
    expect(prisma.generationJob.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "job_1",
      OR: [
        { status: "PENDING" },
        { status: "RUNNING", leaseExpiresAt: { lt: NOW } },
      ],
    });
  });

  test("losing the race yields null rather than a stolen job", async () => {
    armClaim({ id: "job_1", status: "PENDING" }, 0);

    await expect(
      claimNextJob(prisma, { instanceId: "w2", now: NOW }),
    ).resolves.toBeNull();
  });

  test("reclaims a RUNNING job whose lease has lapsed", async () => {
    armClaim(
      { id: "job_1", status: "RUNNING" },
      1,
      jobRow({ completedCount: 400, totalCount: 500 }),
    );

    const job = await claimNextJob(prisma, { instanceId: "w2", now: NOW });

    // The row still carries how far the dead attempt got, and that is the
    // number the resumed run starts from.
    expect(job?.resumed).toBe(true);
    expect(job?.completedCount).toBe(400);
  });

  test("a job claimed fresh is not marked as resumed", async () => {
    armClaim({ id: "job_1", status: "PENDING" });

    const job = await claimNextJob(prisma, { instanceId: "w1", now: NOW });

    expect(job?.resumed).toBe(false);
  });

  test("only lapsed leases are reclaimable, never live ones", async () => {
    armClaim({ id: "job_1", status: "PENDING" });

    await claimNextJob(prisma, { instanceId: "w1", now: NOW });

    const where = prisma.generationJob.findFirst.mock.calls[0]?.[0]?.where as {
      OR?: Array<Record<string, unknown>>;
    };

    // A worker renewing its claim keeps `leaseExpiresAt` in the future, so it
    // matches neither branch and its job is invisible to other workers.
    expect(where.OR).toEqual([
      { status: "PENDING" },
      { status: "RUNNING", leaseExpiresAt: { lt: NOW } },
    ]);
  });

  test("takes the oldest job first, so nothing is starved", async () => {
    armClaim({ id: "job_1", status: "PENDING" });

    await claimNextJob(prisma, { instanceId: "w1", now: NOW });

    expect(prisma.generationJob.findFirst.mock.calls[0]?.[0]?.orderBy).toEqual({
      createdAt: "asc",
    });
  });

  test("a job whose project vanished mid-claim yields null", async () => {
    armClaim({ id: "job_1", status: "PENDING" }, 1);
    prisma.generationJob.findFirst.mockReset();
    prisma.generationJob.findFirst
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce({ id: "job_1", status: "PENDING" } as any)
      .mockResolvedValueOnce(null as never);

    await expect(
      claimNextJob(prisma, { instanceId: "w1", now: NOW }),
    ).resolves.toBeNull();
  });
});

describe("renewJobLease", () => {
  test("only the holder may renew", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.generationJob.updateMany.mockResolvedValue({ count: 1 } as any);

    await renewJobLease("job_1", { instanceId: "w1" }, prisma, NOW);

    expect(prisma.generationJob.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "job_1",
      lockedBy: "w1",
    });
  });

  test("a worker that lost its claim is told so", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.generationJob.updateMany.mockResolvedValue({ count: 0 } as any);

    // Its lease lapsed and another worker reclaimed the job. It has to know,
    // or it will write a verdict over someone else's run.
    await expect(
      renewJobLease("job_1", { instanceId: "w1" }, prisma, NOW),
    ).resolves.toBe(false);
  });

  test("pushes the deadline past now", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.generationJob.updateMany.mockResolvedValue({ count: 1 } as any);

    await renewJobLease("job_1", { instanceId: "w1", leaseMs: 60_000 }, prisma, NOW);

    const data = prisma.generationJob.updateMany.mock.calls[0]?.[0]?.data as {
      leaseExpiresAt?: Date;
    };

    expect(data.leaseExpiresAt?.getTime()).toBe(NOW.getTime() + 60_000);
  });
});

describe("computeProgress", () => {
  test("is the share of pages accounted for", () => {
    expect(computeProgress(45, 0, 500)).toBe(9);
    expect(computeProgress(250, 0, 500)).toBe(50);
    expect(computeProgress(500, 0, 500)).toBe(100);
  });

  test("counts failures as accounted for, not as progress lost", () => {
    // A run that could not produce a page has still finished with it. Leaving
    // failures out would make a run that ends with errors sit below 100 forever.
    expect(computeProgress(48, 2, 50)).toBe(100);
  });

  test("reports nothing before the total is known", () => {
    // A queued job cannot honestly claim a percentage, and dividing by a total
    // it does not have would produce one anyway.
    expect(computeProgress(0, 0, null)).toBe(0);
    expect(computeProgress(10, 0, undefined)).toBe(0);
    expect(computeProgress(10, 0, 0)).toBe(0);
  });

  test("never overruns, and never rounds up to done", () => {
    expect(computeProgress(600, 0, 500)).toBe(100);
    expect(computeProgress(-5, 0, 500)).toBe(0);
    // 499/500 floors to 99: a bar must not read 100 before the run has finished.
    expect(computeProgress(499, 0, 500)).toBe(99);
  });
});

describe("reportJobProgress", () => {
  /** Arm the read-then-write the report performs. */
  function armReport(current: Record<string, unknown>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.generationJob.findFirst.mockResolvedValue(current as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.generationJob.updateMany.mockResolvedValue({ count: 1 } as any);
  }

  test("derives the percentage rather than trusting the caller", async () => {
    armReport({ totalCount: 500, completedCount: 0, failedCount: 0 });

    await reportJobProgress(
      "job_1",
      { completedCount: 45 },
      "local-operator",
      prisma,
    );

    // A bar reading 80% beside "12/500" is worse than no bar at all, so the two
    // are computed from one place.
    expect(prisma.generationJob.updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      completedCount: 45,
      totalCount: 500,
      progress: 9,
    });
  });

  test("records the total the first time a run knows it", async () => {
    armReport({ totalCount: null, completedCount: 0, failedCount: 0 });

    await reportJobProgress(
      "job_1",
      { totalCount: 500, completedCount: 0 },
      "local-operator",
      prisma,
    );

    expect(prisma.generationJob.updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      totalCount: 500,
      progress: 0,
    });
  });

  test("leaves counts the report did not mention alone", async () => {
    armReport({ totalCount: 500, completedCount: 40, failedCount: 3 });

    await reportJobProgress("job_1", { completedCount: 45 }, "local-operator", prisma);

    expect(prisma.generationJob.updateMany.mock.calls[0]?.[0]?.data).toMatchObject({
      completedCount: 45,
      failedCount: 3,
    });
  });

  test("is scoped to the job's owner", async () => {
    armReport({ totalCount: 10, completedCount: 0, failedCount: 0 });

    await reportJobProgress("job_1", { completedCount: 1 }, "user_a", prisma);

    expect(prisma.generationJob.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      id: "job_1",
      userId: "user_a",
    });
  });

  test("a job that is not the caller's reports a miss, and writes nothing", async () => {
    prisma.generationJob.findFirst.mockResolvedValue(null as never);

    await expect(
      reportJobProgress("job_1", { completedCount: 1 }, "user_other", prisma),
    ).resolves.toBe(false);

    expect(prisma.generationJob.updateMany).not.toHaveBeenCalled();
  });
});
