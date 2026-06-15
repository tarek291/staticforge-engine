import test from "node:test";
import assert from "node:assert/strict";
import type { Business, Service, Location } from "@staticforge/schemas";
import { buildPages } from "./build-pages.js";
import { ValidationError } from "./errors.js";
import type { StaticContentTemplate, ValidatedInputData } from "./types.js";

const business: Business = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Test Co",
  slug: "test-co",
  niche: "cleaning",
  description: "A".repeat(60),
  contactEmail: "info@example.com",
  contactPhone: "+1 555 0100",
  address: {
    street: "1 Main St",
    city: "Sampleton",
    state: "Sample State",
    postalCode: "00000",
    country: "DE",
  },
};

const service: Service = {
  id: "svc-1",
  name: "Cleaning",
  slug: "cleaning",
  description: "C".repeat(120),
  benefits: ["b1", "b2", "b3"],
};

// Two locations whose city normalizes to the same slug → identical page slug.
const locationA: Location = {
  id: "loc-a",
  city: "Sampleton",
  state: "Sample State",
  country: "DE",
};
const locationB: Location = {
  id: "loc-b",
  city: "Sampleton",
  state: "Sample State",
  country: "DE",
};

const content: StaticContentTemplate = {
  hero: {
    titleTemplate: "{{service}} in {{city}}",
    subtitleTemplate: "{{service}} in {{city}} from {{business}}.",
  },
  cta: { primary: "Contact", secondary: "Call" },
  faqs: [
    { q: "Q1", a: "A1" },
    { q: "Q2", a: "A2" },
    { q: "Q3", a: "A3" },
  ],
};

const duplicateInput: ValidatedInputData = {
  businesses: [business],
  services: [service],
  locations: [locationA, locationB],
  content,
};

test("buildPages throws ValidationError for duplicate generated slugs", () => {
  assert.throws(
    () => buildPages(duplicateInput, { locale: "en" }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.entityType, "pages");
      assert.ok(
        error.issues.some((issue) => issue.message.includes("Duplicate slug")),
        "expected a duplicate-slug issue",
      );
      return true;
    },
  );
});

test("buildPages succeeds when generated slugs are unique", () => {
  const uniqueInput: ValidatedInputData = {
    ...duplicateInput,
    locations: [locationA],
  };
  const pages = buildPages(uniqueInput, { locale: "en" });
  assert.equal(pages.length, 1);
});
