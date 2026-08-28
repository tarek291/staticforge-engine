import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { assertSafeProjectId, computeCommandTimeoutMs, describeBudget } from "@staticforge/core";
import { LocaleSchema, PageSlugSchema } from "@staticforge/schemas";

/**
 * Running the engine for one queued job.
 *
 * This used to live inside the Next.js server, which is what made the server
 * the thing that could not be scaled: an HTTP process that also runs
 * hour-long builds cannot be restarted, replicated, or deployed without
 * killing work. The code moved rather than being rewritten, because the
 * problem was never the spawning — it was who was doing it.
 *
 * The engine is still invoked as the command an operator would type. One
 * implementation, one set of guarantees, and a worker that cannot drift from
 * the command it claims to run.
 */

/** What one engine run did. */
export interface EngineResult {
  ok: boolean;
  exitCode: number;
  /** Combined stdout and stderr, trimmed to the tail. */
  output: string;
  durationMs: number;
}

/**
 * Environment variable carrying a run's page scope, comma-separated.
 *
 * The environment rather than `argv`, for the reason the refresh feedback
 * already travels this way: on Windows the spawn goes through a shell, so an
 * argv entry is a fragment of a command line rather than an argument. A list is
 * the worst case for that — one bad element ends the command and starts another
 * — and a scope can hold hundreds of them.
 */
export const ONLY_SLUGS_ENV_VAR = "STATICFORGE_ONLY_SLUGS";

/** How long a signalled tree has to exit before it is killed outright. */
const KILL_GRACE_MS = 5_000;

/** Most output to keep, in characters. A full build log is megabytes. */
const MAX_OUTPUT = 60_000;

/** SGR colour sequences, which render as garbage inside a `<pre>`. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Kill a spawned command and everything it started.
 *
 * `child.kill()` signals one process, and that process is not the one doing
 * the work: the chain is `npx` -> `tsx` -> the engine, with a shell wrapper in
 * front of all three on Windows. Killing the head leaves the engine running as
 * an orphan, still writing pages and rows, while the job row it belongs to has
 * already been closed out and another worker may reclaim it.
 *
 * @returns Whether the tree was signalled. A process that already exited counts
 * as success: there is nothing left to kill.
 */
export function killTree(child: ChildProcessWithoutNullStreams): boolean {
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

    process.kill(-pid, "SIGTERM");

    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Gone between the two signals, which is the point of the first one.
      }
    }, KILL_GRACE_MS).unref();

    return true;
  } catch {
    return child.exitCode !== null;
  }
}

/** What the worker knows about the run it is about to start. */
export interface EngineInvocation {
  /** Repository root. Every path the child resolves comes from this. */
  repoRoot: string;
  kind: "GENERATE" | "BUILD" | "REFRESH";
  projectId: string;
  userId: string;
  locale: string;
  /** The job row this run reports progress to. */
  jobId: string;
  /** Pages the run is expected to produce, for the timeout budget. */
  pageCount: number;
  /** For a REFRESH: which page, and what the operator asked to change. */
  target?: { slug: string; feedback: string } | undefined;
  /**
   * For a scoped GENERATE: the only pages this run may re-author.
   *
   * Empty or absent means a full run. The scope narrows the AI pass alone — the
   * run still builds, links and persists the whole project — so losing it costs
   * money rather than correctness, which is the direction a scope should fail.
   */
  onlySlugs?: readonly string[] | undefined;
  /** Called as output arrives, so a long run can report progress. */
  onOutput?: ((output: string) => void) | undefined;
}

/** A refusal, shaped like a finished run so the job records it as a failure. */
function refuse(reason: string): EngineResult {
  return { ok: false, exitCode: 1, output: reason, durationMs: 0 };
}

/**
 * Build the argument vector for one job kind.
 *
 * Every value that reaches `argv` is parsed against its own format first. On
 * Windows the spawn goes through a shell, so an `argv` entry is not an
 * argument — it is a fragment of a command line, and a value carrying `&` ends
 * the command and starts another. Free text never travels here at all: the
 * refresh feedback goes through the environment.
 */
