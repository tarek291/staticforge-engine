import type { StaticForgePlugin } from "./plugin.js";

/**
 * A plugin that writes an audit line for every lifecycle event.
 *
 * The proof that the extension points are real, and the first thing an operator
 * running this engine for someone else actually needs: a record of what ran,
 * for which project, whether it succeeded, and what a sync changed — separate
 * from the job log, which is per-run and gets trimmed.
 *
 * It is also deliberately the *simplest* useful plugin. It takes a sink and
 * closes over it; it holds no client, no credential and no database handle,
 * because the plugin contract hands it none. Anything more ambitious — an
 * outbound webhook, a metrics counter — is the same shape with a different
 * sink, and can be written without touching the engine.
 */

/** Where an audit line goes. Injected, so a test needs no filesystem. */
export type AuditSink = (line: string) => void;

/** Options for {@link createAuditLoggerPlugin}. */
export interface AuditLoggerOptions {
  /** Where lines go. Defaults to stdout. */
  sink?: AuditSink;
  /**
   * Emit one JSON object per line rather than prose.
   *
   * On by default: these lines are read by `jq` and log shippers far more often
   * than by people, and a format that has to be re-parsed later is a format
   * that will be parsed wrong.
   */
  json?: boolean;
  /** Injected so a test does not assert on the wall clock. */
  now?: () => Date;
}

/** Render a payload as one line. */
function render(
  event: string,
  payload: Record<string, unknown>,
  json: boolean,
  at: string,
): string {
  if (json) {
    return JSON.stringify({ audit: event, at, ...payload });
  }

  const fields = Object.entries(payload)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");

  return `[audit ${at}] ${event} ${fields}`;
}

/**
 * Build the audit logger.
 *
 * @param options - Sink, format and clock.
 */
export function createAuditLoggerPlugin(
  options: AuditLoggerOptions = {},
): StaticForgePlugin {
  const {
    sink = (line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
    },
    json = true,
    now = () => new Date(),
  } = options;

  const write = (event: string, payload: Record<string, unknown>): void => {
    sink(render(event, payload, json, now().toISOString()));
  };

  return {
    name: "audit-logger",
    description: "Writes one audit line per lifecycle event.",

    setup(hooks) {
      hooks.on("afterJobCompleted", (payload) => {
        write("job.completed", {
          jobId: payload.jobId,
          projectId: payload.projectId,
          kind: payload.kind,
          ok: payload.ok,
          exitCode: payload.exitCode,
          resumed: payload.resumed,
          durationMs: payload.durationMs,
        });
      });

      hooks.on("afterProjectSync", (payload) => {
        write("project.synced", {
          projectId: payload.projectId,
          changed: payload.changed,
          jobId: payload.jobId,
          services: `+${payload.servicesAdded}~${payload.servicesUpdated}-${payload.servicesRemoved}`,
          locations: `+${payload.locationsAdded}~${payload.locationsUpdated}-${payload.locationsRemoved}`,
        });
      });

      hooks.on("afterPagesWritten", (payload) => {
        write("pages.written", {
          projectId: payload.projectId ?? "(local)",
          locale: payload.locale,
          pageCount: payload.pageCount,
          outputDir: payload.outputDir,
        });
      });
    },
  };
}

/** Whether the worker should install the audit logger. */
export const AUDIT_LOG_ENV_VAR = "STATICFORGE_AUDIT_LOG";

/**
 * Read the audit logger's opt-in.
 *
 * Strictly opt-in, and only the exact string `"true"`, matching how every other
 * switch in this engine behaves: a stray `=1` must not silently start writing a
 * second stream of output an operator did not ask for.
 */
export function isAuditLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AUDIT_LOG_ENV_VAR] === "true";
}
