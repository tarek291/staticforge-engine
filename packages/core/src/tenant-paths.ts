import { join } from "node:path";
import { z } from "zod";

/**
 * Tenant identity as it crosses a *shell* and a *filesystem* boundary.
 *
 * A project id is not only a database key. It is spliced into an `argv` array
 * that goes through a shell on Windows, and it becomes a directory name on
 * disk. Both of those are places where an unvalidated string stops being data
 * and starts being syntax, so the format is pinned here, once, and every
 * boundary parses it rather than trusting it.
 *
 * The charset is deliberately narrower than "whatever cuid emits": no dots, no
 * separators, no shell metacharacters. A value that cannot express `..` cannot
 * escape an output directory, and a value that cannot express `&` cannot end a
 * command.
 */

/** A project id, as every boundary must see it before use. */
export const ProjectIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "Project id must be 1–64 characters of A–Z, a–z, 0–9, underscore or dash",
  );

/** Thrown when a value that will become a path segment or an argument is not one. */
export class UnsafeIdentifierError extends Error {
  override readonly name = "UnsafeIdentifierError";

  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(
      `Refusing to use ${field} "${value}": it is not a safe identifier ` +
        `(1–64 characters of A–Z, a–z, 0–9, underscore or dash).`,
    );
  }
}

/**
 * Parse a project id, or throw.
 *
 * Used at the two boundaries where a bad value is more than a failed lookup:
 * building a command line, and building a path.
 *
 * @param value - The candidate id.
 * @param field - Name used in the error, so an operator knows which input to fix.
 * @throws {UnsafeIdentifierError} When the value is not a safe identifier.
 */
export function assertSafeProjectId(
  value: string,
  field = "--project-id",
): string {
  const parsed = ProjectIdSchema.safeParse(value);

  if (!parsed.success) {
    throw new UnsafeIdentifierError(field, value);
  }

  return parsed.data;
}

/**
 * Where one run's static output lives.
 *
 * Local file mode keeps `data/output`, unchanged — it is one operator, one
 * site, and moving it would break every existing invocation and the web app's
 * own fallback path.
 *
 * A database run gets `data/output/<projectId>`. This is not tidiness: the
 * generator clears the pages directory before writing it, so two tenants
 * sharing one directory means one run deletes the other's site and the deployed
 * output is whoever finished last. Isolation is what makes concurrent runs
 * merely concurrent rather than destructive.
 *
 * The id is parsed rather than interpolated, so a value containing `..` cannot
 * walk out of the output tree.
 *
 * @param repoRoot - Monorepo root.
 * @param projectId - Database project, or `undefined` for local file mode.
 * @returns The absolute output directory for this run.
 * @throws {UnsafeIdentifierError} When `projectId` is not a safe identifier.
 */
export function resolveOutputDir(
  repoRoot: string,
  projectId: string | undefined,
): string {
  const base = join(repoRoot, "data", "output");

  return projectId === undefined
    ? base
    : join(base, assertSafeProjectId(projectId));
}
