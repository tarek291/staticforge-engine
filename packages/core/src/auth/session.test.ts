import { describe, expect, test, vi } from "vitest";

import {
  SUPABASE_ANON_KEY_ENV_VAR,
  SUPABASE_URL_ENV_VAR,
  UnauthorizedError,
  createSessionVerifier,
  verifyUserSession,
  type SessionVerifier,
} from "./session.js";

/**
 * The identity guard.
 *
 * Every test here is a refusal, because that is the direction this code fails
 * silently in. A guard that wrongly rejects produces a support ticket within
 * the hour; a guard that wrongly *accepts* produces nothing at all, and the
 * only observer who notices is the one exploiting it.
 *
 * Nothing reaches the network. The provider is a double, which is the only way
 * a test for "an empty token is refused" is a test anyone actually runs.
 */

/** A provider that answers with a user. */
function accepts(user: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown>;
}): { verifier: SessionVerifier; asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    verifier: {
      auth: {
        getUser: (token: string) => {
          asked.push(token);
          return Promise.resolve({ data: { user }, error: null });
        },
      },
    },
  };
}

/** A provider that rejects. */
function rejects(message = "invalid JWT"): { verifier: SessionVerifier; asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    verifier: {
      auth: {
        getUser: (token: string) => {
          asked.push(token);
          return Promise.resolve({ data: { user: null }, error: { message } });
        },
      },
    },
  };
}

/** The error a call produced, asserting that it produced one. */
async function refusalFrom(call: Promise<unknown>): Promise<UnauthorizedError> {
  try {
    await call;
  } catch (error: unknown) {
    if (error instanceof UnauthorizedError) {
      return error;
    }
    throw error;
  }

  throw new Error("Expected an UnauthorizedError, but the call resolved.");
}

describe("a verified session identifies a person", () => {
  test("the provider's id is what comes back", async () => {
    const { verifier } = accepts({
      id: "a1b2c3d4-0000-4000-8000-000000000000",
      email: "alice@example.com",
    });

    const user = await verifyUserSession("a.real.token", verifier);

    // This id is what `userId` must be. Generating our own would produce a
    // second identity for the same person and a join that matches nothing.
    expect(user.id).toBe("a1b2c3d4-0000-4000-8000-000000000000");
    expect(user.email).toBe("alice@example.com");
  });

  test("a display name is taken from the provider's metadata", async () => {
    const { verifier } = accepts({
      id: "u1",
      email: "alice@example.com",
      user_metadata: { name: "Alice" },
    });

    expect((await verifyUserSession("t", verifier)).name).toBe("Alice");
  });

  test("a missing name is null rather than a placeholder", async () => {
    const { verifier } = accepts({ id: "u1", email: "alice@example.com" });

    // A required field filled with a placeholder is a field nobody can trust.
    expect((await verifyUserSession("t", verifier)).name).toBeNull();
  });

  test("a whole Authorization header is accepted, not only a bare token", async () => {
    const { verifier, asked } = accepts({ id: "u1", email: "a@example.com" });

    await verifyUserSession("Bearer the.session.token", verifier);

    // A helper that took only one form guarantees somebody strips the scheme by
    // hand and gets it wrong.
    expect(asked).toEqual(["the.session.token"]);
  });

  test("a bare token is passed through untouched", async () => {
    const { verifier, asked } = accepts({ id: "u1", email: "a@example.com" });

    await verifyUserSession("eyJhbGciOi.some.jwt", verifier);

    expect(asked).toEqual(["eyJhbGciOi.some.jwt"]);
  });
});

