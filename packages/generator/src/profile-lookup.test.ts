import { test } from "vitest";
import assert from "node:assert/strict";
import type { Business, Location, Service } from "@staticforge/schemas";

import { DEFAULT_CONTENT_PROFILE, type ContentProfile } from "@staticforge/schemas";

import { buildPages } from "./build-pages.js";
import { ValidationError } from "./errors.js";
import type { StaticContentTemplate, ValidatedInputData } from "./types.js";

/**
 * `contentProfileId` is a free-text column an operator controls, and the
 * registry it is looked up in is an object literal — so it inherits
 * `Object.prototype`. A bare index for "constructor" returns a function rather
 * than undefined, which means the `=== undefined` check meant to reject an
 * unknown profile silently passes it instead.
 *
 * The engine's stated contract is that a typo surfaces loudly. These assert it
 * surfaces for the names that used to slip through.
 */

const business: Business = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme",
  niche: "cleaning",
  description: "D".repeat(80),
  contactEmail: "kontakt@acme.de",
  contactPhone: "+49 211 4567890",
  address: {
    street: "Musterstr 1",
    city: "Duisburg",
    state: "NRW",
    postalCode: "47051",
    country: "DE",
  },
};

const locations: Location[] = [
  { id: "loc-1", city: "Duisburg", state: "NRW", country: "DE" },
];

const content: StaticContentTemplate = {
  hero: {
    titleTemplate: "{{service}} in {{city}}",
    subtitleTemplate: "{{service}} in {{city}} von {{business}}.",
  },
  cta: { primary: "Anfragen", secondary: "Anrufen" },
  faqs: [
    { q: "Q1", a: "A1" },
    { q: "Q2", a: "A2" },
    { q: "Q3", a: "A3" },
  ],
};

/** Input whose single service names `profileId` as its content profile. */
function inputWithProfile(profileId: string): ValidatedInputData {
  const service: Service = {
    id: "svc-1",
    name: "Büroreinigung",
    slug: "bueroreinigung",
    description: "S".repeat(120),
    benefits: ["b1", "b2", "b3"],
    contentProfileId: profileId,
  };

  return { businesses: [business], services: [service], locations, content };
}

for (const inherited of [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
]) {
  test(`buildPages rejects the inherited name "${inherited}"`, () => {
    assert.throws(
      () => buildPages(inputWithProfile(inherited), { locale: "de" }),
      (error: unknown) => {
        assert.ok(error instanceof ValidationError);
        assert.ok(
          error.issues.some((issue) =>
            issue.message.includes(`Unknown contentProfileId "${inherited}"`),
          ),
          `expected a loud rejection, got: ${JSON.stringify(error.issues)}`,
        );
        return true;
      },
    );
  });
}

test("buildPages still accepts a registered profile", () => {
  const pages = buildPages(inputWithProfile("strictSeo"), { locale: "de" });

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.contentProfileId, "strictSeo");
});

test("buildPages still rejects an ordinary unknown profile", () => {
  assert.throws(
    () => buildPages(inputWithProfile("invented"), { locale: "de" }),
    ValidationError,
  );
});

test("buildPages accepts a profile the injected registry defines", () => {
  // The registry is data now: a tenant's own profile lives in a database row
  // and is handed in, rather than being compiled into the engine.
  const housePolicy: ContentProfile = { ...DEFAULT_CONTENT_PROFILE, id: "housePolicy" };

  const pages = buildPages(inputWithProfile("housePolicy"), {
    locale: "de",
    profiles: { housePolicy },
  });

  assert.equal(pages.length, 1);
  assert.equal(pages[0]?.contentProfileId, "housePolicy");
});

test("buildPages rejects a profile the injected registry does not define", () => {
  // Injection must not become a way around the check. A registry that omits a
  // profile is a registry that does not have it.
  assert.throws(
    () =>
      buildPages(inputWithProfile("strictSeo"), {
        locale: "de",
        profiles: { onlyThis: DEFAULT_CONTENT_PROFILE },
      }),
    ValidationError,
  );
});

test("buildPages falls back to the shipped profiles when none are injected", () => {
  // Local file mode has no database to ask, and must keep working exactly as
  // it did before profiles became rows.
  const pages = buildPages(inputWithProfile("strictSeo"), { locale: "de" });

  assert.equal(pages[0]?.contentProfileId, "strictSeo");
});

test("an injected registry with a null prototype still rejects inherited names", () => {
  const registry = Object.create(null) as Record<string, ContentProfile>;
  registry.housePolicy = { ...DEFAULT_CONTENT_PROFILE, id: "housePolicy" };

  assert.throws(
    () =>
      buildPages(inputWithProfile("constructor"), { locale: "de", profiles: registry }),
    ValidationError,
  );
});
