import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { resolve } from "node:path";

/**
 * Runs an engine command on the host and returns what it printed.
 *
 * The dashboard does not reimplement the pipeline; it invokes the same commands
 * an operator would type. That is the whole design: one implementation, one set
 * of guarantees, and a button that cannot drift from the command it claims to
 * run.
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

/** Longest a command may run before it is killed, in milliseconds. */
const TIMEOUT_MS = 10 * 60 * 1000;

/** Most output to keep, in characters. A full build log is megabytes. */
const MAX_OUTPUT = 60_000;

/** SGR colour sequences, which render as garbage inside a `<pre>`. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
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
      child.kill();
      output += `\n\nTimed out after ${TIMEOUT_MS / 1000}s and was killed.`;
      finish(124);
    }, TIMEOUT_MS);

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

/** Run the generator for a project, or for the local files when none is given. */
export function runGenerate(
  projectId: string | undefined,
  locale: string,
  onOutput?: (output: string) => void,
): Promise<CommandResult> {
  const args = [
    "tsx",
    "packages/generator/src/generate-pages.cli.ts",
    "--locale",
    locale,
  ];

  if (projectId !== undefined) {
    args.push("--project-id", projectId);
  }

  return runCommand("npx", args, {}, onOutput);
}

/** Run the full deploy pipeline: generate, validate, build. */
export function runPipeline(
  projectId: string | undefined,
  locale: string,
  onOutput?: (output: string) => void,
): Promise<CommandResult> {
  const args = ["tsx", "packages/cli/src/cli.ts", "build", "--locale", locale];

  if (projectId !== undefined) {
    args.push("--project-id", projectId);
  }

  return runCommand("npx", args, {}, onOutput);
}
