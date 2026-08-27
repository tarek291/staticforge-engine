"use client";

import { useState, type ReactElement } from "react";

/**
 * The operator's two buttons.
 *
 * A client component, and the only one in the repository: the *generated* pages
 * still ship zero JavaScript. Interactivity here is confined to operator
 * tooling, where it costs nothing a visitor pays for.
 */

interface CommandResult {
  ok: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
  error?: string;
}

interface Props {
  projectId?: string;
  locale: string;
}

export function ControlPanel({ projectId, locale }: Props): ReactElement {
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);

  async function run(action: "generate" | "build"): Promise<void> {
    setRunning(action);
    setResult(null);

    try {
      const response = await fetch(`/api/dashboard/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, locale }),
      });

      setResult((await response.json()) as CommandResult);
    } catch (error: unknown) {
      // A network failure here is the dev server dying mid-build, which is
      // worth showing rather than swallowing into a stuck spinner.
      setResult({
        ok: false,
        exitCode: -1,
        durationMs: 0,
        output: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRunning(null);
    }
  }

  const busy = running !== null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run("generate")}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-neutral-900"
        >
          {running === "generate" ? "Generating…" : "Generate pages"}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => void run("build")}
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-neutral-700"
        >
          {running === "build" ? "Building…" : "Generate + validate + build"}
        </button>

        {busy && (
          <span className="text-sm text-neutral-500">
            Running on the host. A full build takes a minute.
          </span>
        )}
      </div>

      {result !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            <span
              className={
                result.ok
                  ? "font-medium text-emerald-600 dark:text-emerald-400"
                  : "font-medium text-red-600 dark:text-red-400"
              }
            >
              {result.ok ? "✓ Succeeded" : `✗ Failed (exit ${result.exitCode})`}
            </span>
            {result.durationMs > 0 && (
              <span className="text-neutral-500">
                {" "}
                in {(result.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </p>

          <pre className="max-h-96 overflow-auto rounded-md bg-neutral-100 p-4 text-xs leading-relaxed dark:bg-neutral-900">
            {result.error ?? result.output ?? "(no output)"}
          </pre>

          {result.ok && (
            <p className="text-sm text-neutral-500">
              Reload to see the updated pages.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
