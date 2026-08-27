import type { ContentIssue } from "@staticforge/schemas";

/**
 * Typed failures from the generation service.
 *
 * Callers need to tell three situations apart, because the right response
 * differs in each: the provider was unreachable or busy (retry), the provider
 * answered but the answer is unusable (do not retry — a rejected page is a
 * result, not an outage), or the request itself is wrong (fix the code).
 */

/** Base class for every failure this package raises. */
export class AIGenerationError extends Error {
  override readonly name: string = "AIGenerationError";
}

/**
 * The provider could not be reached, or answered with a retryable status.
 *
 * Raised only after the retry budget is exhausted, so seeing this means the
 * failure survived every attempt.
 */
export class AITransportError extends AIGenerationError {
  override readonly name = "AITransportError";

  constructor(
    message: string,
    readonly attempts: number,
    /** HTTP status, when the failure carried one. */
    readonly status: number | undefined,
    override readonly cause: unknown,
  ) {
    super(`${message} (after ${attempts} attempt(s))`);
  }
}

/**
 * The request was rejected outright — a bad model id, a malformed tool schema,
 * a missing or unauthorized key. Retrying cannot help.
 */
export class AIRequestError extends AIGenerationError {
  override readonly name = "AIRequestError";

  constructor(
    message: string,
    readonly status: number | undefined,
    override readonly cause: unknown,
  ) {
    super(message);
  }
}

/**
 * The model answered without calling the tool it was required to call.
 *
 * Distinct from a contract violation: there is no content to judge at all.
 */
export class AIToolCallMissingError extends AIGenerationError {
  override readonly name = "AIToolCallMissingError";

  constructor(
    readonly toolName: string,
    readonly stopReason: string | null,
  ) {
    super(
      `Model did not call "${toolName}" (stop_reason: ${stopReason ?? "unknown"}).`,
    );
  }
}

/**
 * The model returned content that violates the contract.
 *
 * This is the separation of powers in one class: the model produced data, and
 * the engine refused it. Carries every issue found, addressed by field path.
 */
export class AIContentRejectedError extends AIGenerationError {
  override readonly name = "AIContentRejectedError";

  constructor(
    /**
     * Which gate rejected it: the structural schema, the quality profile, or
     * the verified record the content was checked against.
     */
    readonly stage: "schema" | "profile" | "grounding",
    readonly profileId: string,
    readonly issues: ContentIssue[],
  ) {
    super(
      `AI content rejected at the ${stage} gate ("${profileId}"): ` +
        `${issues.length} issue(s) — ${issues
          .slice(0, 3)
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}${issues.length > 3 ? " …" : ""}`,
    );
  }
}
