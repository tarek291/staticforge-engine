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
  analyze               Ask the AI analyst which pages are worth building next.
  api-keys              Mint, list and revoke organization API keys.

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

analyze options:
  --project-id <id>     Project to analyse. Required.
  --gaps-only           List the missing combinations without asking the model.

api-keys <create|list|revoke> options:
  --org-id <id>         Organization the key belongs to. Required.
  --name <name>         What the key is for. Required for create.
  --role <role>         OWNER | EDITOR | VIEWER. Default: EDITOR
  --key-id <id>         Key to revoke. Required for revoke.

A created key is printed once and stored only as a SHA-256 hash. It cannot be
shown again; a lost key is replaced rather than recovered.

The analyze command is read-only: it queues nothing and writes nothing.
Acting on the advice is a separate, deliberate step.

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

  let result: Awaited<ReturnType<typeof syncProject>>;

  try {
    result = await syncProject(projectId, userId, parsed.payload, prisma, {
      enqueue: !dryRun,
      enqueueJob: async (project, owner, scope) => {
        // The scope travels with the job so the run re-authors only the pages
        // the change reached. Empty means a full run.
        const job = await enqueueJob(
          project,
          owner,
          "GENERATE",
          prisma,
          undefined,
          scope,
        );
        return job?.id ?? null;
      },
    });
  } catch (error: unknown) {
    // A refusal is a sentence, not a stack trace. An operator whose role is too
    // weak needs to know who to ask, and one who is not a member at all is told
    // only that they have no access — the same answer an id that does not exist
    // would give.
    if (error instanceof Error && error.name === "AccessDeniedError") {
      console.error(`✗ ${error.message}`);
      process.exitCode = 1;
      return;
    }

    throw error;
  }

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

/**
 * Ask the analyst which pages are worth building next.
 *
 * Read-only, and structurally so: this function loads a project and calls an
 * agent that imports nothing capable of writing. It cannot queue a run or
 * change a row even by mistake.
 *
 * Acting on the advice stays a separate, deliberate step. An analyst that
 * enqueued what it recommended would turn a suggestion into a purchase order,
 * and the operator would find out what it decided by reading the bill.
 */
