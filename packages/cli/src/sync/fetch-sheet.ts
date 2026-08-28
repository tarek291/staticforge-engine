import { checkOutboundUrl } from "@staticforge/core";

/**
 * Fetching a sheet from a URL.
 *
 * Small, and deliberately suspicious of what it is given. A published Google
 * Sheet is the intended case, but the value in `--url` is an address this
 * process will connect to, and a few things follow from that which are much
 * cheaper to decide here than to discover later.
 */

/** Most sheet we will read, in bytes. */
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;

/** How long to wait for the whole response. */
export const FETCH_TIMEOUT_MS = 30_000;

/** What went wrong, when something did. */
export interface FetchFailure {
  ok: false;
  message: string;
}

export type FetchSheetResult = { ok: true; body: string } | FetchFailure;

/**
 * Whether this address is one we will fetch.
 *
 * The check itself lives in `@staticforge/core` because the build trigger asks
 * the same question about a deploy hook, and an SSRF guard that exists twice is
 * one relaxation away from existing once. Kept exported here under its original
 * name so the sync command reads as it always did.
 */
export function isFetchableUrl(raw: string): FetchFailure | { ok: true; url: URL } {
  return checkOutboundUrl(raw, "a sync URL");
}

/**
 * Fetch a sheet, or explain why not.
 *
 * Never throws: a bad URL, a dead host and a sign-in page are all ordinary
 * things for an operator to have typed, and each deserves a sentence rather
 * than a stack trace.
 *
 * @param raw - The URL to fetch.
 * @param fetchFn - Injected so the command is testable without a network.
 */
export async function fetchSheet(
  raw: string,
  fetchFn: typeof fetch = fetch,
): Promise<FetchSheetResult> {
  const checked = isFetchableUrl(raw);

  if (!checked.ok) {
    return checked;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const response = await fetchFn(checked.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "text/csv, text/plain;q=0.9, */*;q=0.1" },
    });

    if (!response.ok) {
      return {
        ok: false,
        message:
          `The sheet responded ${response.status} ${response.statusText}. ` +
          `A Google Sheet must be published to the web — sharing the edit link ` +
          `is not the same thing.`,
      };
    }

    // Checked before reading, so a wrong URL pointing at something enormous is
    // refused rather than pulled into memory first.
    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > MAX_SHEET_BYTES) {
      return {
        ok: false,
        message: `The sheet is ${declared} bytes, over the ${MAX_SHEET_BYTES} limit.`,
      };
    }

    const body = await response.text();

    if (body.length > MAX_SHEET_BYTES) {
      // A server that did not declare a length can still send too much.
      return {
        ok: false,
        message: `The sheet is over the ${MAX_SHEET_BYTES}-byte limit.`,
      };
    }

    return { ok: true, body };
  } catch (error: unknown) {
    const aborted = error instanceof Error && error.name === "AbortError";

    return {
      ok: false,
      message: aborted
        ? `The sheet did not respond within ${FETCH_TIMEOUT_MS / 1000}s.`
        : `Could not fetch the sheet: ${
            error instanceof Error ? error.message : String(error)
          }`,
    };
  } finally {
    clearTimeout(timer);
  }
}
