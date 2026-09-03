import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import { generateApiKey, listApiKeys, revokeApiKey } from "./api-key.js";
import { listAuditEvents } from "./audit.js";
import { PLATFORM_OPERATOR_ENV_VAR, isPlatformOperator } from "./platform.js";
import { setQuota } from "./quota.js";
import { armQuotaGate } from "./quota.fixtures.js";
import { saveRefreshedPage } from "./tenant.js";

/**
 * Authorisation where it cannot be skipped.
 *
 * ## What the audit found
 *
 * Phase 29 put a role check in front of every API route and left the functions
 * behind them open. That is a real defence and it is the wrong shape for one:
 * the guarantee it gives is "every caller remembered", which holds until
 * somebody adds route number twelve, a CLI command, a background job, or a
 * script — and the evidence that they forgot is a customer's VIEWER holding an
 * OWNER credential.
 *
 * So the check moved inside. These tests are the ones that fail if it moves
 * back out: every case calls the data layer *directly*, with no route in front
 * of it, which is exactly the position a future caller who forgets will be in.
 *
 * ## Why a key is `member:manage` and not something weaker
 *
 * An API key is a member. Phase 25 made it one deliberately — a key passes the
 * same role gate a person does — so minting one is adding a member, and an
 * EDITOR who could mint an OWNER key would *be* an OWNER by a two-step route
 * that no permission check anywhere would notice.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
  prisma.$transaction.mockImplementation(((run: (tx: typeof prisma) => Promise<unknown>) =>
    run(prisma)) as unknown as typeof prisma.$transaction);
  armQuotaGate(prisma, { limit: null });
});

/** Give the acting principal a role, or none. */
function actAs(role: "OWNER" | "EDITOR" | "VIEWER" | null): void {
  prisma.organizationMember.findUnique.mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    role === null ? null : ({ role } as any),
  );
}