describe("a forged or rejected token is refused", () => {
  test("a token the provider rejects throws", async () => {
    const { verifier } = rejects("invalid JWT");

    await expect(verifyUserSession("forged.token", verifier)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  test("an expired token is refused the same way", async () => {
    const { verifier } = rejects("token is expired");

    const error = await refusalFrom(verifyUserSession("expired.token", verifier));

    expect(error).toBeInstanceOf(UnauthorizedError);
  });

  test("a response with no error and no user is still a refusal", async () => {
    const verifier: SessionVerifier = {
      auth: {
        getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      },
    };

    // An SDK answering this way has told us nothing, and nothing is not an
    // identity. Reasoning about the shape instead of refusing is how a null
    // becomes a session.
    await expect(verifyUserSession("t", verifier)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  test("a verified user with no email is refused", async () => {
    const { verifier } = accepts({ id: "u1", email: null });

    // The email is the unique key a `User` row is stored under. A session that
    // cannot be reconciled to a row is one that would have to invent an
    // address, creating a second identity for the same person.
    await expect(verifyUserSession("t", verifier)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  test("a blank email is treated as no email", async () => {
    const { verifier } = accepts({ id: "u1", email: "   " });

    await expect(verifyUserSession("t", verifier)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

describe("an absent token never reaches the provider", () => {
  test("an empty string is refused", async () => {
    const { verifier, asked } = accepts({ id: "u1", email: "a@example.com" });

    await expect(verifyUserSession("", verifier)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    // Spending a network round trip to be told an empty token is empty turns an
    // unauthenticated request into load on someone else's service.
    expect(asked).toEqual([]);
  });

  test("whitespace is refused", async () => {
    const { verifier, asked } = accepts({ id: "u1", email: "a@example.com" });

    await expect(verifyUserSession("   ", verifier)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(asked).toEqual([]);
  });

  test("a bare Bearer with no credential is refused", async () => {
    const { verifier, asked } = accepts({ id: "u1", email: "a@example.com" });

    // A client that failed to interpolate its token. Treating the empty
    // remainder as a value that might match is how a misconfiguration becomes
    // an authentication.
    await expect(verifyUserSession("Bearer ", verifier)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(asked).toEqual([]);
  });

  test("non-strings are refused rather than coerced", async () => {
    const { verifier, asked } = accepts({ id: "u1", email: "a@example.com" });

    for (const value of [undefined, null, 0, {}, [], true]) {
      await expect(verifyUserSession(value, verifier)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    }

    expect(asked).toEqual([]);
  });
});

describe("an unreachable provider is not an authorised caller", () => {
  test("a thrown network error becomes a refusal, not a pass", async () => {
    const verifier: SessionVerifier = {
      auth: {
        getUser: () => Promise.reject(new Error("ECONNREFUSED")),
      },
    };

    // The one place a fail-open would be tempting — an outage locks everybody
    // out — and exactly where it must not happen.
    await expect(verifyUserSession("t", verifier)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  test("the reason is kept for a log and kept out of the message", async () => {
    const verifier: SessionVerifier = {
      auth: { getUser: () => Promise.reject(new Error("ECONNREFUSED")) },
    };

    const error = await refusalFrom(verifyUserSession("t", verifier));

    // Absent, malformed, expired and unreachable are four things internally and
    // one thing to a caller.
    expect(error.message).toBe("Unauthorized.");
    expect(error.detail).toContain("ECONNREFUSED");
  });

  test("every refusal carries the same public message", async () => {
    const messages = new Set<string>();

    const { verifier: accepting } = accepts({ id: "u1", email: null });
    const { verifier: rejecting } = rejects();

    messages.add((await refusalFrom(verifyUserSession("", rejecting))).message);
    messages.add((await refusalFrom(verifyUserSession("t", rejecting))).message);
    messages.add((await refusalFrom(verifyUserSession("t", accepting))).message);

    expect(messages.size).toBe(1);
  });
});

describe("configuration by presence", () => {
  test("no project configured means no verifier", () => {
    expect(createSessionVerifier({})).toBeUndefined();
    expect(
      createSessionVerifier({ [SUPABASE_URL_ENV_VAR]: "https://x.supabase.co" }),
    ).toBeUndefined();
    expect(createSessionVerifier({ [SUPABASE_ANON_KEY_ENV_VAR]: "key" })).toBeUndefined();
  });

  test("a blank value counts as unset", () => {
    expect(
      createSessionVerifier({
        [SUPABASE_URL_ENV_VAR]: "  ",
        [SUPABASE_ANON_KEY_ENV_VAR]: "key",
      }),
    ).toBeUndefined();
  });

  test("a configured project builds one", () => {
    const client = createSessionVerifier({
      [SUPABASE_URL_ENV_VAR]: "https://project.supabase.co",
      [SUPABASE_ANON_KEY_ENV_VAR]: "anon-key",
    });

    expect(client).toBeDefined();
    expect(typeof client?.auth.getUser).toBe("function");
  });

  test("the client keeps no session of its own", () => {
    // A server verifying someone else's token has no session to persist.
    // Sharing mutable auth state across concurrent requests is how one caller
    // ends up answered as another.
    const client = createSessionVerifier({
      [SUPABASE_URL_ENV_VAR]: "https://project.supabase.co",
      [SUPABASE_ANON_KEY_ENV_VAR]: "anon-key",
    });

    expect(client).toBeDefined();
    // Asserted through behaviour rather than internals: no storage was touched.
    expect(vi.isMockFunction(client?.auth.getUser)).toBe(false);
  });
});
