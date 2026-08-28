import type { PrismaClient } from "@prisma/client";
import {
  apiKeyPrincipalId,
  generateApiKeySecret,
  hashApiKey,
  isWellFormedApiKey,
  readBearerToken,
  type OrgRoleName,
} from "@staticforge/core";

import { organizationOfProject } from "./access.js";
import { withDbRetry } from "./retry.js";

/**
 * Minting, verifying and revoking organization API keys.
 *
 * ## The plaintext exists once
 *
 * `generateApiKey` returns it, nothing stores it, and no other function in this
 * module can produce it. That is the whole security property: a database dump,
 * a log aggregator, a support engineer with `SELECT`, or a backup left in a
 * bucket yields a list of hashes rather than a list of working credentials.
 *
 * The cost is that a lost key cannot be recovered, only replaced. That is the
 * correct trade and the CLI says so at the moment it matters.
 *
 * ## Why a key is a member
 *
 * A verified key resolves to an organization — and then something has to decide
 * whether it may do the thing it is asking for. The alternative to reusing the
 * role gate is a second permission path just for keys, and a second path is how
 * one of them ends up missing a check that the other has.
 *
 * So a key is given a principal id and a membership row, and every existing
 * `requireCapability` call works on it unchanged. It defaults to EDITOR, which
 * is the level that can sync and generate but cannot delete a project or mint
 * more keys — so a leaked key cannot be used to manufacture its own
 * replacements, which is what turns a leak into a persistent foothold.
 */

/** A key as an operator sees it listed. Never includes the secret. */
export interface ApiKeySummary {
  id: string;
  name: string;
  organizationId: string;
  createdAt: string;
  revokedAt: string | null;
  /** Whether it still authenticates. */
  active: boolean;
}

/** A freshly minted key. The only place the plaintext ever appears. */
export interface MintedApiKey {
  key: ApiKeySummary;
  /**
   * The plaintext, to be shown once and never again.
   *
   * Named `plaintext` rather than `token` or `value` so that every place it is
   * handled reads as what it is, and a line that logs it looks wrong on sight.
   */
  plaintext: string;
}

/** Who a verified key turns out to be. */
export interface ApiKeyPrincipal {
  apiKeyId: string;
  organizationId: string;
  /** The key's name, for audit lines. */
  name: string;
  /** The principal id this key acts as, for the authorisation gate. */
  userId: string;
}

/** Shape a row for transport. Deliberately cannot carry a secret. */
function toSummary(row: {
  id: string;
  name: string;
  organizationId: string;
  createdAt: Date;
  revokedAt: Date | null;
}): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    organizationId: row.organizationId,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    active: row.revokedAt === null,
  };
}

/** Options for {@link generateApiKey}. */
export interface GenerateApiKeyOptions {
  /**
   * What the key may do in its organization.
   *
   * EDITOR by default: enough to sync and to queue generation, not enough to
   * delete a project or add members — and therefore not enough to mint another
   * key. A credential that can create its own successors survives its own
   * revocation.
   */
  role?: OrgRoleName;
}

/**
 * Mint a key for an organization.
 *
 * The membership row and the key row are written in one transaction. Either
 * both exist or neither does — a key with no membership would authenticate and
 * then be refused everything, which reads to an operator as a permissions bug
 * rather than as the half-finished write it is.
 *
 * @param organizationId - The organization this key acts as.
 * @param name - What it is for, in the operator's words.
 * @param prisma - The client to write with.
 * @param options - Role.
 * @returns The stored record and the plaintext, once.
 * @throws If the organization does not exist — the foreign key refuses it,
 * rather than leaving a key that authenticates as nobody.
 */
export async function generateApiKey(
  organizationId: string,
  name: string,
  prisma: PrismaClient,
  options: GenerateApiKeyOptions = {},
): Promise<MintedApiKey> {
  const plaintext = generateApiKeySecret();
  const keyHash = hashApiKey(plaintext);
  const role: OrgRoleName = options.role ?? "EDITOR";

  const row = await withDbRetry(() =>
    prisma.$transaction(async (tx) => {
      const created = await tx.apiKey.create({
        // Note what is absent: the plaintext. It is hashed above and the
        // original is never handed to Prisma, so it cannot reach a query log.
        data: { organizationId, name, keyHash },
        select: {
          id: true,
          name: true,
          organizationId: true,
          createdAt: true,
          revokedAt: true,
        },
      });

      await tx.organizationMember.create({
        data: {
          organizationId,
          userId: apiKeyPrincipalId(created.id),
          role,
        },
      });

      return created;
    }),
  );

  return { key: toSummary(row), plaintext };
}

/**
 * Resolve a presented key to the principal it authenticates.
 *
 * One indexed lookup on the hash. The raw key is hashed here and the hash is
 * what travels to the database, so the plaintext never appears in a query, a
 * slow-query log, or a `pg_stat_statements` row.
 *
 * Every failure returns `null` and none of them says why. "No such key",
 * "revoked", and "malformed" are one answer to a caller, because three answers
 * are three bits of information handed to whoever is guessing.
 *
 * @param rawKey - Whatever arrived in the header.
 * @param prisma - The client to read with.
 * @returns The principal, or `null` if the key is unknown, revoked or malformed.
 */