/** Let the writes succeed, so a refusal is the only thing that can stop them. */
function armWrites(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.apiKey.create.mockResolvedValue({
    id: "key_1",
    name: "n",
    organizationId: "org_1",
    createdAt: new Date("2026-08-31T00:00:00.000Z"),
    revokedAt: null,
  } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.apiKey.findFirst.mockResolvedValue({ id: "key_1", name: "n" } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.apiKey.update.mockResolvedValue({ id: "key_1", name: "n" } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.organizationMember.create.mockResolvedValue({} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.user.create.mockResolvedValue({} as any);
  prisma.auditLog.findMany.mockResolvedValue([]);
  prisma.apiKey.findMany.mockResolvedValue([]);
  prisma.generatedPage.updateMany.mockResolvedValue({ count: 1 } as never);
  prisma.project.findUnique.mockResolvedValue({ organizationId: "org_1" } as never);
}

describe("minting a key needs OWNER, at the function and not at the route", () => {
  test("a VIEWER cannot mint one", async () => {
    armWrites();
    actAs("VIEWER");

    await expect(
      generateApiKey("org_1", "viewer-user", "exfiltration", prisma),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });

    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  test("an EDITOR cannot mint one either", async () => {
    armWrites();
    actAs("EDITOR");

    // The escalation this closes: an EDITOR minting a key with `role: "OWNER"`
    // would hold OWNER, and every subsequent check would pass honestly.
    await expect(
      generateApiKey("org_1", "editor-user", "promotion", prisma, { role: "OWNER" }),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });

    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  test("a stranger cannot mint one", async () => {
    armWrites();
    actAs(null);

    await expect(
      generateApiKey("org_1", "nobody", "trespass", prisma),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });
  });

  test("an OWNER can", async () => {
    armWrites();
    actAs("OWNER");

    const minted = await generateApiKey("org_1", "owner-user", "CI", prisma);

    expect(minted.plaintext).toMatch(/^sf_org_/);
  });

  test("nothing is generated before the refusal", async () => {
    armWrites();
    actAs("VIEWER");

    await generateApiKey("org_1", "viewer-user", "x", prisma).catch(() => undefined);

    // The check is the *first* line. A refusal that came after the secret was
    // minted would have put a live credential in this process's memory, and in
    // whatever logged the arguments, for a call that was never allowed.
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.organizationMember.create).not.toHaveBeenCalled();
  });
});

describe("withdrawing and enumerating keys need OWNER too", () => {
  test("an EDITOR cannot revoke a key", async () => {
    armWrites();
    actAs("EDITOR");

    // The other half of issuing. An EDITOR who could turn off the OWNER's
    // integration key holds a lever over an organization it does not own.
    await expect(
      revokeApiKey("key_1", "org_1", "editor-user", prisma),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });

    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  test("a VIEWER cannot list them", async () => {
    armWrites();
    actAs("VIEWER");

    // The listing carries no secret and is still the organization's
    // access-control list: which integrations exist, when they were issued,
    // which were withdrawn.
    await expect(
      listApiKeys("org_1", "viewer-user", prisma),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });

    expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
  });

  test("a VIEWER cannot read the audit trail", async () => {
    armWrites();
    actAs("VIEWER");

    await expect(
      listAuditEvents("org_1", "viewer-user", prisma),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });

    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});

describe("a quota is not something the tenant it bills can raise", () => {
  test("an OWNER cannot set one", async () => {
    armWrites();
    actAs("OWNER");

    // This is the deviation worth being explicit about. Gating `setQuota` with
    // `member:manage` — the strictest thing a tenant role can be asked for —
    // would have been *worse than leaving it open*: OWNER holds it, every
    // organization has an OWNER, and the OWNER is the person the quota bills.
    // The gate would have let a customer raise their own spending cap while
    // reading as a security improvement.
    await expect(
      setQuota(
        { organizationId: "org_1", metric: "AI_GENERATED_PAGES", limit: 1_000_000 },
        "owner-user",
        prisma,
      ),
    ).rejects.toMatchObject({ name: "UnauthorizedError" });

    expect(prisma.organizationQuota.upsert).not.toHaveBeenCalled();
  });

  test("an API key cannot set one, whatever role it holds", async () => {
    armWrites();
    actAs("OWNER");

    // Keys are issued *to* organizations, by a function this same boundary
    // guards. A key that satisfied the platform check would be a tenant
    // credential holding platform authority.
    await expect(
      setQuota(
        { organizationId: "org_1", metric: "AI_GENERATED_PAGES", limit: 1_000_000 },
        "apikey:key_1",
        prisma,
      ),
    ).rejects.toMatchObject({ name: "UnauthorizedError" });
  });

  test("configuring a key as the platform operator does not make it one", () => {
    // The case the test above does *not* cover, and the reason the `apikey:`
    // guard exists at all: an operator who sets the env var to a machine
    // credential, reasoning that their CI should be able to manage plans.
    //
    // It is refused even though the id matches exactly. A key is minted by
    // `generateApiKey`, which is guarded by a tenant role — so honouring this
    // would mean any OWNER could mint themselves platform authority in one
    // call. The configuration is a mistake, and the safe reading of a mistake
    // here is no.
    expect(
      isPlatformOperator("apikey:key_admin", {
        [PLATFORM_OPERATOR_ENV_VAR]: "apikey:key_admin",
      }),
    ).toBe(false);

    // And the same id without the prefix is accepted, so the refusal is the
    // prefix doing the work rather than the comparison being broken.
    expect(
      isPlatformOperator("key_admin", { [PLATFORM_OPERATOR_ENV_VAR]: "key_admin" }),
    ).toBe(true);
  });

  test("an absent or malformed identity is not the platform", () => {
    // `undefined` reaching a gate is how an optional parameter fails, and
    // `""` is what a trimmed header leaves behind. Neither is a principal.
    for (const notAPrincipal of [undefined, null, "", 0, {}]) {
      expect(isPlatformOperator(notAPrincipal)).toBe(false);
    }
  });

  test("the platform operator can", async () => {
    armWrites();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.organizationQuota.upsert.mockResolvedValue({} as any);
    armQuotaGate(prisma, { limit: 500, used: 0 });

    await setQuota(
      { organizationId: "org_1", metric: "AI_GENERATED_PAGES", limit: 500 },
      "local-operator",
      prisma,
    );

    expect(prisma.organizationQuota.upsert).toHaveBeenCalledTimes(1);
  });

  test("the refusal does not suggest asking for a bigger role", async () => {
    armWrites();
    actAs("OWNER");

    const refused = await setQuota(
      { organizationId: "org_1", metric: "AI_GENERATED_PAGES", limit: 9 },
      "owner-user",
      prisma,
    ).then(
      () => null,
      (error: unknown) => error as Error,
    );

    // `UnauthorizedError`, not `AccessDeniedError` — and the distinction is in
    // the `detail`, because the public `message` on this class is deliberately
    // one word for every cause. "Your role is too weak" invites an operator to
    // go and get a bigger one, and no tenant role satisfies this.
    expect(refused?.name).toBe("UnauthorizedError");
    expect((refused as { detail?: string } | null)?.detail).toMatch(
      /no tenant role grants it/i,
    );
  });
});

describe("reaching a page is not permission to rewrite it", () => {
  test("a VIEWER cannot refresh one", async () => {
    armWrites();
    actAs("VIEWER");

    await expect(
      saveRefreshedPage(
        "prj_1",
        { slug: "s", title: "t", metaDescription: "m", h1: "h", content: {} },
        "viewer-user",
        prisma,
      ),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });

    // The scope predicate alone would have allowed this: a VIEWER can reach
    // every page in their organization. What it would have written is a page
    // stamped MANUAL, which is permanently exempt from regeneration — damage
    // that outlives the person doing it.
    expect(prisma.generatedPage.updateMany).not.toHaveBeenCalled();
  });

  test("an EDITOR can", async () => {
    armWrites();
    actAs("EDITOR");

    const written = await saveRefreshedPage(
      "prj_1",
      { slug: "s", title: "t", metaDescription: "m", h1: "h", content: {} },
      "editor-user",
      prisma,
    );

    expect(written).toBe(true);
  });
});