function buildArgs(
  invocation: EngineInvocation,
): { ok: true; args: string[]; env: Record<string, string> } | { ok: false; reason: string } {
  const locale = LocaleSchema.safeParse(invocation.locale);

  if (!locale.success) {
    return {
      ok: false,
      reason:
        `Refusing to run: "${invocation.locale}" is not a supported locale ` +
        `(${LocaleSchema.options.join(", ")}).`,
    };
  }

  let projectId: string;

  try {
    projectId = assertSafeProjectId(invocation.projectId);
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `Refusing to run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const env: Record<string, string> = {
    STATICFORGE_USER_ID: invocation.userId,
    STATICFORGE_JOB_ID: invocation.jobId,
  };

  if (invocation.kind === "REFRESH") {
    if (invocation.target === undefined) {
      return { ok: false, reason: "A refresh job needs a target page and feedback." };
    }

    if (!PageSlugSchema.safeParse(invocation.target.slug).success) {
      return {
        ok: false,
        reason: `Refusing to run: "${invocation.target.slug}" is not a valid page slug.`,
      };
    }

    return {
      ok: true,
      args: [
        "tsx",
        "packages/generator/src/refresh-page.cli.ts",
        "--project-id",
        projectId,
        "--slug",
        invocation.target.slug,
        "--locale",
        locale.data,
      ],
      env: { ...env, STATICFORGE_FEEDBACK: invocation.target.feedback },
    };
  }

  // Every slug is parsed before it travels, exactly as the refresh target is.
  // These come from a column this engine wrote, which is a reason to expect
  // them to be valid and not a reason to skip checking: the row is reachable by
  // anything holding a database credential, and a scope is a list of names this
  // process is about to hand to a child.
  const scope = invocation.onlySlugs ?? [];
  const invalid = scope.filter((slug) => !PageSlugSchema.safeParse(slug).success);

  if (invalid.length > 0) {
    return {
      ok: false,
      reason:
        `Refusing to run: the job's page scope contains ${invalid.length} ` +
        `invalid slug(s), starting with "${invalid[0] ?? ""}".`,
    };
  }

  if (scope.length > 0) {
    env[ONLY_SLUGS_ENV_VAR] = scope.join(",");
  }

  const args =
    invocation.kind === "BUILD"
      ? ["tsx", "packages/cli/src/cli.ts", "build", "--locale", locale.data]
      : [
          "tsx",
          "packages/generator/src/generate-pages.cli.ts",
          "--locale",
          locale.data,
        ];

  args.push("--project-id", projectId);

  return { ok: true, args, env };
}

/**
 * Run the engine for one job and report what it printed.
 *
 * Never rejects: a non-zero exit is a *result* the job row records, not an
 * exception. The operator reads the log either way.
 */
export function runEngine(invocation: EngineInvocation): Promise<EngineResult> {
  const built = buildArgs(invocation);

  if (!built.ok) {
    return Promise.resolve(refuse(built.reason));
  }

  const timeoutMs = computeCommandTimeoutMs({
    pageCount: invocation.pageCount,
    aiEnabled: process.env.USE_AI_GENERATION === "true",
  });

  const started = Date.now();

  return new Promise<EngineResult>((resolveRun) => {
    let output = "";
    let settled = false;

    const child: ChildProcessWithoutNullStreams = spawn("npx", built.args, {
      cwd: invocation.repoRoot,
      env: {
        ...process.env,
        ...built.env,
        STATICFORGE_REPO_ROOT: invocation.repoRoot,
        // A build command, run as a build command: `development` switches the
        // Prisma client to query logging, burying the engine's own output.
        NODE_ENV: "production",
      },
      // Windows resolves npx through the shell; without this, spawn fails with
      // ENOENT rather than running anything.
      shell: process.platform === "win32",
      // Elsewhere, give the child its own process group so the whole tree can
      // be signalled at once.
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
      if (output.length > MAX_OUTPUT * 2) {
        output = output.slice(-MAX_OUTPUT);
      }
      invocation.onOutput?.(stripAnsi(output.slice(-MAX_OUTPUT)));
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
