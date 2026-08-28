import { describe, expect, test, vi } from "vitest";

import { createHookBus, type HookBus } from "./hooks.js";
import { registerPlugins, type StaticForgePlugin } from "./plugin.js";
import { createAuditLoggerPlugin } from "./audit-logger.js";

/**
 * A plugin is third-party code running inside a paid, hour-long build.
 *
 * If it can abort that build, installing one is a risk nobody should take. So
 * the tests that matter here are the ones where a plugin misbehaves — throws,
 * rejects, hangs, mutates what it was given, or fails to install at all — and
 * the engine carries on regardless.
 */

/** A representative payload. */
const JOB_EVENT = {
  jobId: "job_1",
  projectId: "prj_1",
  userId: "local-operator",
  kind: "GENERATE",
  ok: true,
  exitCode: 0,
  resumed: false,
  durationMs: 1234,
  completedAt: "2026-08-27T12:00:00.000Z",
} as const;

describe("a listener receives what it was told about", () => {
  test("delivers the payload to a registered listener", async () => {
    const seen: unknown[] = [];
    const bus = createHookBus();

    bus.on("afterJobCompleted", (payload) => {
      seen.push(payload);
    });

    const result = await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(result.delivered).toBe(1);
    expect(seen[0]).toMatchObject({ jobId: "job_1", ok: true, durationMs: 1234 });
  });

  test("delivers to every listener, in registration order", async () => {
    const order: string[] = [];
    const bus = createHookBus();

    bus.on("afterJobCompleted", () => {
      order.push("first");
    });
    bus.on("afterJobCompleted", () => {
      order.push("second");
    });

    await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(order).toEqual(["first", "second"]);
  });

  test("awaits an async listener before moving on", async () => {
    const order: string[] = [];
    const bus = createHookBus();

    bus.on("afterJobCompleted", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("slow");
    });
    bus.on("afterJobCompleted", () => {
      order.push("fast");
    });

    await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    // Sequential on purpose: parallel listeners would interleave their output
    // and make one plugin's cost depend on what else is installed.
    expect(order).toEqual(["slow", "fast"]);
  });

  test("a hook with no listeners is not an error", async () => {
    const bus = createHookBus();

    await expect(bus.emit("afterProjectSync", {
      projectId: "prj_1",
      userId: "u",
      changed: false,
      jobId: null,
      servicesAdded: 0,
      servicesUpdated: 0,
      servicesRemoved: 0,
      locationsAdded: 0,
      locationsUpdated: 0,
      locationsRemoved: 0,
      syncedAt: "2026-08-27T12:00:00.000Z",
    })).resolves.toMatchObject({ delivered: 0, failures: [] });
  });

  test("listeners are only called for their own hook", async () => {
    const job = vi.fn();
    const bus = createHookBus();

    bus.on("afterJobCompleted", job);
    await bus.emit("beforePagesWritten", {
      projectId: null,
      outputDir: "/out",
      locale: "de",
      pageCount: 2,
      slugs: ["a", "b"],
    });

    expect(job).not.toHaveBeenCalled();
  });
});

