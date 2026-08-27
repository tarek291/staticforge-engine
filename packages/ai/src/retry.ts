import { sleep } from "@staticforge/core";

/**
 * Retry policy for provider calls.
 *
 * Only transport failures are retried. A rejected page is a *result*, not an
 * outage, so content that violates the contract is never retried here — that
 * decision belongs to the caller and costs another paid call.
 */

/** HTTP statuses worth trying again. */
const RETRYABLE_STATUSES = new Set([
  408, // request timeout
  409, // conflict
  429, // rate limited
  500, // internal error
  502,
  503,
  504,
  529, // overloaded
]);

/** What a failure means for retry purposes. */
export interface ErrorClassification {
  retryable: boolean;
  /** HTTP status, when the failure carried one. */
  status: number | undefined;
  /** Delay the provider asked for, in milliseconds. */
  retryAfterMs: number | undefined;
}

/** Read a numeric `status` off an unknown error, if it has one. */
function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Read a `retry-after` header, in milliseconds.
 *
 * The header is expressed in seconds. Header bags arrive either as a plain
 * object or as a `Headers` instance depending on the runtime, so both are
 * handled.
 */
function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const headers = (error as { headers?: unknown }).headers;
  if (headers === undefined || headers === null) {
    return undefined;
  }

  const raw =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("retry-after")
      : (headers as Record<string, unknown>)["retry-after"];

  if (typeof raw !== "string" && typeof raw !== "number") {
    return undefined;
  }

  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * Decide whether a failure is worth another attempt.
 *
 * Classifies by HTTP status rather than by error class name, so it behaves the
 * same against the real SDK and against a test double. A failure with no status
 * at all is treated as a transport problem — that is what a DNS failure, a
 * socket reset, or an aborted request looks like.
 */
export function classifyError(error: unknown): ErrorClassification {
  const status = readStatus(error);
  const retryAfterMs = readRetryAfterMs(error);

  if (status !== undefined) {
    return {
      retryable: RETRYABLE_STATUSES.has(status) || status >= 500,
      status,
      retryAfterMs,
    };
  }

  // No status: the request never got an HTTP answer.
  return { retryable: true, status: undefined, retryAfterMs };
}

/** Reported before each retry, for progress output. */
export interface RetryAttempt {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** Attempts that will be made in total, at most. */
  maxAttempts: number;
  delayMs: number;
  status: number | undefined;
  error: unknown;
}

/** Knobs for {@link withRetry}. */
export interface RetryOptions {
  /** Retries *after* the first attempt. Default 3, so 4 attempts at most. */
  maxRetries?: number;
  /** First backoff step, doubled each retry. Default 1000ms. */
  baseDelayMs?: number;
  /** Ceiling for a single wait. Default 30000ms. */
  maxDelayMs?: number;
  /** Called before each wait. */
  onRetry?: (attempt: RetryAttempt) => void;
  /** Injected for tests, so a suite never waits in real time. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injected for tests, so jitter is deterministic. */
  random?: () => number;
}

/** Exponential backoff with full jitter, capped, honouring `retry-after`. */
export function computeDelayMs(
  attempt: number,
  options: Required<Pick<RetryOptions, "baseDelayMs" | "maxDelayMs">> & {
    retryAfterMs: number | undefined;
    random: () => number;
  },
): number {
  // The provider knows better than the formula.
  if (options.retryAfterMs !== undefined) {
    return Math.min(options.retryAfterMs, options.maxDelayMs);
  }

  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, options.maxDelayMs);

  // Full jitter: spread retries so a fleet of workers does not synchronise
  // into a thundering herd against a provider that is already struggling.
  return Math.round(capped * (0.5 + options.random() * 0.5));
}

/** Outcome of a run that exhausted its budget. */
export class RetryExhaustedError extends Error {
  override readonly name = "RetryExhaustedError";

  constructor(
    readonly attempts: number,
    readonly status: number | undefined,
    override readonly cause: unknown,
  ) {
    super(`Gave up after ${attempts} attempt(s).`);
  }
}

/**
 * Run an operation, retrying transport failures with backoff.
 *
 * Non-retryable failures are rethrown untouched and immediately — there is
 * nothing to gain from waiting on a 401.
 *
 * @param operation - The call to attempt. Receives the 1-based attempt number.
 * @param options - Retry policy.
 * @returns The operation's result.
 * @throws {RetryExhaustedError} When every attempt failed with a retryable error.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30_000,
    onRetry,
    sleepFn = sleep,
    random = Math.random,
  } = options;

  const maxAttempts = maxRetries + 1;
  let lastError: unknown;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      const { retryable, status, retryAfterMs } = classifyError(error);

      lastError = error;
      lastStatus = status;

      if (!retryable) {
        throw error;
      }

      if (attempt === maxAttempts) {
        break;
      }

      const delayMs = computeDelayMs(attempt, {
        baseDelayMs,
        maxDelayMs,
        retryAfterMs,
        random,
      });

      onRetry?.({ attempt, maxAttempts, delayMs, status, error });

      await sleepFn(delayMs);
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastStatus, lastError);
}
