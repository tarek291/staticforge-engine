import { PrismaClient } from "@prisma/client";

/**
 * Give every existing membership a `User` row to point at.
 *
 * Phase 27 turns `OrganizationMember.userId` into a foreign key. Before it, the
 * column was a free string, so the table already holds principals that have
 * never existed anywhere else: the `local-operator` placeholder the engine has
 * used since before there was any identity, and one `apikey:…` row for every
 * key minted in Phase 25.
 *
 * A foreign key added on top of those rows fails outright — Postgres refuses to
 * create a constraint the existing data violates. So this runs *between* the
 * two pushes: the `User` table exists, the relation does not yet, and this
 * fills the gap.
 *
 * ## Idempotent
 *
 * Every write is a `createMany` with `skipDuplicates`, keyed on the primary
 * key. Running it twice restores the same state instead of failing, which
 * matters because the safe way to use it is to run it, look at the output, and
 * run it again.
 *
 * ## The addresses are deliberately unreachable
 *
 * Synthetic principals get an address under `.invalid`, the TLD reserved by
 * RFC 2606 precisely so it can never resolve. A placeholder under a real domain
 * is a placeholder that eventually receives a password reset.
 *
 * Run with:
 *   corepack pnpm --filter @staticforge/database exec tsx prisma/backfill-users.ts
 */

const prisma = new PrismaClient({ log: ["error"] });

/** An address that cannot reach anyone, derived from the principal's id. */
function syntheticEmail(userId: string): string {
  // Lowercased and stripped of anything an address may not carry, so
  // `apikey:cmt…` becomes `apikey-cmt…@principals.staticforge.invalid`.
  const local = userId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");

  return `${local}@principals.staticforge.invalid`;
}

/** A readable name, so a member list is not a wall of ids. */
function syntheticName(userId: string): string {
  if (userId.startsWith("apikey:")) {
    return `API key ${userId.slice("apikey:".length)}`;
  }

  return userId === "local-operator" ? "Local operator" : userId;
}

async function backfill(): Promise<void> {
  const members = await prisma.organizationMember.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });

  const existing = await prisma.user.findMany({
    where: { id: { in: members.map((member) => member.userId) } },
    select: { id: true },
  });

  const known = new Set(existing.map((user) => user.id));
  const missing = members
    .map((member) => member.userId)
    .filter((userId) => !known.has(userId));

  console.log(`memberships reference ${members.length} distinct principal(s)`);
  console.log(`  ${known.size} already have a User row`);
  console.log(`  ${missing.length} need one`);

  if (missing.length === 0) {
    console.log("\nNothing to do. The foreign key can be applied.");
    return;
  }

  const created = await prisma.user.createMany({
    data: missing.map((userId) => ({
      id: userId,
      email: syntheticEmail(userId),
      name: syntheticName(userId),
    })),
    // Idempotent. Re-running after a partial failure fills only the gap.
    skipDuplicates: true,
  });

  console.log(`\ncreated ${created.count} User row(s):`);
  for (const userId of missing) {
    console.log(`  ${userId} -> ${syntheticEmail(userId)}`);
  }

  const orphans = await prisma.$queryRawUnsafe<Array<{ userId: string }>>(
    `SELECT DISTINCT m."userId"
       FROM "OrganizationMember" m
       LEFT JOIN "User" u ON u."id" = m."userId"
      WHERE u."id" IS NULL`,
  );

  // Checked rather than assumed. The next step adds a constraint that fails
  // loudly on any row this missed, and finding that out here is cheaper than
  // finding it out from a failed migration.
  console.log(
    `\nmemberships still without a User row: ${orphans.length} ` +
      `${orphans.length === 0 ? "— safe to apply the foreign key" : "*** FIX BEFORE PUSHING ***"}`,
  );
}

backfill()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