export async function verifyApiKey(
  rawKey: unknown,
  prisma: PrismaClient,
): Promise<ApiKeyPrincipal | null> {
  // Shape first, so a scanner spraying arbitrary headers costs a string
  // comparison rather than a database round trip. Not a security boundary —
  // a well-formed key is still worthless until it resolves to a row.
  if (!isWellFormedApiKey(rawKey)) {
    return null;
  }

  const row = await withDbRetry(() =>
    prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(rawKey) },
      select: {
        id: true,
        name: true,
        organizationId: true,
        revokedAt: true,
      },
    }),
  );

  if (row === null || row === undefined) {
    return null;
  }

  if (row.revokedAt !== null) {
    // Checked here rather than folded into the `where`, so a revoked key is a
    // row this code has seen and rejected rather than a row it failed to find.
    // The distinction matters the day this needs to log an attempted use of a
    // revoked credential, which is a materially more interesting event than a
    // wrong key.
    return null;
  }

  return {
    apiKeyId: row.id,
    organizationId: row.organizationId,
    name: row.name,
    userId: apiKeyPrincipalId(row.id),
  };
}

/**
 * Turn a key off.
 *
 * Scoped to the organization as well as the id, so holding a key id is not
 * enough to revoke someone else's credential. Idempotent: revoking an already
 * revoked key leaves the original timestamp, because when it stopped working is
 * a fact and the second call did not change it.
 *
 * The membership row is deleted rather than left behind — a principal that can
 * never authenticate again should not still appear in a list of who has access.
 *
 * @returns The updated summary, or `null` when no such key belongs to that
 * organization.
 */
export async function revokeApiKey(
  apiKeyId: string,
  organizationId: string,
  prisma: PrismaClient,
): Promise<ApiKeySummary | null> {
  return withDbRetry(() =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.apiKey.findFirst({
        where: { id: apiKeyId, organizationId },
        select: {
          id: true,
          name: true,
          organizationId: true,
          createdAt: true,
          revokedAt: true,
        },
      });

      if (existing === null) {
        return null;
      }

      if (existing.revokedAt !== null) {
        return toSummary(existing);
      }

      const updated = await tx.apiKey.update({
        where: { id: apiKeyId },
        data: { revokedAt: new Date() },
        select: {
          id: true,
          name: true,
          organizationId: true,
          createdAt: true,
          revokedAt: true,
        },
      });

      await tx.organizationMember.deleteMany({
        where: { organizationId, userId: apiKeyPrincipalId(apiKeyId) },
      });

      return toSummary(updated);
    }),
  );
}

/**
 * List an organization's keys.
 *
 * Scoped, and there is deliberately no unscoped variant: a listing that spanned
 * organizations would be a map of every tenant's credentials, and the first
 * convenience function that returns one is the one that ends up behind a route.
 *
 * Revoked keys are included by default. A key that was turned off is part of
 * the answer to "who had access", which is the question this list exists for.
 */
export async function listApiKeys(
  organizationId: string,
  prisma: PrismaClient,
  options: { activeOnly?: boolean } = {},
): Promise<ApiKeySummary[]> {
  const rows = await withDbRetry(() =>
    prisma.apiKey.findMany({
      where: {
        organizationId,
        ...(options.activeOnly === true ? { revokedAt: null } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        organizationId: true,
        createdAt: true,
        revokedAt: true,
      },
    }),
  );

  return rows.map(toSummary);
}

/** What an authorisation attempt decided. */
export type ProjectAuthorization =
  | { ok: true; principal: ApiKeyPrincipal }
  | { ok: false; status: 401 | 404; error: string };

/**
 * Decide whether a presented credential may act on a project.
 *
 * Extracted from the route rather than written inside it, for the reason every
 * decision in this engine is: a rule that lives in an HTTP handler can only be
 * tested by standing up an HTTP handler, and a rule that is hard to test is a
 * rule that gets one test instead of ten.
 *
 * Two checks, in this order, and the order is load-bearing:
 *
 * 1. **Who is this?** An unresolvable key stops here, before anything reads a
 *    project. A caller that could make the endpoint touch a project *before*
 *    authenticating would have a way to measure which project ids exist.
 * 2. **Is the project theirs?** A project in another organization answers
 *    exactly as a project that does not exist. Two different answers would make
 *    a valid key for one tenant into a probe for every other tenant's ids.
 *
 * What it deliberately does *not* decide is whether the principal may perform
 * the specific action. That is `requireCapability`, and it runs inside the
 * operation itself — so a key issued as a VIEWER passes this function and is
 * still refused the write, by the same gate that refuses a person.
 *
 * @param authorizationHeader - The raw header, as received.
 * @param projectId - The project the caller named.
 * @param prisma - The client to read with.
 */
export async function authorizeProjectAccess(
  authorizationHeader: string | null | undefined,
  projectId: string,
  prisma: PrismaClient,
): Promise<ProjectAuthorization> {
  const principal = await verifyApiKey(
    readBearerToken(authorizationHeader),
    prisma,
  );

  if (principal === null) {
    // One answer for absent, malformed, unknown and revoked. Four things to us;
    // one thing to a caller, because three extra messages are three bits of
    // information handed to whoever is guessing.
    return { ok: false, status: 401, error: "Unauthorized." };
  }

  const projectOrganizationId = await organizationOfProject(projectId, prisma);

  if (
    projectOrganizationId === null ||
    projectOrganizationId !== principal.organizationId
  ) {
    return { ok: false, status: 404, error: "Project not found." };
  }

  return { ok: true, principal };
}