describe("a misbehaving listener cannot stop the engine", () => {
  test("a throwing listener is absorbed", async () => {
    const bus = createHookBus();

    bus.on("afterJobCompleted", () => {
      throw new Error("plugin exploded");
    }, "bad-plugin");

    const result = await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.plugin).toBe("bad-plugin");
    expect(result.failures[0]?.reason).toBe("threw");
  });

  test("a rejecting listener is absorbed the same way", async () => {
    const bus = createHookBus();

    bus.on("afterJobCompleted", () => Promise.reject(new Error("async boom")));

    const result = await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(result.failures[0]?.reason).toBe("threw");
  });

  test("a listener that hangs is abandoned rather than waited on", async () => {
    // A hang stops the engine as effectively as an exception, and far more
    // quietly — there is nothing in a log to explain why a build never ended.
    const bus = createHookBus({ listenerTimeoutMs: 20 });

    bus.on("afterJobCompleted", () => new Promise<void>(() => {}), "hanging-plugin");

    const result = await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(result.failures[0]?.reason).toBe("timed-out");
    expect(result.failures[0]?.plugin).toBe("hanging-plugin");
  });

  test("one bad listener does not prevent the others from running", async () => {
    const after = vi.fn();
    const bus = createHookBus();

    bus.on("afterJobCompleted", () => {
      throw new Error("boom");
    });
    bus.on("afterJobCompleted", after);

    const result = await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(after).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(1);
    expect(result.failures).toHaveLength(1);
  });

  test("emit itself never rejects, whatever the listeners do", async () => {
    const bus = createHookBus({ listenerTimeoutMs: 20 });

    bus.on("afterJobCompleted", () => {
      throw new Error("sync");
    });
    bus.on("afterJobCompleted", () => Promise.reject(new Error("async")));
    bus.on("afterJobCompleted", () => new Promise<void>(() => {}));

    await expect(bus.emit("afterJobCompleted", { ...JOB_EVENT })).resolves.toBeDefined();
  });

  test("the failure carries the real error, not a placeholder", async () => {
    const bus = createHookBus();
    const cause = new Error("credentials rejected by the audit endpoint");

    bus.on("afterJobCompleted", () => {
      throw cause;
    });

    const result = await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    // "A plugin failed" is not something an operator can act on.
    expect(result.failures[0]?.error).toBe(cause);
  });

  test("failures are reported to the sink as they happen", async () => {
    const onFailure = vi.fn();
    const bus = createHookBus({ onFailure });

    bus.on("afterJobCompleted", () => {
      throw new Error("boom");
    }, "noisy");

    await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ plugin: "noisy" });
  });

  test("a reporter that throws does not become the failure", async () => {
    const bus = createHookBus({
      onFailure: () => {
        throw new Error("the reporter is broken too");
      },
    });

    bus.on("afterJobCompleted", () => {
      throw new Error("boom");
    });

    await expect(bus.emit("afterJobCompleted", { ...JOB_EVENT })).resolves.toBeDefined();
  });
});

describe("a listener cannot alter what it was given", () => {
  test("a listener that tries to rewrite the payload fails instead", async () => {
    const bus = createHookBus();
    let observed: unknown;

    bus.on("afterJobCompleted", (payload) => {
      observed = payload.ok;
      // A plugin that could rewrite `ok` would be rewriting an audit trail.
      // These modules are strict, so assigning to a frozen field throws rather
      // than failing silently — the plugin is told, and so is the operator.
      (payload as unknown as { ok: boolean }).ok = false;
    }, "revisionist");

    const result = await bus.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(observed).toBe(true);
    expect(result.failures[0]?.plugin).toBe("revisionist");
    expect(result.failures[0]?.reason).toBe("threw");
  });

  test("the caller's own object is unchanged after an emit", async () => {
    const bus = createHookBus();
    const payload = { ...JOB_EVENT };

    bus.on("afterJobCompleted", (seen) => {
      try {
        (seen as unknown as { exitCode: number }).exitCode = 99;
      } catch {
        // Expected: frozen.
      }
    });

    await bus.emit("afterJobCompleted", payload);

    expect(payload.exitCode).toBe(0);
  });

  test("one listener cannot change what the next one sees", async () => {
    const bus = createHookBus();
    const seen: unknown[] = [];

    bus.on("beforePagesWritten", (payload) => {
      (payload as unknown as { pageCount: number }).pageCount = 999;
      (payload.slugs as string[]).push("injected");
    });
    bus.on("beforePagesWritten", (payload) => {
      seen.push({ count: payload.pageCount, slugs: [...payload.slugs] });
    });

    await bus.emit("beforePagesWritten", {
      projectId: null,
      outputDir: "/out",
      locale: "de",
      pageCount: 2,
      slugs: ["a", "b"],
    });

    expect(seen[0]).toEqual({ count: 2, slugs: ["a", "b"] });
  });
});

