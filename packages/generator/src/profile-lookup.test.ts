import { test } from "vitest";
import assert from "node:assert/strict";
import type { Business, Location, Service } from "@staticforge/schemas";

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
