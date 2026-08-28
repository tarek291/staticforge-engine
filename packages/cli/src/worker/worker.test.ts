import { describe, expect, test, vi } from "vitest";

import { createHookBus, registerPlugins } from "@staticforge/core";

import {
  runWorkerOnce,
  startWorker,
  type ClaimedJobLike,
  type WorkerDeps,
  type WorkerOptions,
} from "./worker.js";
import type { EngineResult } from "./run-engine.js";

/**
 * The worker loop, against fakes.
 *
 * Everything here is about the moments a worker is *not* healthy: it is asked
 * to stop mid-run, it loses its claim because its lease lapsed, the engine
 * fails, the queue is empty. The happy path is one test; the rest is what makes
 * the thing safe to restart at any moment, which is the only reason it was
 * split out of the web server in the first place.
 */

const OPTIONS: WorkerOptions = {
  repoRoot: "/repo",
  instanceId: "w1",
  heartbeatMs: 10_000,
  logFlushMs: 10_000,
  idleMs: 1,
};

/** A job as the claim returns it. */
function job(over: Partial<ClaimedJobLike> = {}): ClaimedJobLike {
  return {
    id: "job_1",
    projectId: "prj_1",
    userId: "local-operator",
    kind: "GENERATE",
    locale: "de",
    targetSlug: null,
    feedback: null,
    completedCount: 0,
    resumed: false,
    ...over,
  };
}

/** A finished engine run. */
function engineResult(over: Partial<EngineResult> = {}): EngineResult {
  return { ok: true, exitCode: 0, output: "done", durationMs: 1234, ...over };
}

/** Build deps whose every call is observable. */
function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    claimNextJob: vi.fn().mockResolvedValue(null),
    renewJobLease: vi.fn().mockResolvedValue(true),
    updateJobLogs: vi.fn().mockResolvedValue(true),
    finishJob: vi.fn().mockResolvedValue(true),
    countExpectedPages: vi.fn().mockResolvedValue(9),
    runEngine: vi.fn().mockResolvedValue(engineResult()),
    ...over,
  } as WorkerDeps;
}

describe("runWorkerOnce", () => {
  test("does nothing when the queue is empty", async () => {
    const d = deps();

    await expect(runWorkerOnce(d, OPTIONS)).resolves.toEqual({ jobId: null });
    expect(d.runEngine).not.toHaveBeenCalled();
    expect(d.finishJob).not.toHaveBeenCalled();
  });

  test("claims a job, runs it, and records the verdict", async () => {
    const d = deps({ claimNextJob: vi.fn().mockResolvedValue(job()) });

    const tick = await runWorkerOnce(d, OPTIONS);

    expect(tick).toEqual({ jobId: "job_1", ok: true, resumed: false });
    expect(d.finishJob).toHaveBeenCalledWith(
      "job_1",
      { ok: true, exitCode: 0, logs: "done" },
      "local-operator",
    );
  });

  test("records a failure as a verdict rather than throwing", async () => {
    const d = deps({
      claimNextJob: vi.fn().mockResolvedValue(job()),
      runEngine: vi.fn().mockResolvedValue(engineResult({ ok: false, exitCode: 1 })),
    });

    const tick = await runWorkerOnce(d, OPTIONS);

    // The loop around this has to keep going; a failed build is not an
    // exception to propagate out of a daemon.
    expect(tick.ok).toBe(false);
    expect(d.finishJob).toHaveBeenCalledWith(
      "job_1",
      expect.objectContaining({ ok: false, exitCode: 1 }),
      "local-operator",
    );
  });

  test("a worker bug is still recorded on the job", async () => {
    const d = deps({
      claimNextJob: vi.fn().mockResolvedValue(job()),
      runEngine: vi.fn().mockRejectedValue(new Error("worker bug")),
    });

    await runWorkerOnce(d, OPTIONS);

    // Nothing else is listening. A job left RUNNING because the worker threw
    // would sit until its lease lapsed for no reason.
    expect(d.finishJob).toHaveBeenCalledWith(
      "job_1",
      expect.objectContaining({ ok: false, exitCode: -1 }),
      "local-operator",
    );
  });

  test("hands the engine everything the run needs, and nothing it should invent", async () => {
    const d = deps({
      claimNextJob: vi.fn().mockResolvedValue(
        job({ kind: "REFRESH", targetSlug: "a-page", feedback: "Add pricing." }),
      ),
    });

    await runWorkerOnce(d, OPTIONS);

    expect(d.runEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        kind: "REFRESH",
        projectId: "prj_1",
        userId: "local-operator",
        locale: "de",
        jobId: "job_1",
        pageCount: 9,
        target: { slug: "a-page", feedback: "Add pricing." },
      }),
    );
  });

  test("a project it cannot measure gets the base timeout, not an unbounded one", async () => {
    const d = deps({
      claimNextJob: vi.fn().mockResolvedValue(job()),
      countExpectedPages: vi.fn().mockResolvedValue(null),
    });

    await runWorkerOnce(d, OPTIONS);

    expect(d.runEngine).toHaveBeenCalledWith(
      expect.objectContaining({ pageCount: 0 }),
    );
  });

  test("reports a reclaimed job as resumed", async () => {
    const d = deps({
      claimNextJob: vi
        .fn()
        .mockResolvedValue(job({ resumed: true, completedCount: 400 })),
    });

    const tick = await runWorkerOnce(d, OPTIONS);

    expect(tick.resumed).toBe(true);
  });
});

