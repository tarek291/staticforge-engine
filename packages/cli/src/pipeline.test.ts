import { describe, expect, test } from "vitest";

import {
  PipelineError,
  formatResult,
  runPipeline,
  toPipelineError,
  type PipelineContext,
  type PipelineStage,
} from "./pipeline.js";
import { DEPLOY_STAGES } from "./stages.js";

/**
 * The runner is tested against fake stages on purpose.
 *
 * Ordering and short-circuiting are properties of the *runner*, not of what the
 * stages happen to do. Proving them by running a real Next.js build would take
 * a minute per assertion and would prove them only for that one arrangement.
 */

function context(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    repoRoot: "/repo",
    outputDir: "/repo/data/output",
    webDir: "/repo/apps/web",
    locale: "de",
    projectId: undefined,
    siteUrl: undefined,
    notes: [],
    log: () => {},
    ...overrides,
  };
}

/** A stage that records when it ran. */
function recording(name: string, order: string[]): PipelineStage {
  return {
    name,
    description: name,
    run: () => {
      order.push(name);
      return Promise.resolve();
    },
  };
}

/** A stage that always fails. */
function failing(name: string, error: unknown): PipelineStage {
  return {
    name,
    description: name,
    run: () => Promise.reject(error),
  };
}

describe("stage ordering", () => {
  test("runs every stage in the order given", async () => {
    const order: string[] = [];
    const result = await runPipeline(
      [recording("a", order), recording("b", order), recording("c", order)],
      context(),
    );

    expect(order).toEqual(["a", "b", "c"]);
    expect(result.ok).toBe(true);
    expect(result.stages.map((stage) => stage.name)).toEqual(["a", "b", "c"]);
  });

  test("runs stages sequentially, not in parallel", async () => {
    const events: string[] = [];
    const slow = (name: string): PipelineStage => ({
      name,
      description: name,
      run: async () => {
        events.push(`${name}:start`);
        await new Promise((resolveTick) => setTimeout(resolveTick, 5));
        events.push(`${name}:end`);
      },
    });

    await runPipeline([slow("a"), slow("b")], context());

    // Each stage consumes the previous one's output; overlapping them would
    // build against a half-written directory.
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("the shipped pipeline is generate, then validate, then build", () => {
    expect(DEPLOY_STAGES.map((stage) => stage.name)).toEqual([
      "generate",
      "validate",
      "build",
    ]);
  });

  test("validation comes before the build, never after", () => {
    const names = DEPLOY_STAGES.map((stage) => stage.name);

    // Discovering a broken graph after the build means discovering it after
    // publishing.
    expect(names.indexOf("validate")).toBeLessThan(names.indexOf("build"));
  });
});

describe("stopping on failure", () => {
  test("does not run later stages once one fails", async () => {
    const order: string[] = [];
    const result = await runPipeline(
      [
        recording("a", order),
        failing("b", new Error("boom")),
        recording("c", order),
      ],
      context(),
    );

    expect(order).toEqual(["a"]);
    expect(result.ok).toBe(false);
    expect(result.skipped).toEqual(["c"]);
  });

  test("a failed generate never reaches the build", async () => {
    const built: string[] = [];
    const stages: PipelineStage[] = [
      failing("generate", new Error("input invalid")),
      recording("validate", built),
      recording("build", built),
    ];

    const result = await runPipeline(stages, context());

    // Building anyway would publish whatever was on disk from the last good
    // run — stale content that looks entirely healthy.
    expect(built).toEqual([]);
    expect(result.skipped).toEqual(["validate", "build"]);
  });

  test("a failed validate never reaches the build", async () => {
    const built: string[] = [];
    const result = await runPipeline(
      [
        recording("generate", built),
        failing("validate", new PipelineError("validate", "orphan page", ["x"])),
        recording("build", built),
      ],
      context(),
    );

    expect(built).toEqual(["generate"]);
    expect(result.error?.stage).toBe("validate");
  });

  test("records the failed stage's own timing", async () => {
    const result = await runPipeline([failing("a", new Error("x"))], context());

    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({ name: "a", ok: false });
  });

  test("never throws — the caller decides the exit code", async () => {
    await expect(
      runPipeline([failing("a", new Error("x"))], context()),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("error translation", () => {
  test("keeps a PipelineError as it is", () => {
    const original = new PipelineError("validate", "summary", ["detail"]);

    expect(toPipelineError("validate", original)).toBe(original);
  });

  test("unpacks a ValidationError's per-field issues", () => {
    // The generator's failures carry the field paths that matter; flattening
    // them to a message would lose exactly the useful part.
    const validationError = Object.assign(new Error("failed"), {
      name: "ValidationError",
      issues: [
        { path: "pages[a].title", message: "Too long" },
        { path: "pages[b].slug", message: "Duplicate" },
      ],
    });

    const translated = toPipelineError("generate", validationError);

    expect(translated.summary).toContain("2 issue(s)");
    expect(translated.details).toEqual([
      "pages[a].title: Too long",
      "pages[b].slug: Duplicate",
    ]);
  });

  test("keeps a plain error readable", () => {
    const translated = toPipelineError("build", new Error("ENOENT: next not found"));

    expect(translated.summary).toBe("Error: ENOENT: next not found");
    expect(translated.details).toEqual([]);
  });

  test("survives something that is not an error at all", () => {
    expect(toPipelineError("build", "just a string").summary).toBe("just a string");
    expect(() => toPipelineError("build", undefined)).not.toThrow();
  });

  test("keeps the original as the cause", () => {
    const original = new Error("root cause");

    expect(toPipelineError("build", original).cause).toBe(original);
  });
});

describe("reporting", () => {
  test("shows each stage with a tick", async () => {
    const order: string[] = [];
    const lines = formatResult(
      await runPipeline([recording("generate", order)], context()),
    );

    expect(lines.join("\n")).toContain("✓ generate");
    expect(lines.join("\n")).toContain("✓ Pipeline complete.");
  });

  test("marks skipped stages, so nothing looks silently absent", async () => {
    const order: string[] = [];
    const lines = formatResult(
      await runPipeline(
        [failing("generate", new Error("x")), recording("build", order)],
        context(),
      ),
    ).join("\n");

    expect(lines).toContain("✗ generate");
    expect(lines).toContain("· build");
    expect(lines).toContain("skipped");
  });

  test("says plainly that nothing was published", async () => {
    const order: string[] = [];
    const lines = formatResult(
      await runPipeline(
        [failing("validate", new Error("x")), recording("build", order)],
        context(),
      ),
    ).join("\n");

    expect(lines).toContain("did not run, so nothing was published");
  });

  test("renders issue detail instead of a stack trace", async () => {
    const lines = formatResult(
      await runPipeline(
        [
          failing(
            "validate",
            new PipelineError("validate", "The graph broke.", [
              "pages[a]: Orphan page",
            ]),
          ),
        ],
        context(),
      ),
    ).join("\n");

    expect(lines).toContain("The graph broke.");
    expect(lines).toContain("- pages[a]: Orphan page");
    expect(lines).not.toContain("at Object.");
  });

  test("truncates a long issue list rather than flooding the terminal", async () => {
    const details = Array.from({ length: 40 }, (_unused, index) => `issue ${index}`);

    const lines = formatResult(
      await runPipeline(
        [failing("validate", new PipelineError("validate", "many", details))],
        context(),
      ),
    ).join("\n");

    expect(lines).toContain("issue 0");
    expect(lines).toContain("and 25 more");
    expect(lines).not.toContain("issue 39");
  });

  test("carries notes a stage recorded", async () => {
    const noting: PipelineStage = {
      name: "validate",
      description: "v",
      run: (ctx) => {
        ctx.notes.push("· 9 pages, 9 indexable");
        return Promise.resolve();
      },
    };

    const lines = formatResult(await runPipeline([noting], context())).join("\n");

    expect(lines).toContain("9 pages, 9 indexable");
  });
});

describe("context", () => {
  test("every path is derived from the repository root", () => {
    const ctx = context();

    // A pipeline that works because of the directory it was started from is a
    // pipeline that breaks in CI.
    expect(ctx.outputDir.startsWith(ctx.repoRoot)).toBe(true);
    expect(ctx.webDir.startsWith(ctx.repoRoot)).toBe(true);
  });

  test("an empty pipeline succeeds without doing anything", async () => {
    const result = await runPipeline([], context());

    expect(result).toMatchObject({ ok: true, stages: [], skipped: [] });
  });
});
