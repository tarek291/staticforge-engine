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
  sync                  Pull services and locations from a published sheet.

build options:
  --locale <de|en>      Content locale. Default: de
  --project-id <id>     Generate from a database project. Default: local files
  --site-url <origin>   Publish at this origin, e.g. https://www.example.de
  --skip-build          Run generate and validate only

worker options:
  --idle-ms <ms>        How long to wait when the queue is empty. Default: 3000
  --lease-ms <ms>       How long a claim holds without renewal. Default: 120000

sync options:
  --project-id <id>     Project to sync into. Required.
  --url <url>           Published CSV to pull from. Required.
  --dry-run             Report what would change, and write nothing.

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

/**
 * Pull services and locations from a published sheet into a project.
 *
 * The pull half of the sync layer. It fetches, parses through the CSV adapter,
 * compares against what the project already holds, and queues a run only if the
 * comparison says the pages would come out different.
 *
 * That last part is the whole point. These sources re-send: a nightly cron
 * uploads the same sheet, an operator clicks twice. A sync that queued a run
 * every time would be a standing order to re-buy a few hundred pages of prose
 * identical to the prose already stored.
 */
async function runSync(values: Record<string, unknown>): Promise<void> {
  const projectId = values["project-id"] as string | undefined;
  const url = values.url as string | undefined;
  const dryRun = values["dry-run"] === true;

  if (projectId === undefined || url === undefined) {
    console.error("Both --project-id and --url are required.");
    process.exitCode = 1;
    return;
  }

  const { csvSyncAdapter } = await import("@staticforge/core");
  const { fetchSheet } = await import("./sync/fetch-sheet.js");

  console.log(`▸ fetching ${url}`);

  const fetched = await fetchSheet(url);

  if (!fetched.ok) {
    console.error(`✗ ${fetched.message}`);
    process.exitCode = 1;
    return;
  }

  const parsed = csvSyncAdapter.parse(fetched.body);

  if (!parsed.ok) {
    console.error(`\n✗ The sheet has ${parsed.issues.length} problem(s):\n`);
    for (const issue of parsed.issues.slice(0, 20)) {
      console.error(`  - ${issue.path}: ${issue.message}`);
    }
    if (parsed.issues.length > 20) {
      console.error(`  … and ${parsed.issues.length - 20} more`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `✓ parsed ${parsed.payload.services?.length ?? 0} service(s), ` +
      `${parsed.payload.locations?.length ?? 0} location(s)`,
  );

  const { describeSyncDiff, enqueueJob, prisma, resolveOperatorId, syncProject } =
    await import("@staticforge/database");

  const userId = resolveOperatorId();

  const result = await syncProject(projectId, userId, parsed.payload, prisma, {
    enqueue: !dryRun,
    enqueueJob: async (project, owner) => {
      const job = await enqueueJob(project, owner, "GENERATE", prisma);
      return job?.id ?? null;
    },
  });

  if (result === null) {
    // The same answer a project that does not exist would give: a sync must not
    // become a way to discover which ids are real.
    console.error(`✗ Project "${projectId}" not found.`);
    process.exitCode = 1;
    return;
  }

  if (!result.changed) {
    console.log(`· ${result.note ?? "nothing changed"} — no run queued.`);
    return;
  }

  console.log(`✓ applied (${describeSyncDiff(result.diff)})`);

  if (result.jobId === null) {
    console.log(
      dryRun
        ? "· dry run — nothing was written and no run was queued."
        : "· no run queued.",
    );
    return;
  }

  console.log(`✓ queued job ${result.jobId} — a worker will pick it up.`);
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
      url: { type: "string" },
      "dry-run": { type: "boolean", default: false },
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

  if (command === "sync") {
    await runSync(values);
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