describe("a worker that lost its claim stands down", () => {
  test("does not write a verdict over the job another worker took", async () => {
    // The lease lapsed mid-run — the machine was paused, the database was
    // briefly unreachable — and another worker reclaimed the job. Writing
    // COMPLETED here would overwrite a run this worker did not perform.
    let renew: (() => void) | undefined;

    const d = deps({
      claimNextJob: vi.fn().mockResolvedValue(job()),
      renewJobLease: vi.fn().mockResolvedValue(false),
      runEngine: vi.fn().mockImplementation(
        () =>
          new Promise<EngineResult>((resolve) => {
            renew = () => {
              resolve(engineResult());
            };
          }),
      ),
    });

    const running = runWorkerOnce(d, { ...OPTIONS, heartbeatMs: 1 });

    // Let the heartbeat fire and observe the lost claim, then let the run end.
    await new Promise((resolve) => setTimeout(resolve, 20));
    renew?.();
    await running;

    expect(d.renewJobLease).toHaveBeenCalled();
    expect(d.finishJob).not.toHaveBeenCalled();
  });

  test("holding the claim throughout does write the verdict", async () => {
    const d = deps({ claimNextJob: vi.fn().mockResolvedValue(job()) });

    await runWorkerOnce(d, { ...OPTIONS, heartbeatMs: 1 });

    expect(d.finishJob).toHaveBeenCalledTimes(1);
  });
});

