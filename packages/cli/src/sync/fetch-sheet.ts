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
 * ## Why this check exists
 *
 * A URL supplied by an operator is fetched *by the server*, from wherever the
 * server sits. That is the shape of a server-side request forgery: an address
 * pointing at `localhost`, at a private range, or at a cloud metadata endpoint
 * asks this process to read something the caller could not reach themselves and
 * hand back the contents.
 *
 * Today this command is operator-run from a terminal, so the caller and the
 * process are the same person and the check buys little. It is here because
 * that stops being true the moment a "sync from a URL" field appears on the
 * dashboard, and a guard added before the field exists is a guard nobody has to
 * remember to add.
 *
 * The check is hostname-based and therefore not complete: a hostname that
 * resolves to a private address passes it, and closing that needs resolution
 * before connection. This refuses the direct cases and does not pretend to be
 * more.
 */
export function isFetchableUrl(raw: string): FetchFailure | { ok: true; url: URL } {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `"${raw}" is not a URL.` };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      message: `Refusing ${url.protocol} — only http and https are fetched.`,
    };
  }

  const host = url.hostname.toLowerCase();

  const private_ =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host === "::1";

  if (private_) {
    return {
      ok: false,
      message:
        `Refusing to fetch "${host}": it is a loopback or private address. ` +
        `A sync URL is fetched by the server, so pointing one inward is how an ` +
        `internal service gets read out through this command.`,
    };
  }

  return { ok: true, url };
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
