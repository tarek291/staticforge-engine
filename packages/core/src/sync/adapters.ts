import { LocationSchema, ServiceSchema } from "@staticforge/schemas";
import { z } from "zod";

import { CsvImportError, parseCsvSheet } from "../csv-importer.js";
import {
  syncFailure,
  type DataSyncAdapter,
  type SyncIssue,
  type SyncParseResult,
} from "./adapter.js";

/**
 * The two adapters the engine ships.
 *
 * Both reduce to the same thing — the entity schemas — because the schemas are
 * what "valid" means here. An adapter that validated its own way would be a
 * second definition of a service, and the two would drift the first time one
 * was relaxed.
 */

/**
 * A published spreadsheet, as CSV.
 *
 * The format a non-technical operator already has. Google Sheets, Excel and
 * Numbers all publish it, so onboarding a client with forty locations is a
 * share link rather than a data-entry project.
 *
 * Delegates to the same parser the local `import:csv` command uses. A sheet
 * fetched over HTTP and a sheet on disk are the same sheet, and accepting one
 * while rejecting the other would be a bug an operator could not diagnose.
 */
export const csvSyncAdapter: DataSyncAdapter<string> = {
  id: "csv",
  description: "A published spreadsheet (Google Sheets, Excel) exported as CSV.",

  parse(raw: string): SyncParseResult {
    if (raw.trim().length === 0) {
      return syncFailure(
        "(document)",
        "The sheet is empty. A published Google Sheet that has not finished " +
          "publishing returns an empty body rather than an error.",
      );
    }

    try {
      const { services, locations } = parseCsvSheet(raw, "(remote sheet)");

      if (services.length === 0 && locations.length === 0) {
        // Nothing recognisable, and this is the dangerous case rather than a
        // harmless one. A Google Sheet that was shared but never *published*
        // returns an HTML sign-in page; the CSV parser reads that as a header
        // with no rows and reports no issues at all. Handed on as data, it is
        // an instruction to delete every service and location the tenant has,
        // and the change detector would faithfully agree that is a change.
        //
        // Clearing a project is a real thing to want, but it should be asked
        // for explicitly — not arrived at by a URL that quietly stopped working.
        return syncFailure(
          "(document)",
          "No service or location rows found. Check that the sheet is " +
            'published to the web and has a "type" column containing ' +
            '"service" or "location" — an unpublished sheet returns a sign-in ' +
            "page, which reads as an empty sheet.",
        );
      }

      return { ok: true, payload: { services, locations } };
    } catch (error: unknown) {
      if (error instanceof CsvImportError) {
        return {
          ok: false,
          issues: error.issues.map((issue) => ({
            // Row and column, as a spreadsheet shows them, so an operator can
            // click straight to the cell.
            path: `row ${issue.row}, column "${issue.column}"`,
            message: issue.message,
          })),
        };
      }

      // Not a CSV at all — an HTML sign-in page from a sheet that was never
      // actually published is the usual cause, and it is worth saying so.
      return syncFailure(
        "(document)",
        `Could not read this as CSV: ${
          error instanceof Error ? error.message : String(error)
        }. A sheet that is not published returns a sign-in page rather than data.`,
      );
    }
  },
};

/**
 * The body shape a webhook may send.
 *
 * Both collections are optional and treated as "not mentioned" when absent, so
 * a caller that only manages locations cannot accidentally clear every service
 * by omitting them. Unknown keys are rejected rather than ignored: a caller
 * sending `location` instead of `locations` should be told, not silently
 * treated as having sent nothing.
 */
export const SyncBodySchema = z
  .object({
    services: z.array(ServiceSchema).optional(),
    locations: z.array(LocationSchema).optional(),
  })
  .strict();

/**
 * A JSON body, as a webhook delivers it.
 *
 * The push counterpart to the CSV pull: a system that already knows when its
 * data changed tells the engine, rather than the engine asking on a timer.
 */
export const jsonSyncAdapter: DataSyncAdapter<unknown> = {
  id: "json",
  description: "A JSON body of services and locations, as a webhook delivers it.",

  parse(raw: unknown): SyncParseResult {
    const parsed = SyncBodySchema.safeParse(raw);

    if (!parsed.success) {
      const issues: SyncIssue[] = parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      }));

      return { ok: false, issues };
    }

    if (parsed.data.services === undefined && parsed.data.locations === undefined) {
      // An empty object parses cleanly and means nothing. Accepting it would
      // report a successful sync that changed nothing, which reads as "your
      // data is already current" rather than "you sent no data".
      return syncFailure(
        "(root)",
        'Nothing to sync: send at least one of "services" or "locations".',
      );
    }

    return {
      ok: true,
      payload: {
        ...(parsed.data.services !== undefined
          ? { services: parsed.data.services }
          : {}),
        ...(parsed.data.locations !== undefined
          ? { locations: parsed.data.locations }
          : {}),
      },
    };
  },
};

/** Every adapter the engine ships, by id. */
export const SYNC_ADAPTERS: Record<string, DataSyncAdapter<never>> = {
  [csvSyncAdapter.id]: csvSyncAdapter as DataSyncAdapter<never>,
  [jsonSyncAdapter.id]: jsonSyncAdapter as DataSyncAdapter<never>,
};

/**
 * Look up an adapter by id.
 *
 * `Object.hasOwn`, not a bare index: the registry is an object literal and
 * inherits `Object.prototype`, so "constructor" would resolve to a function and
 * pass an `=== undefined` check meant to reject it.
 */
export function findSyncAdapter(id: string): DataSyncAdapter<never> | undefined {
  return Object.hasOwn(SYNC_ADAPTERS, id) ? SYNC_ADAPTERS[id] : undefined;
}
