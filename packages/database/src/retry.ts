/**
 * Retrying transient database failures.
 *
 * The engine now talks to a hosted PostgreSQL over the public internet, which
 * makes a class of failure ordinary that was previously impossible: the pooler
 * recycling a connection, a brief DNS or TLS hiccup, a pool exhausted for a
 * second under load. None of those mean the query was wrong, and none of them
 * should surface to an operator as a failed generation run.
 *
 * ## What is deliberately *not* retried
 *
 * Everything that is an answer rather than an outage. A unique-constraint
 * violation, a missing record, a validation error and a failed ownership check
 * are all *results* — the query reached the database and the database replied.
 * Retrying them would turn one clear refusal into four identical ones and hide
 * the reason behind a delay.
 *
 * The same split the AI package draws between a transport failure and rejected
 * content, applied to a different boundary. The two are kept separate rather
 * than shared because they classify different things: one reads HTTP statuses,
 * this one reads Prisma error codes, and a single abstraction over both would
 * be a parameter bag with nothing left in common.
 *
 * ## Why every wrapped call is safe to repeat
 *
 * A retry re-runs the operation from the start. That is only sound when the
 * operation is idempotent or atomic, so the wrapper is applied to reads, to
 * writes that set a value rather than accumulate one, and to transactions —
 * which roll back whole, leaving nothing for the second attempt to collide
 * with. It is not applied to anything that appends.
 */

/**
 * Wait, locally.
 *
 * `@staticforge/core` has this, but importing it would make the persistence
 * package depend on the utility package for one line — a package edge is a
 * lasting cost and this is not a lasting saving.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Prisma error codes worth another attempt.
 *
 * All connection-layer: reaching the server, holding the connection, or getting
 * a slot from the pool. Nothing here describes the query itself.
 */
const RETRYABLE_CODES = new Set([
  "P1000", // authentication failed — transient during a credential rotation
  "P1001", // can't reach database server
  "P1002", // server reached but timed out
  "P1008", // operation timed out
  "P1011", // TLS error
  "P1017", // server closed the connection
  "P2024", // timed out fetching a connection from the pool
  "P2028", // transaction API error, typically a dropped connection mid-transaction
]);

/** Read a Prisma error code off an unknown thrown value. */
function readCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === "string" ? code : undefined;
}

/**
 * Whether a failure is worth waiting on.
 *
 * A Prisma error with no code at all is an initialisation failure — the client
 * could not construct a connection — which is exactly the case a retry exists
 * for. A plain `Error` with no code is not: it came from this codebase.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  const code = readCode(error);

  if (code !== undefined) {
    return RETRYABLE_CODES.has(code);
  }

  const name = (error as { name?: unknown })?.name;

  return name === "PrismaClientInitializationError";
}

/** Knobs for {@link withDbRetry}. */
export interface DbRetryOptions {
  /** Retries *after* the first attempt. Default 3, so 4 attempts at most. */
  maxRetries?: number;
  /** First backoff step, doubled each retry. Default 250ms. */
  baseDelayMs?: number;
  /** Ceiling for a single wait. Default 5000ms. */
  maxDelayMs?: number;
  /** Called before each wait, for progress output. */
  onRetry?: (attempt: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    code: string | undefined;
    error: unknown;
  }) => void;
  /** Injected for tests, so a suite never waits in real time. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injected for tests, so jitter is deterministic. */
  random?: () => number;
}

/**
 * Run a database operation, retrying transient connection failures.
 *
 * Backoff is exponential with full jitter and a ceiling. The jitter matters
 * more here than the exponent: when a pooler drops connections it drops many at
 * once, and a fleet retrying on the same schedule reconverges into the same
 * spike it is recovering from.
 *
 * A non-transient failure is rethrown untouched and immediately — there is
 * nothing to gain from waiting on a constraint violation.
 *
 * @param operation - The call to attempt. Receives the 1-based attempt number.
 * @param options - Retry policy.
 * @returns The operation's result.
 * @throws The last error, once the budget is exhausted or the failure is not
 * transient. The original error is preserved rather than wrapped: a caller
 * matching on a Prisma code must still be able to.
 */
export async function withDbRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: DbRetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 250,
    maxDelayMs = 5_000,
    onRetry,
    sleepFn = sleep,
    random = Math.random,
  } = options;

  const maxAttempts = maxRetries + 1;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      if (attempt >= maxAttempts || !isTransientDatabaseError(error)) {
        throw error;
      }

      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const capped = Math.min(exponential, maxDelayMs);
      // Full jitter: a pooler drops many connections at once, and a fleet
      // retrying on one schedule reconverges into the spike it is recovering
      // from.
      const delayMs = Math.round(capped * (0.5 + random() * 0.5));

      onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        code: readCode(error),
        error,
      });

      await sleepFn(delayMs);
    }
  }
}
