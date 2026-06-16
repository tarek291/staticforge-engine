import test from "node:test";
import assert from "node:assert/strict";
import type { Business, Service, Location } from "@staticforge/schemas";
import { toTelHref } from "@staticforge/core";
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

// --- Business-level eligibility (serviceIds / locationIds) ---

// Distinct slugs (2 services × 2 locations → 4 unique pages by default).
const svcA: Service = {
  id: "svc-a",
  name: "Service A",
  slug: "service-a",
  description: "A".repeat(120),
  benefits: ["b1", "b2", "b3"],
};
const svcB: Service = {
  id: "svc-b",
  name: "Service B",
  slug: "service-b",
  description: "B".repeat(120),
  benefits: ["b1", "b2", "b3"],
};
const locA: Location = {
  id: "loc-a",
  city: "Alphaville",
  state: "Sample State",
  country: "DE",
};
const locB: Location = {
  id: "loc-b",
  city: "Betatown",
  state: "Sample State",
  country: "DE",
};

function eligibilityInput(overrides: Partial<Business>): ValidatedInputData {
  return {
    businesses: [{ ...business, ...overrides }],
    services: [svcA, svcB],
    locations: [locA, locB],
    content,
  };
}

test("eligibility: serviceIds narrows pages to the selected services", () => {
  const pages = buildPages(eligibilityInput({ serviceIds: ["svc-a"] }), {
    locale: "en",
  });
  assert.equal(pages.length, 2); // svc-a × 2 locations
  assert.ok(pages.every((page) => page.serviceId === "svc-a"));
});

test("eligibility: locationIds narrows pages to the selected locations", () => {
  const pages = buildPages(eligibilityInput({ locationIds: ["loc-a"] }), {
    locale: "en",
  });
  assert.equal(pages.length, 2); // 2 services × loc-a
  assert.ok(pages.every((page) => page.locationId === "loc-a"));
});

test("eligibility: undefined serviceIds/locationIds keeps all combinations", () => {
  const pages = buildPages(eligibilityInput({}), { locale: "en" });
  assert.equal(pages.length, 4);
});

test("eligibility: empty serviceIds produces zero pages", () => {
  const pages = buildPages(eligibilityInput({ serviceIds: [] }), {
    locale: "en",
  });
  assert.equal(pages.length, 0);
});

test("eligibility: empty locationIds produces zero pages", () => {
  const pages = buildPages(eligibilityInput({ locationIds: [] }), {
    locale: "en",
  });
  assert.equal(pages.length, 0);
});

