import type { Location, Service } from "@staticforge/schemas";

/**
 * Bringing outside data in.
 *
 * A tenant's services and locations live somewhere before they live here: a
 * spreadsheet, a CRM, a field-service tool, a form. Each of those speaks its
 * own shape, and none of them speak ours. The tempting response is a function
 * per integration, each reaching all the way from "fetch a URL" to "write a
 * row" — and every one of them re-deciding what a valid service is.
 *
 * So the boundary is drawn in one place instead. An adapter's whole
 * responsibility is *shape*: take one source's native form and produce the
 * engine's entities, or say precisely why it cannot. It does no I/O, touches no
 * database, and decides nothing about what to do with the result. Fetching is
 * the caller's problem; persisting and diffing belong to the sync layer.
 *
 * That split is what keeps a new source cheap. Adding one is writing a parser
 * and a test for it — not another path to the database that has to be audited
 * for tenant scoping all over again.
 *
 * ## Why the result is collected rather than thrown
 *
 * A sheet with forty bad rows should be corrected in one pass. Every adapter
 * therefore reports *every* problem it found, addressed well enough to fix —
 * the same collect-then-report contract the CSV importer and the generator's
 * validation already use.
 */

/** One problem with the incoming data, addressed well enough to fix. */
export interface SyncIssue {
  /** Where the problem is: a row number, a JSON path, a field name. */
  path: string;
  message: string;
}

/**
 * The engine's entities, as an adapter produces them.
 *
 * Every collection is optional, and absent means "this source did not say" —
 * which is not the same as "this source said none". A sheet listing only
 * locations must not be read as an instruction to delete every service.
 */
export interface SyncPayload {
  services?: Service[] | undefined;
  locations?: Location[] | undefined;
}

/** What an adapter produced, or why it could not. */
export type SyncParseResult =
  | { ok: true; payload: SyncPayload }
  | { ok: false; issues: SyncIssue[] };

/**
 * Turns one external format into the engine's entities.
 *
 * @typeParam TRaw - What this source hands over: CSV text, a parsed JSON body,
 * an API response.
 */
export interface DataSyncAdapter<TRaw = unknown> {
  /** Stable identifier, recorded on a sync so an operator can see its origin. */
  readonly id: string;
  /** One line, for a CLI listing or an error message. */
  readonly description: string;
  /**
   * Convert this source's data into engine entities.
   *
   * Must not throw for bad *data* — that is what the issue list is for. Throwing
   * is reserved for a caller error, such as being handed something that is not
   * this adapter's format at all.
   */
  parse(raw: TRaw): SyncParseResult;
}

/** Build the failing result from a single problem, which is the common case. */
export function syncFailure(path: string, message: string): SyncParseResult {
  return { ok: false, issues: [{ path, message }] };
}