describe("startWorker", () => {
  test("drains the queue without pausing between jobs", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce(job({ id: "job_1" }))
      .mockResolvedValueOnce(job({ id: "job_2" }))
      .mockResolvedValue(null);

    const waits: number[] = [];
    const d = deps({ claimNextJob: claim });

    const handle = startWorker(d, OPTIONS, (ms) => {
      waits.push(ms);
      handle.stop();
      return Promise.resolve();
    });

    await handle.done;

    // Two jobs back to back, then one wait once there was nothing left.
    expect(d.finishJob).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([1]);
  });

  test("waits when the queue is empty rather than spinning", async () => {
    const d = deps();
    let slept = 0;

    const handle = startWorker(d, OPTIONS, () => {
      slept += 1;
      if (slept >= 3) handle.stop();
      return Promise.resolve();
    });

    await handle.done;

    expect(slept).toBe(3);
  });

  test("stopping finishes the job in hand rather than abandoning it", async () => {
    let release: (() => void) | undefined;

    const d = deps({
      claimNextJob: vi.fn().mockResolvedValueOnce(job()).mockResolvedValue(null),
      runEngine: vi.fn().mockImplementation(
        () =>
          new Promise<EngineResult>((resolve) => {
            release = () => {
              resolve(engineResult());
            };
          }),
      ),
    });

    const handle = startWorker(d, OPTIONS, () => Promise.resolve());

    // Ask it to stop while the engine is still running.
    await new Promise((resolve) => setTimeout(resolve, 10));
    handle.stop();
    release?.();
    await handle.done;

    // Dropping the job would leave a lease to lapse and another worker to redo
    // the tail of it — the exact waste the lease exists to prevent.
    expect(d.finishJob).toHaveBeenCalledTimes(1);
  });

  test("stops claiming new work once asked to stop", async () => {
    const claim = vi.fn().mockResolvedValue(job());
    const d = deps({ claimNextJob: claim });

    const handle = startWorker(d, OPTIONS, () => Promise.resolve());
    handle.stop();
    await handle.done;

    // At most the one job it had already begun.
    expect(claim.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("a plugin cannot break the run it is observing", () => {
  test("the lifecycle event reaches a listener with the job's own data", async () => {
    const seen: unknown[] = [];
    const hooks = createHookBus();
    hooks.on("afterJobCompleted", (payload) => {
      seen.push(payload);
    });

    const d = deps({
      claimNextJob: vi.fn().mockResolvedValue(job({ resumed: true })),
    });

    await runWorkerOnce(d, { ...OPTIONS, hooks });

    expect(seen[0]).toMatchObject({
      jobId: "job_1",
      projectId: "prj_1",
      userId: "local-operator",
      kind: "GENERATE",
      ok: true,
      exitCode: 0,
      resumed: true,
    });
  });

  test("a throwing plugin does not fail the job", async () => {
    // The whole point of the isolation. A plugin is third-party code inside a
    // paid, hour-long build; if it can abort one, installing it is a risk
    // nobody should take.
    const hooks = createHookBus();
    hooks.on("afterJobCompleted", () => {
      throw new Error("audit endpoint is down");
    }, "flaky-plugin");

    const d = deps({ claimNextJob: vi.fn().mockResolvedValue(job()) });

    const tick = await runWorkerOnce(d, { ...OPTIONS, hooks });

    expect(tick).toEqual({ jobId: "job_1", ok: true, resumed: false });
    expect(d.finishJob).toHaveBeenCalledTimes(1);
  });

  test("a hanging plugin does not hold the worker open", async () => {
    const hooks = createHookBus({ listenerTimeoutMs: 20 });
    hooks.on("afterJobCompleted", () => new Promise<void>(() => {}));

    const d = deps({ claimNextJob: vi.fn().mockResolvedValue(job()) });

    const tick = await runWorkerOnce(d, { ...OPTIONS, hooks });

    expect(tick.ok).toBe(true);
  });

  test("the plugin is told only after the verdict is durable", async () => {
    const order: string[] = [];
    const hooks = createHookBus();
    hooks.on("afterJobCompleted", () => {
      order.push("plugin");
    });

    const d = deps({
      claimNextJob: vi.fn().mockResolvedValue(job()),
      finishJob: vi.fn().mockImplementation(() => {
        order.push("finishJob");
        return Promise.resolve(true);
      }),
    });

    await runWorkerOnce(d, { ...OPTIONS, hooks });

    // A plugin told a job succeeded must be able to rely on that being true
    // even if the worker dies in the next instant.
    expect(order).toEqual(["finishJob", "plugin"]);
  });

  test("a worker that lost its claim announces nothing", async () => {
    const hooks = createHookBus();
    const heard = vi.fn();
    hooks.on("afterJobCompleted", heard);

    let release: (() => void) | undefined;
    const d = deps({
      claimNextJob: vi.fn().mockResolvedValue(job()),
      renewJobLease: vi.fn().mockResolvedValue(false),
      runEngine: vi.fn().mockImplementation(
        () =>
          new Promise<EngineResult>((resolve) => {
            release = () => {
              resolve(engineResult());
            };
          }),
      ),
    });

    const running = runWorkerOnce(d, { ...OPTIONS, heartbeatMs: 1, hooks });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.();
    await running;

    // The job belongs to another worker now. Announcing a completion this
    // worker did not record would put a lie into an audit trail.
    expect(heard).not.toHaveBeenCalled();
  });

  test("a plugin whose setup throws leaves the worker able to run", async () => {
    const { hooks, failed } = registerPlugins([
      {
        name: "broken",
        setup() {
          throw new Error("bad config");
        },
      },
    ]);

    const d = deps({ claimNextJob: vi.fn().mockResolvedValue(job()) });

    const tick = await runWorkerOnce(d, { ...OPTIONS, hooks });

    expect(failed[0]?.plugin).toBe("broken");
    expect(tick.ok).toBe(true);
  });
});
