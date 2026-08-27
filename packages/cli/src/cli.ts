import { parseArgs } from "node:util";
import { join, resolve } from "node:path";

import { resolveOutputDir } from "@staticforge/core";

import { formatResult, runPipeline, type PipelineContext } from "./pipeline.js";
import { DEPLOY_STAGES } from "./stages.js";

/**
 * `staticforge` — the unified deploy pipeline.
 *
 * ```bash
 * corepack pnpm staticforge build
 * corepack pnpm staticforge build --project-id prj-glanzfix-de
 * corepack pnpm staticforge build --site-url https://staging.example
 * ```
 *
 * One command from data to a built site. Every path is derived from the
 * repository root, so the handoff between the generator's output and the web
 * app's input needs no manual step and no assumption about the working
 * directory.
 */

const USAGE = `staticforge <command> [options]

Commands:
  build                 Generate, validate and build once, in this process.
  worker                Run the queue worker until stopped.

build options:
  --locale <de|en>      Content locale. Default: de
  --project-id <id>     Generate from a database project. Default: local files
  --site-url <origin>   Publish at this origin, e.g. https://www.example.de
  --skip-build          Run generate and validate only

worker options:
  --idle-ms <ms>        How long to wait when the queue is empty. Default: 3000
  --lease-ms <ms>       How long a claim holds without renewal. Default: 120000

Exits non-zero if any stage fails, and never reaches the build when an
earlier stage did.`;

function resolveRepoRoot(): string {
  return process.env.INIT_CWD ?? resolve(process.cwd(), "../..");
}

/** Parse a millisecond option, or fall back rather than fail a long-running daemon. */
function millis(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/**
 * Run the queue worker until the process is asked to stop.
 *
 * Stopping is cooperative: SIGINT and SIGTERM ask the loop to finish the job it
 * is on and then exit. A worker that dropped its job on the first signal would
 * leave a lease to lapse and another worker to redo the tail of it, which is
 * the exact waste the lease exists to prevent. A second signal is taken as
 * impatience and exits at once - which is safe precisely because the job is
 * resumable.
 */
async function runWorker(values: Record<string, unknown>): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const { startDatabaseWorker, workerInstanceId } = await import(
    "./worker/index.js"
  );

  const instanceId = workerInstanceId();

  console.log(
    `staticforge worker - instance "${instanceId}"`,
    `\n  root: ${repoRoot}`,
    `\n  claiming PENDING jobs and reclaiming lapsed leases. Ctrl-C to stop.`,
  );

  const handle = await startDatabaseWorker({
    repoRoot,
    instanceId,
    idleMs: millis(values["idle-ms"] as string | undefined, 3000),
    leaseMs: millis(values["lease-ms"] as string | undefined, 120_000),
    log: (message: string) => {
      console.log(message);
    },
  });

  let stopping = false;

  const stop = (signal: string): void => {
    if (stopping) {
      console.log(`\n${signal} again - exiting now. The job is resumable.`);
      process.exit(130);
    }

    stopping = true;
    console.log(`\n${signal} - finishing the current job, then stopping.`);
    handle.stop();
  };

  process.on("SIGINT", () => {
    stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    stop("SIGTERM");
  });

  await handle.done;
  console.log("worker stopped.");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      locale: { type: "string", default: "de" },
      "project-id": { type: "string" },
      "site-url": { type: "string" },
      "skip-build": { type: "boolean", default: false },
      "idle-ms": { type: "string" },
      "lease-ms": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const command = positionals[0] ?? "build";

  if (values.help === true || command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === "worker") {
    await runWorker(values);
    return;
  }

  if (command !== "build") {
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const repoRoot = resolveRepoRoot();
  const projectId = values["project-id"];

  const context: PipelineContext = {
    repoRoot,
    // Isolated per project, and every stage below reads it from here: the
    // validate stage re-reads this directory cold, and the build stage hands it
    // to Next as STATICFORGE_OUTPUT_DIR. One value, so the three stages cannot
    // disagree about which tenant's site is being published.
    outputDir: resolveOutputDir(repoRoot, projectId),
    webDir: join(repoRoot, "apps", "web"),
    locale: values.locale ?? "de",
    projectId,
    siteUrl: values["site-url"],
    notes: [],
    log: (message: string) => {
      console.log(message);
    },
  };

  const stages =
    values["skip-build"] === true
      ? DEPLOY_STAGES.filter((stage) => stage.name !== "build")
      : DEPLOY_STAGES;

  console.log(
    `staticforge build — ${context.projectId === undefined ? "local files" : `project ${context.projectId}`}, locale ${context.locale}`,
  );

  const result = await runPipeline(stages, context);

  for (const line of formatResult(result)) {
    console.log(line);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  // Nothing should reach here — the runner turns stage failures into results —
  // so anything that does is a bug in the pipeline itself, not in a build.
  console.error(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
  process.exitCode = 1;
});
