import type { PrismaClient } from "@prisma/client";
import type { DeepMockProxy } from "vitest-mock-extended";

/**
 * Arming the atomic quota gate against a mock.
 *
 * The gate reads through `$queryRawUnsafe` twice — the quota row `FOR UPDATE`,
 * then the sum of usage since its reset — and a mock cannot tell those apart by
 * argument shape, only by the SQL it was handed. So this dispatches on the SQL
 * text, which is the one thing that distinguishes them.
 *
 * ## Why this is a shared fixture rather than three copies
 *
 * Three test files gate on quotas, and three private copies of this would be
 * three places to update when the gate changes — with the usual consequence
 * that two get updated. Worse, a copy that drifted would keep passing while
 * testing a mechanism the code no longer uses, which is the specific way a
 * mocked test stops being evidence of anything.
 *
 * It lives beside the source rather than in a test directory because this
 * package is consumed as TypeScript source: there is no build step to exclude
 * it from, and `vitest` and `tsc` see the same tree either way.
 */

/** The state a quota is in, as far as the gate can see. */
export interface ArmedQuota {
  /** The ceiling, or `null` for an organization with no quota configured. */
  limit: number | null;
  /** Units already consumed since the reset. */
  used?: number;
  /** When the counter was zeroed. Defaults to an hour ago. */
  resetDate?: Date;
}

/** An hour before now, so a quota is countable without pinning the clock. */
export function anHourAgo(): Date {
  return new Date(Date.now() - 60 * 60 * 1000);
}

/**
 * Make the mocked client answer the gate's two reads.
 *
 * @param prisma - The deep mock to arm.
 * @param quota - What the gate should find. `limit: null` means no quota row,
 * which is the deliberate fail-open every test of "unlimited" relies on.
 */
export function armQuotaGate(
  prisma: DeepMockProxy<PrismaClient>,
  quota: ArmedQuota,
): void {
  const resetDate = quota.resetDate ?? anHourAgo();
  const used = quota.used ?? 0;

  prisma.$queryRawUnsafe.mockImplementation((sql: unknown) => {
    const text = String(sql);

    if (text.includes("OrganizationQuota")) {
      // An empty result is a tenant with no ceiling. `FOR UPDATE` locked
      // nothing, which is correct: an absent limit cannot be raced past.
      return Promise.resolve(
        quota.limit === null ? [] : [{ limit: quota.limit, resetDate }],
      ) as never;
    }

    if (text.includes("SUM")) {
      // Returned as a bigint, matching the driver. The gate coerces it, and a
      // fixture handing back a plain number would hide a `bigint + number`
      // TypeError that only appears against a real database.
      return Promise.resolve([{ used: BigInt(used) }]) as never;
    }

    return Promise.resolve([]) as never;
  });

  // The hold the gate writes when it admits work.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.usageRecord.create.mockResolvedValue({ id: "usage_hold" } as any);
}

/** Every hold the gate wrote, in order. */
export function holdsWritten(
  prisma: DeepMockProxy<PrismaClient>,
): Array<{ organizationId: string; metric: string; amount: number }> {
  return prisma.usageRecord.create.mock.calls.map(
    (call) =>
      (call[0] as { data: { organizationId: string; metric: string; amount: number } })
        .data,
  );
}
