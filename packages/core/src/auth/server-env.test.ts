import { describe, expect, test } from "vitest";
import { z } from "zod";

/**
 * The server-environment contract, tested here rather than in `apps/web`.
 *
 * The schema itself lives with the app that needs it, but the app has no test
 * runner — and a validation rule with no test is a validation rule that gets
 * relaxed the first time it is inconvenient. So the rules are restated here
 * against the same schema shape, which is the honest compromise: it proves the
 * rules are the ones intended, and it does not pretend to import the app.
 *
 * The specific rule worth pinning is the placeholder check. "Is it defined" is
 * satisfied by a value copied straight out of `.env.example`, and that copy is
 * the configuration mistake that actually happens — a Supabase client pointed
 * at `your-project` fails much further from the cause than this does.
 */

const PLACEHOLDERS = new Set([
  "https://your-project.supabase.co",
  "your-anon-key",
  "changeme",
  "todo",
]);

function isRealValue(value: string): boolean {
  return value.trim() !== "" && !PLACEHOLDERS.has(value.trim().toLowerCase());
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);

    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

const ServerEnvSchema = z.object({
  SUPABASE_URL: z.string().refine(isHttpUrl).refine(isRealValue),
  SUPABASE_ANON_KEY: z.string().min(1).refine(isRealValue),
});

const REAL = {
  SUPABASE_URL: "https://ngeabiskvsxussfilxcv.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.real.key",
};

describe("a configured server passes", () => {
  test("real values are accepted", () => {
    expect(ServerEnvSchema.safeParse(REAL).success).toBe(true);
  });
});

describe("an unconfigured server does not", () => {
  test("a missing url is refused", () => {
    expect(
      ServerEnvSchema.safeParse({ ...REAL, SUPABASE_URL: undefined }).success,
    ).toBe(false);
  });

  test("a missing key is refused", () => {
    expect(
      ServerEnvSchema.safeParse({ ...REAL, SUPABASE_ANON_KEY: undefined }).success,
    ).toBe(false);
  });

  test("an empty key is refused", () => {
    expect(ServerEnvSchema.safeParse({ ...REAL, SUPABASE_ANON_KEY: "" }).success).toBe(
      false,
    );
  });

  test("a url that is not a web origin is refused", () => {
    // `z.string().url()` alone accepts any scheme, so the database connection
    // string — sitting in the same file, and the one wrong value an operator is
    // genuinely likely to paste — would pass it.
    expect(
      ServerEnvSchema.safeParse({
        ...REAL,
        SUPABASE_URL: "postgres://user:pw@db.supabase.co:5432/postgres",
      }).success,
    ).toBe(false);
  });

  test("something that is not a URL at all is refused", () => {
    expect(
      ServerEnvSchema.safeParse({ ...REAL, SUPABASE_URL: "not a url" }).success,
    ).toBe(false);
  });
});

describe("a placeholder is present and still wrong", () => {
  test("the example url is refused", () => {
    expect(
      ServerEnvSchema.safeParse({
        ...REAL,
        SUPABASE_URL: "https://your-project.supabase.co",
      }).success,
    ).toBe(false);
  });

  test("the example key is refused", () => {
    expect(
      ServerEnvSchema.safeParse({ ...REAL, SUPABASE_ANON_KEY: "your-anon-key" }).success,
    ).toBe(false);
  });

  test("common stand-ins are refused whatever their case", () => {
    for (const value of ["changeme", "CHANGEME", "TODO", "  todo  "]) {
      expect(
        ServerEnvSchema.safeParse({ ...REAL, SUPABASE_ANON_KEY: value }).success,
      ).toBe(false);
    }
  });

  test("every problem is reported at once", () => {
    const result = ServerEnvSchema.safeParse({
      SUPABASE_URL: "your-project",
      SUPABASE_ANON_KEY: "",
    });

    // An operator fixing a deployment should need one round trip, not one per
    // variable — the same reason the CSV importer collects issues across a
    // whole sheet.
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues.length).toBeGreaterThan(1);
  });
});
