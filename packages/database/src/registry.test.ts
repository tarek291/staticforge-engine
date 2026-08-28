import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";
import { STRICT_SEO_PROFILE } from "@staticforge/schemas";

import {
  GLOBAL_OWNER_ID,
  RegistryLoadError,
  loadProfileRegistry,
  loadTemplateRegistry,
} from "./registry.js";

/**
 * A constant was checked by the compiler. A row is checked by nobody until
 * something checks it.
 *
 * That sentence is the whole reason this module exists, so most of what follows
 * is about rows that should never reach the engine: a definition missing a
 * field the generator reads, a template naming something that is not a view, a
 * row belonging to a tenant who is not asking.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
});

/** A stored profile row. */
function profileRow(over: Record<string, unknown> = {}) {
  return {
    key: "strictSeo",
    name: "Strict SEO",
    definition: STRICT_SEO_PROFILE,
    userId: GLOBAL_OWNER_ID,
    ...over,
  };
}

/** A stored template row. */
function templateRow(over: Record<string, unknown> = {}) {
  return {
    key: "luxuryLanding",
    name: "Luxury Landing",
    definition: { view: "luxuryLanding", description: "Dark, high-ticket." },
    userId: GLOBAL_OWNER_ID,
    ...over,
  };
}

/** Point the mock at a set of rows. */
function armProfiles(rows: unknown[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.contentProfile.findMany.mockResolvedValue(rows as any);
}

function armTemplates(rows: unknown[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.template.findMany.mockResolvedValue(rows as any);
}

describe("a valid definition loads for the matching tenant", () => {
  test("a global profile is available to everyone", async () => {
    armProfiles([profileRow()]);

    const registry = await loadProfileRegistry("user_a", prisma);

    expect(Object.keys(registry)).toEqual(["strictSeo"]);
    expect(registry.strictSeo?.title).toEqual(STRICT_SEO_PROFILE.title);
  });

  test("the row's key wins over whatever id the definition carries", async () => {
    armProfiles([
      profileRow({ key: "housePolicy", definition: { ...STRICT_SEO_PROFILE, id: "stale" } }),
    ]);

    const registry = await loadProfileRegistry("user_a", prisma);

    // Pages reference a profile by key. A definition whose id disagreed would
    // otherwise be resolvable under two names, only one of which is real.
    expect(registry.housePolicy?.id).toBe("housePolicy");
  });

  test("a tenant's own row overrides a global one with the same key", async () => {
    const mine = { ...STRICT_SEO_PROFILE, title: { min: 5, max: 40 } };

    armProfiles([
      profileRow({ key: "strictSeo", userId: GLOBAL_OWNER_ID }),
      profileRow({ key: "strictSeo", userId: "user_a", definition: mine }),
    ]);

    const registry = await loadProfileRegistry("user_a", prisma);

    // Overriding a shipped default is the ordinary case, not a conflict.
    expect(registry.strictSeo?.title).toEqual({ min: 5, max: 40 });
  });

  test("the override wins regardless of the order rows come back in", async () => {
    const mine = { ...STRICT_SEO_PROFILE, title: { min: 5, max: 40 } };

    armProfiles([
      profileRow({ key: "strictSeo", userId: "user_a", definition: mine }),
      profileRow({ key: "strictSeo", userId: GLOBAL_OWNER_ID }),
    ]);

    const registry = await loadProfileRegistry("user_a", prisma);

    expect(registry.strictSeo?.title).toEqual({ min: 5, max: 40 });
  });

  test("a template definition loads with its options", async () => {
    armTemplates([
      templateRow({
        definition: {
          view: "luxuryLanding",
          options: { density: "compact", showFaq: false },
        },
      }),
    ]);

    const registry = await loadTemplateRegistry("user_a", prisma);

    expect(registry.luxuryLanding?.definition.view).toBe("luxuryLanding");
    expect(registry.luxuryLanding?.definition.options?.density).toBe("compact");
  });
});

describe("the query is scoped, not filtered afterwards", () => {
  test("profiles are read as global-or-mine", async () => {
    armProfiles([]);

    await loadProfileRegistry("user_a", prisma);

    // "Not assigned yet" must never default to "available to everyone", so a
    // row that is neither global nor owned matches neither branch.
    expect(prisma.contentProfile.findMany.mock.calls[0]?.[0]?.where).toEqual({
      OR: [{ isGlobal: true }, { userId: "user_a" }],
    });
  });

  test("templates are read the same way", async () => {
    armTemplates([]);

    await loadTemplateRegistry("user_b", prisma);

    expect(prisma.template.findMany.mock.calls[0]?.[0]?.where).toEqual({
      OR: [{ isGlobal: true }, { userId: "user_b" }],
    });
  });

  test("an empty registry is a registry, not an error", async () => {
    armProfiles([]);

    await expect(loadProfileRegistry("user_a", prisma)).resolves.toEqual({});
  });
});

describe("a corrupt definition is refused, not skipped", () => {
  test("a profile missing a field the generator reads is rejected", async () => {
    const broken = { ...STRICT_SEO_PROFILE } as Record<string, unknown>;
    delete broken.faq;

    armProfiles([profileRow({ definition: broken })]);

    await expect(loadProfileRegistry("user_a", prisma)).rejects.toBeInstanceOf(
      RegistryLoadError,
    );
  });

  test("the error names the row and the field, not just the page that used it", async () => {
    const broken = { ...STRICT_SEO_PROFILE, title: { min: 90, max: 10 } };

    armProfiles([profileRow({ key: "housePolicy", definition: broken })]);

    try {
      await loadProfileRegistry("user_a", prisma);
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RegistryLoadError);
      const issues = (error as RegistryLoadError).issues;

      // Skipping the row would fail later with "unknown profile", pointing at a
      // page for a problem the page did not cause.
      expect(issues[0]?.kind).toBe("profile");
      expect(issues[0]?.key).toBe("housePolicy");
      expect(issues[0]?.message.length).toBeGreaterThan(0);
    }
  });

  test("definitions that are not objects at all are rejected", async () => {
    for (const definition of [null, 42, "strictSeo", [], {}]) {
      armProfiles([profileRow({ definition })]);

      await expect(
        loadProfileRegistry("user_a", prisma),
        JSON.stringify(definition),
      ).rejects.toBeInstanceOf(RegistryLoadError);
    }
  });

  test("a template naming something that is not an identifier is rejected", async () => {
    for (const view of ["", "../etc/passwd", "<script>", "a b", 42, null]) {
      armTemplates([templateRow({ definition: { view } })]);

      await expect(
        loadTemplateRegistry("user_a", prisma),
        String(view),
      ).rejects.toBeInstanceOf(RegistryLoadError);
    }
  });

  test("a template carrying an unknown key is rejected rather than ignored", async () => {
    // An unknown key is either a typo, dropping the tenant's intent silently,
    // or an attempt to reach a capability the schema declines to offer.
    armTemplates([
      templateRow({
        definition: { view: "default", html: "<script>alert(1)</script>" },
      }),
    ]);

    await expect(loadTemplateRegistry("user_a", prisma)).rejects.toBeInstanceOf(
      RegistryLoadError,
    );
  });

  test("a template option outside the allowed set is rejected", async () => {
    armTemplates([
      templateRow({ definition: { view: "default", options: { density: "enormous" } } }),
    ]);

    await expect(loadTemplateRegistry("user_a", prisma)).rejects.toBeInstanceOf(
      RegistryLoadError,
    );
  });

  test("every broken row is reported, not only the first", async () => {
    armProfiles([
      profileRow({ key: "a", definition: {} }),
      profileRow({ key: "b", definition: {} }),
    ]);

    try {
      await loadProfileRegistry("user_a", prisma);
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      const keys = new Set((error as RegistryLoadError).issues.map((i) => i.key));

      expect(keys).toEqual(new Set(["a", "b"]));
    }
  });

  test("one broken row poisons nothing else — the whole load fails", async () => {
    armProfiles([profileRow({ key: "good" }), profileRow({ key: "bad", definition: {} })]);

    // Half a registry is worse than none: the build would proceed with a policy
    // the tenant had edited away from and no indication that it had.
    await expect(loadProfileRegistry("user_a", prisma)).rejects.toBeInstanceOf(
      RegistryLoadError,
    );
  });
});

describe("the registry cannot answer for the prototype", () => {
  test("a loaded registry has no inherited keys", async () => {
    armProfiles([profileRow()]);

    const registry = await loadProfileRegistry("user_a", prisma);

    // Built with a null prototype, so a page naming "constructor" resolves to
    // nothing rather than to a function.
    expect(Object.getPrototypeOf(registry)).toBeNull();
    expect((registry as Record<string, unknown>).constructor).toBeUndefined();
    expect((registry as Record<string, unknown>).toString).toBeUndefined();
  });

  test("the same holds for templates", async () => {
    armTemplates([templateRow()]);

    const registry = await loadTemplateRegistry("user_a", prisma);

    expect((registry as Record<string, unknown>).constructor).toBeUndefined();
  });
});
