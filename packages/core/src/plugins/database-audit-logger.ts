import type { StaticForgePlugin } from "./plugin.js";

/**
 * The audit trail, written to a table instead of to stdout.
 *
 * `audit-logger` writes a line per lifecycle event and is the right thing for
 * an operator tailing a process. It is the wrong thing for a customer asking
 * who ran a sync last Tuesday: a log is trimmed, rotated, and readable only by
 * whoever has shell access on the box that produced it.
 *
 * This plugin answers the second question. Same events, same isolation
 * guarantees, a row instead of a line.
 *
 * ## What it deliberately is not
 *
 * It is not a transactional guarantee. The record is written *after* the action
 * it describes, by a listener the bus is free to abandon — so a database that
 * is unreachable for the two seconds after a job finishes loses that entry, and
 * the failure is reported rather than fatal.
 *
 * That is a real limitation and it is a deliberate one. Making the trail
 * guaranteed would mean writing it inside the same transaction as the action,
 * which the plugin architecture cannot do and should not: a plugin able to fail
 * a run is a plugin able to abort a paid, hour-long build, and installing one
 * would then be a risk nobody should take. An enterprise buyer should be told
 * this plainly rather than discovering it from a gap.
 *
 * What the plugin *does* guarantee is that a failed write is loud. It throws,
 * so the bus records it against this plugin's name in the job log an operator
 * is already reading, instead of returning quietly and leaving a hole nobody
 * knows about.
 */

/** One thing worth remembering happened. */
export interface AuditRecord {
  /** A stable dotted name: `project.synced`, `job.completed`. */
  action: string;
  /** What it happened to — a project id, a job id. */
  resourceId: string;
  /** Who caused it. */
  userId: string;
  /** The organization it belongs to, or `null` for a run outside one. */
  organizationId: string | null;
  /** Everything else, flat. */
  details: Record<string, unknown>;
}

/**
 * Where a record goes.
 *
 * Injected, not constructed. The plugin contract hands a plugin no database
 * client, and this is why: what it may reach is decided by the composition root
 * in one place a reviewer can see, rather than by whatever the plugin decided
 * to import.
 */
export type AuditRecordWriter = (record: AuditRecord) => Promise<void>;

/** Options for {@link createDatabaseAuditLoggerPlugin}. */
export interface DatabaseAuditLoggerOptions {
  /** Where records go. */
  write: AuditRecordWriter;
  /**
   * Skip syncs that changed nothing.
   *
   * Off by default. A polling integration produces a "nothing changed" event
   * every few minutes and those rows do add up — but an audit trail exists to
   * answer "who touched this and when", and a sync that found nothing to do is
   * still someone's credential reaching this system. Volume is a retention
   * policy problem; completeness is not something to trade for it by default.
   */
  skipUnchangedSyncs?: boolean;
  /** Injected so a test does not assert against the wall clock. */
  now?: () => Date;
}

/** Actions this plugin writes. Stable: saved filters are built against them. */
export const AUDIT_ACTIONS = Object.freeze({
  projectSynced: "project.synced",
  jobCompleted: "job.completed",
});

/**
 * Build the database audit logger.
 *
 * @param options - The writer, and what to record.
 */
export function createDatabaseAuditLoggerPlugin(
  options: DatabaseAuditLoggerOptions,
): StaticForgePlugin {
  const { write, skipUnchangedSyncs = false } = options;

  return {
    name: "database-audit-logger",
    description: "Writes a row to the AuditLog table for each lifecycle event.",

    setup(hooks) {
      hooks.on("afterProjectSync", async (payload) => {
        if (skipUnchangedSyncs && !payload.changed) {
          return;
        }

        await write({
          action: AUDIT_ACTIONS.projectSynced,
          resourceId: payload.projectId,
          userId: payload.userId,
          organizationId: payload.organizationId,
          details: {
            changed: payload.changed,
            // The run it caused, so the trail links an input to its cost.
            jobId: payload.jobId,
            // Zero here with a jobId present means a full run; the distinction
            // is what makes a bill explicable after the fact.
            scopedPages: payload.scopedPages,
            servicesAdded: payload.servicesAdded,
            servicesUpdated: payload.servicesUpdated,
            servicesRemoved: payload.servicesRemoved,
            locationsAdded: payload.locationsAdded,
            locationsUpdated: payload.locationsUpdated,
            locationsRemoved: payload.locationsRemoved,
            syncedAt: payload.syncedAt,
          },
        });
      });

      hooks.on("afterJobCompleted", async (payload) => {
        // Failures are recorded, not only successes. "Nothing ran" and "it ran
        // and failed" are different answers to the same question, and only one
        // of them means somebody should look at a log.
        await write({
          action: AUDIT_ACTIONS.jobCompleted,
          resourceId: payload.jobId,
          userId: payload.userId,
          organizationId: payload.organizationId,
          details: {
            projectId: payload.projectId,
            kind: payload.kind,
            ok: payload.ok,
            exitCode: payload.exitCode,
            resumed: payload.resumed,
            durationMs: payload.durationMs,
            completedAt: payload.completedAt,
          },
        });
      });
    },
  };
}

/** Whether the worker should write its audit trail to the database. */
export const DATABASE_AUDIT_ENV_VAR = "STATICFORGE_AUDIT_DB";

/**
 * Read the database audit logger's opt-in.
 *
 * Strictly opt-in and only the exact string `"true"`, matching every other
 * switch in this engine. A stray `=1` must not silently start writing rows to
 * a customer's database.
 */
export function isDatabaseAuditEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[DATABASE_AUDIT_ENV_VAR] === "true";
}