describe("registerPlugins", () => {
  /** A plugin that records what it was set up with. */
  function spyPlugin(name: string, onEvent: () => void): StaticForgePlugin {
    return {
      name,
      setup(hooks: HookBus) {
        hooks.on("afterJobCompleted", onEvent);
      },
    };
  }

  test("installs every plugin and reports which", () => {
    const { installed, failed } = registerPlugins([
      spyPlugin("one", () => {}),
      spyPlugin("two", () => {}),
    ]);

    expect(installed).toEqual(["one", "two"]);
    expect(failed).toEqual([]);
  });

  test("a plugin that fails to install is skipped, not fatal", () => {
    const good = vi.fn();

    const { installed, failed, hooks } = registerPlugins([
      {
        name: "broken",
        setup() {
          throw new Error("bad config");
        },
      },
      spyPlugin("good", good),
    ]);

    // A worker refusing to boot because one audit logger had a typo is a worse
    // outcome than a worker running without it.
    expect(installed).toEqual(["good"]);
    expect(failed[0]?.plugin).toBe("broken");
    expect(hooks.count("afterJobCompleted")).toBe(1);
  });

  test("listeners are attributed to their plugin automatically", async () => {
    const onFailure = vi.fn();
    const { hooks } = registerPlugins(
      [
        {
          name: "anonymous-wannabe",
          setup(bus) {
            bus.on("afterJobCompleted", () => {
              throw new Error("boom");
            });
          },
        },
      ],
      { onFailure },
    );

    await hooks.emit("afterJobCompleted", { ...JOB_EVENT });

    // A plugin cannot register anonymously and then be unattributable when it
    // misbehaves.
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({
      plugin: "anonymous-wannabe",
    });
  });
});

describe("the audit logger plugin", () => {
  /** Install the plugin against a captured sink. */
  function install(): { hooks: HookBus; lines: string[] } {
    const lines: string[] = [];
    const { hooks } = registerPlugins([
      createAuditLoggerPlugin({
        sink: (line) => lines.push(line),
        now: () => new Date("2026-08-27T12:00:00.000Z"),
      }),
    ]);

    return { hooks, lines };
  }

  test("writes one JSON line when a job completes", async () => {
    const { hooks, lines } = install();

    await hooks.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      audit: "job.completed",
      at: "2026-08-27T12:00:00.000Z",
      jobId: "job_1",
      projectId: "prj_1",
      ok: true,
      resumed: false,
    });
  });

  test("records a sync that changed nothing, not only ones that did", async () => {
    const { hooks, lines } = install();

    await hooks.emit("afterProjectSync", {
      projectId: "prj_1",
      userId: "u",
      changed: false,
      jobId: null,
      servicesAdded: 0,
      servicesUpdated: 0,
      servicesRemoved: 0,
      locationsAdded: 0,
      locationsUpdated: 0,
      locationsRemoved: 0,
      syncedAt: "2026-08-27T12:00:00.000Z",
    });

    // "We checked and it was current" is the answer an audit trail needs most
    // often; a plugin that only heard about changes could not tell a quiet
    // system from a broken integration.
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      audit: "project.synced",
      changed: false,
      jobId: null,
    });
  });

  test("records pages once written, not before", async () => {
    const { hooks, lines } = install();

    const context = {
      projectId: "prj_1",
      outputDir: "/out/prj_1",
      locale: "de",
      pageCount: 9,
      slugs: ["a"],
    };

    await hooks.emit("beforePagesWritten", context);
    expect(lines).toHaveLength(0);

    await hooks.emit("afterPagesWritten", {
      ...context,
      writtenAt: "2026-08-27T12:00:00.000Z",
    });

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      audit: "pages.written",
      pageCount: 9,
    });
  });

  test("can emit prose instead of JSON", async () => {
    const lines: string[] = [];
    const { hooks } = registerPlugins([
      createAuditLoggerPlugin({
        sink: (line) => lines.push(line),
        json: false,
        now: () => new Date("2026-08-27T12:00:00.000Z"),
      }),
    ]);

    await hooks.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(lines[0]).toContain("job.completed");
    expect(lines[0]).toContain("jobId=job_1");
  });

  test("a sink that throws does not break the emission", async () => {
    const { hooks } = registerPlugins([
      createAuditLoggerPlugin({
        sink: () => {
          throw new Error("disk full");
        },
      }),
    ]);

    const result = await hooks.emit("afterJobCompleted", { ...JOB_EVENT });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.plugin).toBe("audit-logger");
  });
});
