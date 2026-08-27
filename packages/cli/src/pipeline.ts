/**
 * The deploy pipeline.
 *
 * Stages are data, and the runner that executes them knows nothing about what
 * they do. That separation is the point: ordering and short-circuiting are
 * properties of the *runner*, so they can be tested against fake stages rather
 * than by running a real Next.js build and hoping.
 *
 * The pipeline never throws. It returns what happened, and the caller decides
 * the exit code — which is what lets a test assert on a failure without
 * catching, and what keeps the error rendering in one place.
 */

/** Shared state a stage may read and add to. */
export interface PipelineContext {
  /** Monorepo root. Every path a stage touches is derived from this. */
  repoRoot: string;
  /** Where the generator writes, and where the web app reads. */
  outputDir: string;
  /** Where the Next.js application lives. */
  webDir: string;

  locale: string;
  /** Database project to generate from. Absent means local file mode. */
  projectId: string | undefined;
  /** Absolute origin to publish at. */
  siteUrl: string | undefined;

  /** Facts a stage learned, for the summary. Stages append; nothing reads back. */
  notes: string[];

  log(message: string): void;
}

/** One step of the pipeline. */
export interface PipelineStage {
  name: string;
  /** One line, shown before the stage runs. */
  description: string;
  run(context: PipelineContext): Promise<void>;
}

/**
 * A failure a human can act on.
 *
 * Carries the lines to show instead of a stack trace. A pipeline that fails
 * with a 40-frame trace tells an operator nothing about which of their pages
 * was wrong.
 */
export class PipelineError extends Error {
  override readonly name = "PipelineError";

  constructor(
    readonly stage: string,
    readonly summary: string,
    /** Specific, addressed detail — a field path, a slug, a file. */
    readonly details: string[] = [],
    override readonly cause?: unknown,
  ) {
    super(`${stage}: ${summary}`);
  }
}

/** What one stage did. */
export interface StageOutcome {
  name: string;
  ms: number;
  ok: boolean;
}

/** What the whole run did. */
export interface PipelineResult {
  ok: boolean;
  stages: StageOutcome[];
  /** Stages never reached, because an earlier one failed. */
  skipped: string[];
  error: PipelineError | undefined;
  totalMs: number;
  notes: string[];
}

/** Turn any thrown value into something an operator can act on. */
export function toPipelineError(stage: string, error: unknown): PipelineError {
  if (error instanceof PipelineError) {
    return error;
  }

  // The generator's ValidationError carries per-field issues. Surfacing them is
  // the difference between "generation failed" and "page X has no state".
  //
  // Guarded: a stage may reject with anything at all, including `undefined`,
  // and an error handler that crashes turns a reportable failure into an
  // unhandled one.
  const issues =
    typeof error === "object" && error !== null
      ? (error as { issues?: Array<{ path: string; message: string }> }).issues
      : undefined;

  if (Array.isArray(issues) && issues.length > 0) {
    const name = error instanceof Error ? error.name : "Error";
    return new PipelineError(
      stage,
      `${name}: ${issues.length} issue(s)`,
      issues.map((issue) => `${issue.path}: ${issue.message}`),
      error,
    );
  }

  return new PipelineError(
    stage,
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    [],
    error,
  );
}

/**
 * Run stages in order, stopping at the first failure.
 *
 * Stopping matters more than it sounds: the build stage costs a minute and
 * produces a site. Letting it run after generation failed would publish
 * whatever happened to be on disk from the last good run — stale content that
 * looks entirely healthy.
 */
export async function runPipeline(
  stages: PipelineStage[],
  context: PipelineContext,
): Promise<PipelineResult> {
  const outcomes: StageOutcome[] = [];
  const startedAt = Date.now();

  for (const [index, stage] of stages.entries()) {
    context.log(`\n▸ ${stage.name} — ${stage.description}`);
    const stageStarted = Date.now();

    try {
      await stage.run(context);
      outcomes.push({ name: stage.name, ms: Date.now() - stageStarted, ok: true });
    } catch (error: unknown) {
      outcomes.push({ name: stage.name, ms: Date.now() - stageStarted, ok: false });

      return {
        ok: false,
        stages: outcomes,
        skipped: stages.slice(index + 1).map((remaining) => remaining.name),
        error: toPipelineError(stage.name, error),
        totalMs: Date.now() - startedAt,
        notes: context.notes,
      };
    }
  }

  return {
    ok: true,
    stages: outcomes,
    skipped: [],
    error: undefined,
    totalMs: Date.now() - startedAt,
    notes: context.notes,
  };
}

/** Render the run for a human. Returns the lines rather than printing them. */
export function formatResult(result: PipelineResult): string[] {
  const lines: string[] = [""];

  for (const stage of result.stages) {
    lines.push(
      `  ${stage.ok ? "✓" : "✗"} ${stage.name.padEnd(10)} ${String(stage.ms).padStart(7)} ms`,
    );
  }

  for (const name of result.skipped) {
    lines.push(`  · ${name.padEnd(10)} ${"skipped".padStart(7)}`);
  }

  lines.push(`  ${"".padEnd(12)} ${String(result.totalMs).padStart(7)} ms total`);

  if (result.notes.length > 0) {
    lines.push("");
    for (const note of result.notes) {
      lines.push(`  ${note}`);
    }
  }

  if (result.error !== undefined) {
    lines.push("", `✗ Pipeline failed at "${result.error.stage}".`, "");
    lines.push(`  ${result.error.summary}`);

    // Long issue lists are unreadable in full and useless truncated to one, so
    // show enough to see the pattern and say how many remain.
    const shown = result.error.details.slice(0, 15);
    for (const detail of shown) {
      lines.push(`    - ${detail}`);
    }
    if (result.error.details.length > shown.length) {
      lines.push(`    … and ${result.error.details.length - shown.length} more`);
    }

    if (result.skipped.length > 0) {
      lines.push(
        "",
        `  ${result.skipped.length} later stage(s) did not run, so nothing was published.`,
      );
    }
  } else {
    lines.push("", "✓ Pipeline complete.");
  }

  return lines;
}
