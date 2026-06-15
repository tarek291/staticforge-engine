/**
 * Thrown when an input file cannot be found on disk (e.g. ENOENT).
 * The offending path is included in the message for easier debugging.
 */
export class FileNotFoundError extends Error {
  public override readonly name = "FileNotFoundError";
  public readonly filePath: string;

  constructor(filePath: string, options?: ErrorOptions) {
    super(`Input file not found: ${filePath}`, options);
    this.filePath = filePath;
  }
}

/**
 * Thrown when a file's contents cannot be parsed as JSON.
 * The original parse error is preserved as `cause`.
 */
export class InvalidJsonError extends Error {
  public override readonly name = "InvalidJsonError";
  public readonly filePath: string;

  constructor(filePath: string, options?: ErrorOptions) {
    super(`Failed to parse JSON in file: ${filePath}`, options);
    this.filePath = filePath;
  }
}

/** A single validation problem with a human-readable path and message. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Thrown when input data fails schema validation.
 *
 * Carries every collected issue (validation never stops at the first error),
 * and builds a readable summary message. Raw `ZodError`s are mapped into
 * {@link ValidationIssue}s before construction and never leak out.
 */
export class ValidationError extends Error {
  public override readonly name = "ValidationError";
  public readonly entityType: string;
  public readonly issues: ValidationIssue[];

  constructor(
    entityType: string,
    issues: ValidationIssue[],
    options?: ErrorOptions,
  ) {
    const count = issues.length;
    const summary = issues
      .map((issue) => `  - ${issue.path}: ${issue.message}`)
      .join("\n");
    super(
      `Validation failed for "${entityType}" (${count} issue${count === 1 ? "" : "s"}):\n${summary}`,
      options,
    );
    this.entityType = entityType;
    this.issues = issues;
  }
}
