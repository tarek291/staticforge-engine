import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";
import { API_KEY_PREFIX, hashApiKey } from "@staticforge/core";

import {
  authorizeProjectAccess,
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
} from "./api-key.js";

/**
 * Minting, verifying and revoking keys.
 *
 * The test that matters most is the one asserting a negative: that the
 * plaintext never reaches the database. It is a negative because there is no
 * observable difference between a system that stores hashes and one that
 * stores secrets — until a dump leaks, at which point the difference is the
 * whole incident.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
  // The transaction wrapper runs its callback against the same mock, so the
  // writes inside it are observable.
  prisma.$transaction.mockImplementation(((run: (tx: typeof prisma) => Promise<unknown>) =>
    run(prisma)) as unknown as typeof prisma.$transaction);
});

const CREATED_AT = new Date("2026-08-28T12:00:00.000Z");

/** Arm the key create to echo a row back. */
function armCreate(id = "key_1", organizationId = "org_1"): void {
  prisma.apiKey.create.mockResolvedValue({
    id,
    name: "CI pipeline",
    organizationId,
    createdAt: CREATED_AT,
    revokedAt: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.organizationMember.create.mockResolvedValue({} as any);
}

/** Everything handed to Prisma across every call, as one searchable string. */
function everythingWritten(): string {
  const calls = [
    ...prisma.apiKey.create.mock.calls,
    ...prisma.apiKey.update.mock.calls,
    ...prisma.apiKey.findUnique.mock.calls,
    ...prisma.apiKey.findFirst.mock.calls,
    ...prisma.organizationMember.create.mock.calls,
  ];

  return JSON.stringify(calls);
}

describe("the plaintext key never reaches the database", () => {
  test("nothing passed to Prisma contains it", async () => {
    armCreate();

    const minted = await generateApiKey("org_1", "CI pipeline", prisma);

    // The whole security property, asserted against *every* argument this
    // module handed to the client — not only the one field a reader would think
    // to check.
    expect(everythingWritten()).not.toContain(minted.plaintext);
  });

  test("not even the secret half of it", async () => {
    armCreate();

    const minted = await generateApiKey("org_1", "CI pipeline", prisma);
    const secretPart = minted.plaintext.slice(API_KEY_PREFIX.length);

    expect(everythingWritten()).not.toContain(secretPart);
  });

  test("what is stored is the hash of what was returned", async () => {
    armCreate();

    const minted = await generateApiKey("org_1", "CI pipeline", prisma);
    const data = prisma.apiKey.create.mock.calls[0]?.[0]?.data as {
      keyHash: string;
    };

    expect(data.keyHash).toBe(hashApiKey(minted.plaintext));
    expect(data.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the row that is written has no field for a secret", async () => {
    armCreate();

    await generateApiKey("org_1", "CI pipeline", prisma);
    const data = prisma.apiKey.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;

    expect(Object.keys(data).sort()).toEqual(["keyHash", "name", "organizationId"]);
  });

  test("the summary handed back to a caller carries no secret", async () => {
    armCreate();

    const minted = await generateApiKey("org_1", "CI pipeline", prisma);

    // `plaintext` is a sibling of the record, not part of it, so a route that
    // returns `key` cannot leak the credential by forgetting to strip a field.
    expect(JSON.stringify(minted.key)).not.toContain(minted.plaintext);
    expect(Object.keys(minted.key).sort()).toEqual([
      "active",
      "createdAt",
      "id",
      "name",
      "organizationId",
      "revokedAt",
    ]);
  });

  test("a listing cannot return one either", async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key_1",
        name: "CI",
        organizationId: "org_1",
        createdAt: CREATED_AT,
        revokedAt: null,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    await listApiKeys("org_1", prisma);

    const select = prisma.apiKey.findMany.mock.calls[0]?.[0]?.select as Record<
      string,
      unknown
    >;

    // The hash is not selected either. It is not a secret in the way the key
    // is, but it is a value that only ever needs to travel *into* a query.
    expect(select).not.toHaveProperty("keyHash");
  });
});

describe("a key becomes a member of its organization", () => {
  test("the membership is written with the key", async () => {
    armCreate("key_9", "org_7");

    await generateApiKey("org_7", "CI pipeline", prisma);

    expect(prisma.organizationMember.create).toHaveBeenCalledWith({
      data: { organizationId: "org_7", userId: "apikey:key_9", role: "EDITOR" },
    });
  });

  test("both writes are in one transaction", async () => {
    armCreate();

    await generateApiKey("org_1", "CI pipeline", prisma);

    // A key with no membership would authenticate and then be refused
    // everything, which reads to an operator as a permissions bug rather than
    // as the half-finished write it is.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  test("EDITOR by default, so a leaked key cannot mint its successors", async () => {
    armCreate();

    await generateApiKey("org_1", "CI pipeline", prisma);
    const data = prisma.organizationMember.create.mock.calls[0]?.[0]?.data as {
      role: string;
    };

    // `member:manage` needs OWNER. A credential that can create its own
    // replacements survives its own revocation.
    expect(data.role).toBe("EDITOR");
  });

  test("the role is overridable for a read-only integration", async () => {
    armCreate();

    await generateApiKey("org_1", "Status page", prisma, { role: "VIEWER" });
    const data = prisma.organizationMember.create.mock.calls[0]?.[0]?.data as {
      role: string;
    };

    expect(data.role).toBe("VIEWER");
  });
});

describe("verifying a presented key", () => {
  /** Arm the hash lookup. */
  function armLookup(row: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.apiKey.findUnique.mockResolvedValue(row as any);
  }

  const RAW = `${API_KEY_PREFIX}${"a".repeat(43)}`;

  test("a valid key resolves to its organization", async () => {
    armLookup({
      id: "key_1",
      name: "CI",
      organizationId: "org_1",
      revokedAt: null,
    });

    expect(await verifyApiKey(RAW, prisma)).toEqual({
      apiKeyId: "key_1",
      organizationId: "org_1",
      name: "CI",
      userId: "apikey:key_1",
    });
  });

  test("the lookup is by hash, and the plaintext never travels", async () => {
    armLookup(null);

    await verifyApiKey(RAW, prisma);

    const where = prisma.apiKey.findUnique.mock.calls[0]?.[0]?.where as {
      keyHash: string;
    };

    // The plaintext must not appear in a query, a slow-query log, or a
    // `pg_stat_statements` row.
    expect(where.keyHash).toBe(hashApiKey(RAW));
    expect(JSON.stringify(prisma.apiKey.findUnique.mock.calls)).not.toContain(RAW);
  });

  test("an unknown key is refused", async () => {
    armLookup(null);

    expect(await verifyApiKey(RAW, prisma)).toBeNull();
  });

  test("a revoked key is refused", async () => {
    armLookup({
      id: "key_1",
      name: "CI",
      organizationId: "org_1",
      revokedAt: new Date("2026-08-27T00:00:00.000Z"),
    });

    // The row exists and resolves to a real organization. Revocation is the
    // only thing standing between it and access, so this is the assertion that
    // makes revocation mean anything.
    expect(await verifyApiKey(RAW, prisma)).toBeNull();
  });

  test("a malformed key is refused without a query", async () => {
    expect(await verifyApiKey("hunter2", prisma)).toBeNull();
    expect(await verifyApiKey(undefined, prisma)).toBeNull();
    expect(await verifyApiKey(null, prisma)).toBeNull();

    // A scanner spraying arbitrary headers costs a string comparison rather
    // than a database round trip.
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  test("every failure is the same answer", async () => {
    armLookup(null);
    const unknown = await verifyApiKey(RAW, prisma);

    armLookup({ id: "k", name: "n", organizationId: "o", revokedAt: new Date() });
    const revoked = await verifyApiKey(RAW, prisma);

    const malformed = await verifyApiKey("nope", prisma);

    // Three failures, one answer. Distinguishing them would hand three bits of
    // information to whoever is guessing.
    expect(unknown).toBeNull();
    expect(revoked).toBeNull();
    expect(malformed).toBeNull();
  });
});

describe("revoking a key", () => {
  /** Arm the scoped lookup revoke does first. */
  function armExisting(row: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.apiKey.findFirst.mockResolvedValue(row as any);
  }

  test("it is scoped to the organization, not only the key id", async () => {
    armExisting(null);

    await revokeApiKey("key_1", "org_1", prisma);

    // Holding a key id must not be enough to turn off another tenant's
    // credential — or to learn that it is real.
    expect(prisma.apiKey.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "key_1",
      organizationId: "org_1",
    });
  });

  test("another organization's key is simply not found", async () => {
    armExisting(null);

    expect(await revokeApiKey("key_1", "other_org", prisma)).toBeNull();
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  test("it stamps a time rather than deleting the row", async () => {
    armExisting({
      id: "key_1",
      name: "CI",
      organizationId: "org_1",
      createdAt: CREATED_AT,
      revokedAt: null,
    });
    prisma.apiKey.update.mockResolvedValue({
      id: "key_1",
      name: "CI",
      organizationId: "org_1",
      createdAt: CREATED_AT,
      revokedAt: new Date("2026-08-28T13:00:00.000Z"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.organizationMember.deleteMany.mockResolvedValue({ count: 1 } as any);

    const revoked = await revokeApiKey("key_1", "org_1", prisma);

    // The audit trail still needs to say which key did something last month and
    // when it was turned off. A deleted row takes that answer with it.
    expect(prisma.apiKey.delete).not.toHaveBeenCalled();
    expect(revoked?.active).toBe(false);
    expect(revoked?.revokedAt).toBe("2026-08-28T13:00:00.000Z");
  });

  test("it removes the membership, so the principal loses access too", async () => {
    armExisting({
      id: "key_1",
      name: "CI",
      organizationId: "org_1",
      createdAt: CREATED_AT,
      revokedAt: null,
    });
    prisma.apiKey.update.mockResolvedValue({
      id: "key_1",
      name: "CI",
      organizationId: "org_1",
      createdAt: CREATED_AT,
      revokedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.organizationMember.deleteMany.mockResolvedValue({ count: 1 } as any);

    await revokeApiKey("key_1", "org_1", prisma);

    expect(prisma.organizationMember.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: "org_1", userId: "apikey:key_1" },
    });
  });

  test("revoking twice keeps the first timestamp", async () => {
    const alreadyRevoked = new Date("2026-08-27T09:00:00.000Z");
    armExisting({
      id: "key_1",
      name: "CI",
      organizationId: "org_1",
      createdAt: CREATED_AT,
      revokedAt: alreadyRevoked,
    });

    const result = await revokeApiKey("key_1", "org_1", prisma);

    // When it stopped working is a fact, and the second call did not change it.
    expect(result?.revokedAt).toBe(alreadyRevoked.toISOString());
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });
});

describe("listing keys", () => {
  beforeEach(() => {
    prisma.apiKey.findMany.mockResolvedValue([]);
  });

  test("every read is scoped to one organization", async () => {
    await listApiKeys("org_1", prisma);

    // There is deliberately no unscoped variant: a listing that spanned
    // organizations would be a map of every tenant's credentials.
    expect(prisma.apiKey.findMany.mock.calls[0]?.[0]?.where).toEqual({
      organizationId: "org_1",
    });
  });

  test("revoked keys are included by default", async () => {
    await listApiKeys("org_1", prisma);

    // Part of the answer to "who had access", which is the question this list
    // exists for.
    expect(prisma.apiKey.findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty(
      "revokedAt",
    );
  });

  test("they can be filtered out when only live access matters", async () => {
    await listApiKeys("org_1", prisma, { activeOnly: true });

    expect(prisma.apiKey.findMany.mock.calls[0]?.[0]?.where).toEqual({
      organizationId: "org_1",
      revokedAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The sync endpoint's authorisation, as the route applies it
// ---------------------------------------------------------------------------

/**
 * What `/api/webhooks/sync` decides before it touches anything.
 *
 * This replaced a single `STATICFORGE_WEBHOOK_SECRET` that authenticated a
 * *caller* and said nothing about which tenant they were — so anyone holding it
 * could sync any project the operator owned. The tests here are the ones that
 * make the replacement worth having: a key opens its own organization's
 * projects and nothing else, and a revoked key opens nothing at all.
 */
describe("the sync endpoint's authorisation", () => {
  const RAW_KEY = `${API_KEY_PREFIX}${"k".repeat(43)}`;
  const HEADER = `Bearer ${RAW_KEY}`;

  /** Arm a key that resolves to one organization. */
  function armKey(organizationId: string, revokedAt: Date | null = null): void {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: "key_1",
      name: "CI pipeline",
      organizationId,
      revokedAt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  /** Arm the project the caller named. */
  function armProject(organizationId: string | null): void {
    prisma.project.findUnique.mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (organizationId === null ? null : { organizationId }) as any,
    );
  }

  test("a valid key for its own organization is let through", async () => {
    armKey("org_1");
    armProject("org_1");

    const result = await authorizeProjectAccess(HEADER, "prj_1", prisma);

    expect(result.ok).toBe(true);
    expect(result.ok && result.principal).toMatchObject({
      apiKeyId: "key_1",
      organizationId: "org_1",
      userId: "apikey:key_1",
    });
  });

  test("a key for another organization cannot reach the project", async () => {
    armKey("org_attacker");
    armProject("org_victim");

    const result = await authorizeProjectAccess(HEADER, "prj_1", prisma);

    // The whole tenant boundary. A perfectly valid credential, a real project,
    // and no access — because they belong to different organizations.
    expect(result).toEqual({ ok: false, status: 404, error: "Project not found." });
  });

  test("a cross-tenant attempt is indistinguishable from a missing project", async () => {
    armKey("org_attacker");

    armProject("org_victim");
    const crossTenant = await authorizeProjectAccess(HEADER, "prj_real", prisma);

    armProject(null);
    const missing = await authorizeProjectAccess(HEADER, "prj_imaginary", prisma);

    // Two different answers would turn a valid key for one tenant into a probe
    // for every other tenant's project ids.
    expect(crossTenant).toEqual(missing);
  });

  test("a revoked key is refused", async () => {
    armKey("org_1", new Date("2026-08-27T00:00:00.000Z"));
    armProject("org_1");

    const result = await authorizeProjectAccess(HEADER, "prj_1", prisma);

    // The row exists and names the right organization. Revocation is the only
    // thing standing between it and access, so this is the assertion that makes
    // revocation mean anything.
    expect(result).toEqual({ ok: false, status: 401, error: "Unauthorized." });
  });

  test("an unknown key is refused", async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null as never);
    armProject("org_1");

    expect(await authorizeProjectAccess(HEADER, "prj_1", prisma)).toEqual({
      ok: false,
      status: 401,
      error: "Unauthorized.",
    });
  });

  test("a missing header is refused", async () => {
    armProject("org_1");

    expect(await authorizeProjectAccess(null, "prj_1", prisma)).toEqual({
      ok: false,
      status: 401,
      error: "Unauthorized.",
    });
  });

  test("the old shared-secret style of header is refused", async () => {
    armProject("org_1");

    // What an integration built against Phase 15 would send. It has to fail,
    // and fail as an ordinary 401 — a special message would tell whoever is
    // probing that another scheme once existed.
    expect(await authorizeProjectAccess("Bearer some-shared-secret", "prj_1", prisma)).toEqual({
      ok: false,
      status: 401,
      error: "Unauthorized.",
    });
  });

  test("authentication happens before the project is read", async () => {
    prisma.apiKey.findUnique.mockResolvedValue(null as never);
    armProject("org_1");

    await authorizeProjectAccess(HEADER, "prj_1", prisma);

    // An endpoint that touched a project before authenticating would give an
    // unauthenticated caller a way to measure which ids exist.
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  test("a malformed key costs no query at all", async () => {
    await authorizeProjectAccess("Bearer hunter2", "prj_1", prisma);

    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  test("every refusal reveals only its status, never a reason", async () => {
    const refusals: string[] = [];

    prisma.apiKey.findUnique.mockResolvedValue(null as never);
    armProject("org_1");
    const unknown = await authorizeProjectAccess(HEADER, "prj_1", prisma);
    if (!unknown.ok) refusals.push(unknown.error);

    armKey("org_1", new Date());
    const revoked = await authorizeProjectAccess(HEADER, "prj_1", prisma);
    if (!revoked.ok) refusals.push(revoked.error);

    const absent = await authorizeProjectAccess(undefined, "prj_1", prisma);
    if (!absent.ok) refusals.push(absent.error);

    // Unknown, revoked and absent are three things to us and must be one thing
    // to a caller.
    expect(new Set(refusals).size).toBe(1);
  });

  test("the plaintext key never travels to the database", async () => {
    armKey("org_1");
    armProject("org_1");

    await authorizeProjectAccess(HEADER, "prj_1", prisma);

    const everything = JSON.stringify([
      ...prisma.apiKey.findUnique.mock.calls,
      ...prisma.project.findUnique.mock.calls,
    ]);

    expect(everything).not.toContain(RAW_KEY);
    expect(everything).toContain(hashApiKey(RAW_KEY));
  });
});