test("eligibility: unknown serviceIds throws ValidationError", () => {
  assert.throws(
    () =>
      buildPages(eligibilityInput({ serviceIds: ["svc-missing"] }), {
        locale: "en",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(
        error.issues.some((issue) =>
          issue.message.includes("Unknown service id"),
        ),
        "expected an unknown-service-id issue",
      );
      return true;
    },
  );
});

test("eligibility: unknown locationIds throws ValidationError", () => {
  assert.throws(
    () =>
      buildPages(eligibilityInput({ locationIds: ["loc-missing"] }), {
        locale: "en",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(
        error.issues.some((issue) =>
          issue.message.includes("Unknown location id"),
        ),
        "expected an unknown-location-id issue",
      );
      return true;
    },
  );
});

// --- Placeholder validation (interpolated content fields only) ---

function contentInput(contentOverride: StaticContentTemplate): ValidatedInputData {
  return {
    businesses: [business],
    services: [svcA],
    locations: [locA],
    content: contentOverride,
  };
}

test("placeholders: unknown placeholder in hero.titleTemplate throws", () => {
  const bad: StaticContentTemplate = {
    ...content,
    hero: { ...content.hero, titleTemplate: "{{region}} in {{city}}" },
  };
  assert.throws(
    () => buildPages(contentInput(bad), { locale: "en" }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(
        error.issues.some(
          (issue) =>
            issue.path === "content.hero.titleTemplate" &&
            issue.message.includes('Unknown placeholder "{{region}}"'),
        ),
        "expected an unknown-placeholder issue on titleTemplate",
      );
      return true;
    },
  );
});

test("placeholders: unknown placeholder in hero.subtitleTemplate throws", () => {
  const bad: StaticContentTemplate = {
    ...content,
    hero: { ...content.hero, subtitleTemplate: "About {{unknown}}." },
  };
  assert.throws(
    () => buildPages(contentInput(bad), { locale: "en" }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(
        error.issues.some(
          (issue) =>
            issue.path === "content.hero.subtitleTemplate" &&
            issue.message.includes('Unknown placeholder "{{unknown}}"'),
        ),
        "expected an unknown-placeholder issue on subtitleTemplate",
      );
      return true;
    },
  );
});

test("placeholders: unknown placeholder in a FAQ question or answer throws", () => {
  const bad: StaticContentTemplate = {
    ...content,
    faqs: [
      { q: "What about {{region}}?", a: "A1" },
      { q: "Q2", a: "A2" },
      { q: "Q3", a: "A3" },
    ],
  };
  assert.throws(
    () => buildPages(contentInput(bad), { locale: "en" }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(
        error.issues.some(
          (issue) =>
            issue.path === "content.faqs[0].q" &&
            issue.message.includes('Unknown placeholder "{{region}}"'),
        ),
        "expected an unknown-placeholder issue on a FAQ field",
      );
      return true;
    },
  );
});

test("placeholders: valid placeholders interpolate without residual tokens", () => {
  const pages = buildPages(contentInput(content), { locale: "en" });
  assert.equal(pages.length, 1);
  const [page] = pages;
  assert.ok(page);
  assert.ok(!page.title.includes("{{"));
  assert.ok(!page.h1.includes("{{"));
  assert.ok(!page.metaDescription.includes("{{"));
  assert.ok(!page.content.hero.subheading?.includes("{{"));
});

// --- SEO output invariants (current/default generated path) ---

test("seo: generated pages carry valid title/metaDescription/h1 and schemaOrg basics", () => {
  // Multi-page set with placeholder-driven distinct titles (2 services × 2 locations).
  const pages = buildPages(eligibilityInput({}), { locale: "en" });
  assert.ok(pages.length >= 2);

  for (const page of pages) {
    assert.ok(page.title.length > 0, "title is non-empty");
    assert.ok(page.title.length <= 70, "title within 70 chars");
    assert.ok(page.metaDescription.length > 0, "metaDescription is non-empty");
    assert.ok(
      page.metaDescription.length <= 160,
      "metaDescription within 160 chars",
    );
    assert.ok(page.h1.length > 0, "h1 is non-empty");

    const { schemaOrg } = page;
    assert.ok(
      typeof schemaOrg === "object" &&
        schemaOrg !== null &&
        Object.keys(schemaOrg).length > 0,
      "schemaOrg is a non-empty object",
    );
    assert.ok("@context" in schemaOrg, "schemaOrg has @context");
    assert.ok("@type" in schemaOrg, "schemaOrg has @type");
  }

  // For this default placeholder-driven set, SEO text is unique per page.
  const titles = pages.map((page) => page.title);
  assert.equal(new Set(titles).size, titles.length, "titles are unique");
  const metaDescriptions = pages.map((page) => page.metaDescription);
  assert.equal(
    new Set(metaDescriptions).size,
    metaDescriptions.length,
    "metaDescriptions are unique",
  );
});

// --- CTA href derives from the business contact email ---

test("cta: generated cta.href is a mailto link to the business contact email", () => {
  const pages = buildPages(eligibilityInput({}), { locale: "en" });
  assert.ok(pages.length >= 1);

  for (const page of pages) {
    const href = page.content.cta.href;
    assert.equal(href, `mailto:${business.contactEmail}`);
    assert.notEqual(href, "#contact");
    assert.ok(href.startsWith("mailto:"), "href starts with mailto:");
    assert.ok(href.length > 0, "href is non-empty");
  }
});

// --- Optional secondary (tel) CTA in generated output (not rendered yet) ---

test("cta: secondary tel CTA is emitted for a valid phone + non-empty label", () => {
  const pages = buildPages(eligibilityInput({}), { locale: "en" });
  assert.ok(pages.length >= 1);

  for (const page of pages) {
    // Primary mailto CTA is unchanged.
    assert.equal(page.content.cta.href, `mailto:${business.contactEmail}`);

    const secondary = page.content.cta.secondary;
    assert.ok(secondary, "secondary CTA should be present");
    assert.equal(secondary.buttonLabel, content.cta.secondary);
    assert.ok(secondary.href.startsWith("tel:"), "secondary href starts with tel:");
    assert.equal(secondary.href, toTelHref(business.contactPhone));
  }
});

test("cta: secondary CTA is omitted when the phone is invalid", () => {
  const pages = buildPages(eligibilityInput({ contactPhone: "12345" }), {
    locale: "en",
  });
  for (const page of pages) {
    assert.equal(page.content.cta.secondary, undefined);
    // Primary CTA still intact.
    assert.equal(page.content.cta.href, `mailto:${business.contactEmail}`);
  }
});

test("cta: secondary CTA is omitted when the secondary label is empty", () => {
  const emptySecondary: StaticContentTemplate = {
    ...content,
    cta: { ...content.cta, secondary: "   " },
  };
  const pages = buildPages(contentInput(emptySecondary), { locale: "en" });
  for (const page of pages) {
    assert.equal(page.content.cta.secondary, undefined);
  }
});
