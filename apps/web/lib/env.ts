import { z } from "zod";

/**
 * The environment this server refuses to run without.
 *
 * ## Why a schema and not `process.env.X ?? throw`
 *
 * The same reason every other boundary in this engine is validated: a missing
 * variable and a *wrong* one fail differently, and only the first is obvious. A
 * `SUPABASE_URL` set to the database connection string, or an anon key still
 * holding the placeholder from `.env.example`, both satisfy "is defined" and
 * neither works — and the failure surfaces as an authentication that quietly
 * rejects every user rather than as a configuration error anyone can act on.
 *
 * ## Why it is checked on first use rather than at import
 *
 * `next build` imports every module in the graph. Validating at import time
 * would make the build itself require production credentials, so a CI run — or
 * anyone cloning the repository — could not build the site without a Supabase
 * project. The check therefore runs when a request first needs the values, and
 * fails that request loudly with a message naming the variable.
 *
 * That is a real difference from "the server will not boot": a misconfigured
 * deployment starts, and then refuses every authenticated request. It is
 * refused rather than allowed, which is the direction that matters, and the
 * error says exactly what is missing.
 */

/**
 * Placeholders that are present but mean nothing.
 *
 * `.env.example` exists to be copied, and the copy that keeps its placeholder
 * is the configuration mistake this catches. Treating one as a real value would
 * build a Supabase client pointed at nowhere, which fails later and further
 * away than here.
 */
const PLACEHOLDERS = new Set([
  "https://your-project.supabase.co",
  "your-anon-key",
  "changeme",
  "todo",
]);

/** Whether a value is real rather than copied out of the example file. */
function isRealValue(value: string): boolean {
  return value.trim() !== "" && !PLACEHOLDERS.has(value.trim().toLowerCase());
}

/**
 * Whether a URL names a web origin rather than something else entirely.
 *
 * `z.string().url()` accepts any scheme, so `postgres://…` passes it — and the
 * one wrong value an operator is genuinely likely to paste here is the database
 * connection string, which is sitting in the same file. A scheme check turns
 * that from an authentication that rejects everyone into a configuration error
 * naming the variable.
 */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);

    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** What the authenticated surface needs. */
export const ServerEnvSchema = z.object({
  SUPABASE_URL: z
    .string()
    .refine(
      isHttpUrl,
      "SUPABASE_URL must be an http(s) URL, e.g. https://<project>.supabase.co " +
        "— not the database connection string",
    )
    .refine(isRealValue, "SUPABASE_URL still holds the placeholder from .env.example"),
  SUPABASE_ANON_KEY: z
    .string()
    .min(1, "SUPABASE_ANON_KEY is required")
    .refine(
      isRealValue,
      "SUPABASE_ANON_KEY still holds the placeholder from .env.example",
    ),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

/** Raised when the server is running without the configuration it needs. */
export class ServerEnvError extends Error {
  override readonly name = "ServerEnvError";

  /** One line per problem, so a misconfiguration is fixed in a single pass. */
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `The server is missing required configuration:\n  - ${issues.join("\n  - ")}\n\n` +
        `Copy .env.example to .env and fill in the real values.`,
    );
    this.issues = issues;
  }
}

/**
 * Read and validate the server environment.
 *
 * Every problem at once, not one per attempt: an operator fixing a deployment
 * should need one round trip rather than one per variable.
 *
 * @param env - Injected so this is testable without touching the process.
 * @throws {ServerEnvError} When anything required is missing or is a placeholder.
 */
export function readServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const parsed = ServerEnvSchema.safeParse({
    SUPABASE_URL: env["SUPABASE_URL"],
    SUPABASE_ANON_KEY: env["SUPABASE_ANON_KEY"],
  });

  if (!parsed.success) {
    throw new ServerEnvError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(env)"}: ${issue.message}`,
      ),
    );
  }

  return parsed.data;
}
