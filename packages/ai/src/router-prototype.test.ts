import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONTENT_PROFILE, type ContentProfile } from "@staticforge/schemas";

import { UnknownContentProfileError, createAuthoringRouter } from "./router.js";
import type { AuthoringService } from "./mock.js";

/**
 * A registry is an object literal, and an object literal inherits
 * `Object.prototype`.
 *
 * So a bare index lookup answers for names nobody registered: `constructor`
 * returns a function, `toString` returns a function, `valueOf` returns a
 * function. None of them is undefined, which means every `=== undefined` guard
 * and every `??` fallback built on such a lookup silently does not fire — and
 * the value that reaches the code below is not a profile at all.
 *
 * `contentProfileId` is a free-text column an operator controls, so this is
 * reachable from tenant data rather than only from a typo.
 */

const PROFILES: Record<string, ContentProfile> = {
  [DEFAULT_CONTENT_PROFILE.id]: DEFAULT_CONTENT_PROFILE,
};

/** A factory that records what it was handed. */
function spyFactory(): {
  factory: (profile: ContentProfile) => AuthoringService;
  seen: unknown[];
} {
  const seen: unknown[] = [];
  const service = {
    authorPage: vi.fn().mockResolvedValue(undefined),
    refreshPage: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthoringService;

  return {
    seen,
    factory: (profile) => {
      seen.push(profile);
      return service;
    },
  };
}

describe("createAuthoringRouter refuses inherited names", () => {
  test.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "%s is not a registered profile",
    async (name) => {
      const { factory, seen } = spyFactory();
      const router = createAuthoringRouter(factory, PROFILES);

      await expect(
        router.authorPage({
          businessName: "Acme",
          serviceName: "Reinigung",
          cityName: "Essen",
          contentProfileId: name,
        }),
      ).rejects.toBeInstanceOf(UnknownContentProfileError);

      // The failure has to happen before the factory is reached: building a
      // prompt from `Object` is the outcome this guard exists to prevent.
      expect(seen).toEqual([]);
    },
  );

  test("a genuinely registered profile still routes", async () => {
    const { factory, seen } = spyFactory();
    const router = createAuthoringRouter(factory, PROFILES);

    await router
      .authorPage({
        businessName: "Acme",
        serviceName: "Reinigung",
        cityName: "Essen",
        contentProfileId: DEFAULT_CONTENT_PROFILE.id,
      })
      .catch(() => undefined);

    expect(seen).toEqual([DEFAULT_CONTENT_PROFILE]);
  });

  test("an unregistered ordinary name is refused as before", async () => {
    const { factory } = spyFactory();
    const router = createAuthoringRouter(factory, PROFILES);

    await expect(
      router.authorPage({
        businessName: "Acme",
        serviceName: "Reinigung",
        cityName: "Essen",
        contentProfileId: "invented",
      }),
    ).rejects.toBeInstanceOf(UnknownContentProfileError);
  });

  test("a registry with no prototype behaves identically", async () => {
    // Guards the premise: the fix must be about own-property lookup, not about
    // this particular registry's shape.
    const bare = Object.assign(Object.create(null) as Record<string, ContentProfile>, {
      [DEFAULT_CONTENT_PROFILE.id]: DEFAULT_CONTENT_PROFILE,
    });
    const { factory } = spyFactory();
    const router = createAuthoringRouter(factory, bare);

    await expect(
      router.authorPage({
        businessName: "Acme",
        serviceName: "Reinigung",
        cityName: "Essen",
        contentProfileId: "constructor",
      }),
    ).rejects.toBeInstanceOf(UnknownContentProfileError);
  });
});
