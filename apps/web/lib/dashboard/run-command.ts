import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { resolve } from "node:path";

import {
  assertSafeProjectId,
  computeCommandTimeoutMs,
  describeBudget,
} from "@staticforge/core";
import { LocaleSchema } from "@staticforge/schemas";

/**
 * Runs an engine command on the host and returns what it printed.
 *
 * The dashboard does not reimplement the pipeline; it invokes the same commands
 * an operator would type. That is the whole design: one implementation, one set
 * of guarantees, and a button that cannot drift from the command it claims to
 * run.
 *
 * ## Everything in `argv` is parsed before it is spawned
 *
 * On Windows this spawn goes through a shell, so an `argv` entry is not an
 * argument — it is a fragment of a command line, and a value carrying `&` ends
 * the command and starts another. Free text (the refresh feedback) therefore
 * travels in the environment, and the two values that *must* travel in `argv`
 * are parsed against their formats here, at the boundary that builds the
 * command, rather than trusted from the route that received them.
 *
 * The route validates them too. That is not redundancy for its own sake: the
 * route's check rejects a bad request with a useful message, and this one makes
 * the guarantee a property of the spawn itself, so a second caller cannot
 * reintroduce the hole by forgetting.
 */

/** Result of one command run. */
export interface CommandResult {
  ok: boolean;
  exitCode: number;
  /** Combined stdout and stderr, in order. */
  output: string;
  durationMs: number;
}

/**
 * The monorepo root.
 *
 * Next runs from `apps/web`, so the root is two levels up unless an explicit
 * value was handed down — the same contract the CLI uses, for the same reason:
 * npm and npx rewrite INIT_CWD to their own directory.
 */
export function repoRoot(): string {
  return process.env.STATICFORGE_REPO_ROOT ?? resolve(process.cwd(), "../..");
}

/**
 * Longest a command may run before it is killed, when nothing is known about
 * the size of the work.
 *
 * A floor, not a policy: callers that know the page count pass a budget derived
 * from it. See `computeCommandTimeoutMs` for why a flat limit cannot serve this
 * workload.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** How long a signalled tree has to exit before it is killed outright. */
const KILL_GRACE_MS = 5_000;

/** Most output to keep, in characters. A full build log is megabytes. */
const MAX_OUTPUT = 60_000;

/** SGR colour sequences, which render as garbage inside a `<pre>`. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Kill a spawned command and everything it started.
 *
 * `child.kill()` signals one process, and that process is not the one doing the
 * work: the chain is `npx` -> `tsx` -> the engine, with a shell wrapper in
 * front of all three on Windows. Killing the head leaves the engine running as
 * an orphan, still writing pages to disk and rows to the database, while the
 * job row it belongs to has already been closed out as failed and a new run may
 * start on top of it. A timeout that leaves the work running is worse than no
 * timeout, because it reports a stop that did not happen.
 *
 * Windows has no process groups, so the tree is walked by `taskkill /T`.
 * Elsewhere the child was spawned detached, which makes it a group leader, so
 * negating its pid signals the whole group.
 *
 * @param child - The spawned process.
 * @returns Whether the tree was signalled. A process that already exited counts
 * as success: there is nothing left to kill.
 */
function killTree(child: ChildProcessWithoutNullStreams): boolean {
  const pid = child.pid;

  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
      });

      // 128 is taskkill's "no such process": it exited between the check above
      // and this call, which is the outcome the call wanted anyway.
      return result.status === 0 || result.status === 128;
    }

    // Negative pid: the process group this child leads, not the child alone.
    process.kill(-pid, "SIGTERM");

    // A tree that ignores SIGTERM still has to go, or it keeps writing. Unref'd
    // so this timer alone cannot hold the process open.
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Gone between the two signals, which is the point of the first one.
      }
    }, KILL_GRACE_MS).unref();

    return true;
  } catch {
    // ESRCH means it exited on its own. Anything else is a refusal this code
    // cannot act on, and saying so beats reporting a kill that did not happen.
    return child.exitCode !== null;
  }
}