async function runAnalyze(values: Record<string, unknown>): Promise<void> {
  const projectId = values["project-id"] as string | undefined;
  const gapsOnly = values["gaps-only"] === true;

  if (projectId === undefined) {
    console.error("--project-id is required.");
    process.exitCode = 1;
    return;
  }

  const { getProjectPayload, prisma, resolveOperatorId } = await import(
    "@staticforge/database"
  );
  const userId = resolveOperatorId();

  const payload = await getProjectPayload(projectId, userId, prisma).catch(
    (error: unknown) => {
      console.error(
        `✗ ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    },
  );

  if (payload === null) {
    process.exitCode = 1;
    return;
  }

  const business = payload.businesses[0];

  if (business === undefined) {
    console.error(`✗ Project "${projectId}" has no business record.`);
    process.exitCode = 1;
    return;
  }

  // Existing coverage, read straight from the pages table. Nothing is written.
  const existing = await prisma.generatedPage.findMany({
    where: { projectId, project: { userId } },
    select: { serviceId: true, locationId: true },
  });

  const { analyzeContentGaps, findContentGaps } = await import("@staticforge/ai");

  const input = {
    business,
    services: payload.services,
    locations: payload.locations,
    existingPages: existing,
  };

  const gaps = findContentGaps(input);
  const grid = payload.services.length * payload.locations.length;

  console.log(
    `${payload.services.length} service(s) × ${payload.locations.length} location(s) = ${grid} possible pages`,
  );
  console.log(`${existing.length} exist, ${gaps.length} missing`);

  if (gapsOnly || gaps.length === 0) {
    if (gaps.length === 0) {
      console.log("\n✓ Every combination already has a page.");
    } else {
      // The list is exact and free. An operator who only wants it should not
      // have to buy an opinion about it.
      console.log("");
      for (const gap of gaps.slice(0, 50)) {
        console.log(`  · ${gap.serviceName} in ${gap.cityName}  (${gap.serviceId} × ${gap.locationId})`);
      }
      if (gaps.length > 50) {
        console.log(`  … and ${gaps.length - 50} more`);
      }
    }
    await prisma.$disconnect();
    return;
  }

  console.log(`\n… asking the analyst (this is one paid call)`);

  try {
    const result = await analyzeContentGaps(input);

    console.log(`\n${result.analysis.summary}\n`);

    if (result.analysis.recommendedPages.length > 0) {
      console.log("Recommended pages:");
      for (const page of result.analysis.recommendedPages) {
        const service = payload.services.find((item) => item.id === page.serviceId);
        const location = payload.locations.find((item) => item.id === page.locationId);
        console.log(
          `  [${page.priority}] ${service?.name ?? page.serviceId} in ${location?.city ?? page.locationId}`,
        );
        console.log(`      ${page.rationale}`);
      }
    }

    if (result.analysis.suggestedNewServices.length > 0) {
      console.log(`\nServices worth adding:`);
      for (const service of result.analysis.suggestedNewServices) {
        console.log(`  [${service.priority}] ${service.name}`);
        console.log(`      ${service.rationale}`);
      }
    }

    if (result.discarded.length > 0) {
      // Surfaced, not swallowed. An analyst quietly dropping part of its own
      // answer is one nobody should trust.
      console.log(
        `\n! ${result.discarded.length} recommendation(s) were discarded as ungrounded:`,
      );
      for (const item of result.discarded.slice(0, 10)) {
        console.log(`  - ${item.serviceId} × ${item.locationId}: ${item.reason}`);
      }
    }

    console.log(`\nNothing was queued and nothing was written.`);
  } catch (error: unknown) {
    console.error(
      `\n✗ ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Mint, list and revoke organization API keys.
 *
 * A terminal command because there is no dashboard for this yet, and because
 * the alternative — a route that issues credentials — would need to be
 * authenticated by a credential, which is the problem this command exists to
 * bootstrap out of.
 *
 * `create` prints the plaintext once. There is deliberately no way to print it
 * again: it is hashed on the way into the database and the original is never
 * stored, so a lost key is replaced rather than recovered. The output says so
 * at the moment it matters rather than in documentation nobody reads twice.
 *
 * `revoke` exists for the same reason `create` does. A system that can issue
 * credentials and not withdraw them is one where a key pasted into a public
 * repository can never be turned off, and that is a worse gap than having no
 * keys at all.
 */
async function runApiKeys(values: {
  "org-id"?: string | undefined;
  name?: string | undefined;
  "key-id"?: string | undefined;
  role?: string | undefined;
}, action: string | undefined): Promise<void> {
  const { generateApiKey, listApiKeys, prisma, revokeApiKey } = await import(
    "@staticforge/database"
  );

  const organizationId = values["org-id"]?.trim();

  if (organizationId === undefined || organizationId === "") {
    console.error("api-keys needs --org-id <id>.\n\n" + USAGE);
    process.exitCode = 1;
    return;
  }

  try {
    if (action === "create") {
      const name = values.name?.trim();

      if (name === undefined || name === "") {
        console.error("api-keys create needs --name <name>.");
        process.exitCode = 1;
        return;
      }

      const role = values.role?.trim().toUpperCase();

      if (role !== undefined && role !== "OWNER" && role !== "EDITOR" && role !== "VIEWER") {
        console.error(`Unknown role "${role}". Use OWNER, EDITOR or VIEWER.`);
        process.exitCode = 1;
        return;
      }

      const minted = await generateApiKey(
        organizationId,
        name,
        prisma,
        role === undefined ? {} : { role },
      );

      console.log(`\n✓ API key created for organization ${organizationId}`);
      console.log(`  id:   ${minted.key.id}`);
      console.log(`  name: ${minted.key.name}`);
      console.log(`\n  ${minted.plaintext}\n`);
      // Said plainly and once. An operator who closes this terminal without
      // copying it has to mint a replacement, and finding that out later — from
      // a 401 in an integration — is a worse way to learn it.
      console.log("  Copy it now. It is stored only as a hash and cannot be shown again.");
      console.log("  Send it as: Authorization: Bearer <key>\n");
      return;
    }

    if (action === "list") {
      const keys = await listApiKeys(organizationId, prisma);

      if (keys.length === 0) {
        console.log(`No API keys for organization ${organizationId}.`);
        return;
      }

      console.log(`\nAPI keys for organization ${organizationId}:\n`);
      for (const key of keys) {
        const state = key.active
          ? "active"
          : `revoked ${key.revokedAt?.slice(0, 10) ?? ""}`;
        console.log(`  ${key.id}  ${state.padEnd(20)} ${key.name}`);
      }
      // The secret is absent from this listing and from the table it reads, so
      // there is nothing here to redact.
      console.log("");
      return;
    }

    if (action === "revoke") {
      const keyId = values["key-id"]?.trim();

      if (keyId === undefined || keyId === "") {
        console.error("api-keys revoke needs --key-id <id>.");
        process.exitCode = 1;
        return;
      }

      const revoked = await revokeApiKey(keyId, organizationId, prisma);

      if (revoked === null) {
        // Scoped to the organization, so this is also the answer for a key that
        // exists but belongs to someone else. Holding a key id must not be
        // enough to turn off another tenant's credential, or to learn that it
        // is real.
        console.error(`✗ No API key "${keyId}" in organization ${organizationId}.`);
        process.exitCode = 1;
        return;
      }

      console.log(`✓ Key ${revoked.id} ("${revoked.name}") revoked at ${revoked.revokedAt}.`);
      console.log("  Any integration still using it will now get 401.");
      return;
    }

    console.error(`Unknown api-keys action "${action ?? ""}".\n\n${USAGE}`);
    process.exitCode = 1;
  } catch (error: unknown) {
    console.error(
      `\n✗ ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
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
      "gaps-only": { type: "boolean", default: false },
      "org-id": { type: "string" },
      name: { type: "string" },
      "key-id": { type: "string" },
      role: { type: "string" },
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

  if (command === "analyze") {
    await runAnalyze(values);
    return;
  }

  if (command === "api-keys") {
    await runApiKeys(values, positionals[1]);
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