/**
 * Run a command, capturing its output.
 *
 * Never rejects: a non-zero exit is a *result* the dashboard displays, not an
 * exception. The operator needs to read the log either way.
 */
export function runCommand(
  command: string,
  args: string[],
  env: Record<string, string> = {},
  /** Called as output arrives, so a long run can report progress. */
  onOutput?: (output: string) => void,
  /** Budget for this run. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  const started = Date.now();
  const root = repoRoot();

  return new Promise<CommandResult>((resolveRun) => {
    let output = "";
    let settled = false;

    // Run the command as an operator would, not as a child of the dev server.
    // Inheriting NODE_ENV=development switches the Prisma client to query
    // logging, which buries the generator's own output under thousands of SQL
    // lines — output that is identical whether or not anything went wrong.
    // Annotated explicitly: the options object otherwise leaves the spawn
    // overloads ambiguous, and TypeScript collapses the result to never.
    const child: ChildProcessWithoutNullStreams = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        ...env,
        STATICFORGE_REPO_ROOT: root,
        // A build command, run as a build command. Inheriting the dev server's
        // `development` switches the Prisma client to query logging, burying
        // the generator's own output under thousands of SQL lines that read the
        // same whether or not anything went wrong.
        NODE_ENV: "production",
      },
      // Windows resolves npx through the shell; without this, spawn fails with
      // ENOENT rather than running anything.
      shell: process.platform === "win32",
      // Elsewhere, give the child its own process group so the whole tree can
      // be signalled at once. `npx` spawns `tsx`, which spawns the engine;
      // signalling only the child leaves the grandchild running.
      detached: process.platform !== "win32",
    });

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({
        ok: exitCode === 0,
        exitCode,
        output: stripAnsi(output.slice(-MAX_OUTPUT)),
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      const killed = killTree(child);
      output +=
        `\n\nTimed out after ${describeBudget(timeoutMs)} and was killed` +
        `${killed ? "" : " (the process tree could not be signalled)"}.`;
      finish(124);
    }, timeoutMs);

    const capture = (chunk: Buffer): void => {
      output += chunk.toString();
      // Trim as we go, so a runaway build cannot exhaust memory here.
      if (output.length > MAX_OUTPUT * 2) {
        output = output.slice(-MAX_OUTPUT);
      }
      onOutput?.(stripAnsi(output.slice(-MAX_OUTPUT)));
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error: Error) => {
      output += `\n${error.name}: ${error.message}`;
      finish(1);
    });
    child.on("close", (code: number | null) => finish(code ?? 1));
  });
}

/**
 * Parse the two values that must travel in `argv`, or explain the refusal.
 *
 * Returns a result rather than throwing: a bad value is something the operator
 * needs to read in the job log, and this module's contract is that a command
 * run reports rather than rejects.
 */
function checkArgs(
  projectId: string | undefined,
  locale: string,
): { ok: true; projectId: string | undefined; locale: string } | { ok: false; reason: string } {
  const parsedLocale = LocaleSchema.safeParse(locale);

  if (!parsedLocale.success) {
    return {
      ok: false,
      reason:
        `Refusing to run: "${locale}" is not a supported locale ` +
        `(${LocaleSchema.options.join(", ")}). Values on the command line are ` +
        `shell-parsed on Windows, so they are checked before the command is built.`,
    };
  }

  if (projectId === undefined) {
    return { ok: true, projectId: undefined, locale: parsedLocale.data };
  }

  try {
    return {
      ok: true,
      projectId: assertSafeProjectId(projectId),
      locale: parsedLocale.data,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `Refusing to run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Whether the run this budget is for will author content with the model.
 *
 * Read from the same variable the spawned process will read, because it is the
 * one that decides whether a page costs milliseconds or half a minute. The
 * child inherits this environment, so the budget and the work it is budgeting
 * cannot disagree.
 */
function aiAuthoringEnabled(): boolean {
  return process.env.USE_AI_GENERATION === "true";
}

/** Budget one run from the number of pages it is expected to produce. */
function budgetFor(pageCount: number): number {
  return computeCommandTimeoutMs({
    pageCount,
    aiEnabled: aiAuthoringEnabled(),
  });
}

/**
 * The owner the spawned command acts as.
 *
 * Through the environment for the same reason the refresh feedback is: `argv`
 * is shell-parsed on Windows, and an identity is not a thing to hand to a shell.
 * The engine reads it back through `resolveOperatorId()`.
 */
function operatorEnv(userId: string): Record<string, string> {
  return { STATICFORGE_USER_ID: userId };
}

/** The refusal, shaped like a finished run so the job records it as a failure. */
function refuse(reason: string): Promise<CommandResult> {
  return Promise.resolve({ ok: false, exitCode: 1, output: reason, durationMs: 0 });
}

/** Run the generator for a project, or for the local files when none is given. */
export function runGenerate(
  projectId: string | undefined,
  locale: string,
  userId: string,
  /** Pages this run is expected to produce, for the timeout budget. */
  pageCount: number,
  onOutput?: (output: string) => void,
): Promise<CommandResult> {
  const checked = checkArgs(projectId, locale);

  if (!checked.ok) {
    return refuse(checked.reason);
  }

  const args = [
    "tsx",
    "packages/generator/src/generate-pages.cli.ts",
    "--locale",
    checked.locale,
  ];

  if (checked.projectId !== undefined) {
    args.push("--project-id", checked.projectId);
  }

  return runCommand(
    "npx",
    args,
    operatorEnv(userId),
    onOutput,
    budgetFor(pageCount),
  );
}

/** Run the full deploy pipeline: generate, validate, build. */
export function runPipeline(
  projectId: string | undefined,
  locale: string,
  userId: string,
  /** Pages this run is expected to produce, for the timeout budget. */
  pageCount: number,
  onOutput?: (output: string) => void,
): Promise<CommandResult> {
  const checked = checkArgs(projectId, locale);

  if (!checked.ok) {
    return refuse(checked.reason);
  }

  const args = [
    "tsx",
    "packages/cli/src/cli.ts",
    "build",
    "--locale",
    checked.locale,
  ];

  if (checked.projectId !== undefined) {
    args.push("--project-id", checked.projectId);
  }

  return runCommand(
    "npx",
    args,
    operatorEnv(userId),
    onOutput,
    budgetFor(pageCount),
  );
}

/**
 * Revise one page against operator feedback.
 *
 * The feedback travels in the environment, never in `argv`. It is free text an
 * operator typed, this spawn goes through a shell on Windows, and anything in
 * `argv` is shell-parsed — a note containing `&` or a quote would break the
 * command at best. Environment values are handed to the process directly.
 *
 * The three values that do travel in `argv` — the project id, the slug and the
 * locale — are each parsed against their own format first.
 */
export function runRefresh(
  projectId: string,
  target: { slug: string; feedback: string } | undefined,
  locale: string,
  userId: string,
  onOutput?: (output: string) => void,
): Promise<CommandResult> {
  if (target === undefined) {
    return refuse("A refresh job needs a target page and feedback.");
  }

  const checked = checkArgs(projectId, locale);

  if (!checked.ok) {
    return refuse(checked.reason);
  }

  if (checked.projectId === undefined) {
    return refuse("A refresh job needs a project id.");
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.slug)) {
    return refuse(`Refusing to run: "${target.slug}" is not a valid page slug.`);
  }

  return runCommand(
    "npx",
    [
      "tsx",
      "packages/generator/src/refresh-page.cli.ts",
      "--project-id",
      checked.projectId,
      "--slug",
      target.slug,
      "--locale",
      checked.locale,
    ],
    { ...operatorEnv(userId), STATICFORGE_FEEDBACK: target.feedback },
    onOutput,
    // A refresh rewrites exactly one page.
    budgetFor(1),
  );
}
