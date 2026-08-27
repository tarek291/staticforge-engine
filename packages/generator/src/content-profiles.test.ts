import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildMockContent,
  createAuthoringRouter,
  createMockService,
  UnknownContentProfileError,
  type GenerationRequest,
} from "@staticforge/ai";
import {
  CONTENT_PROFILES,
  DEFAULT_CONTENT_PROFILE,
  STRICT_SEO_PROFILE,
  collectContentIssues,
  type Business,
  type GeneratedPage,
  type Location,
  type Service,
} from "@staticforge/schemas";

import { applyAiContent, type GenerateContentFn } from "./ai-content.js";
import { buildPages } from "./build-pages.js";
import { ValidationError } from "./errors.js";
import type { StaticContentTemplate, ValidatedInputData } from "./types.js";

/**
 * `templateId` and `contentProfileId` are two independent axes.
 *
 * These tests exist to prove they stay independent: the same visual template
 * paired with different content profiles must produce genuinely different
 * output, and every combination of a valid template and a valid profile must
 * work. Coupling them would silently make most of that grid unreachable.
 */

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

const locA: Location = {
  id: "loc-a",
  city: "Alphaville",
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

/** A service, optionally pinning either axis. */
function service(
  id: string,
  overrides: Partial<Pick<Service, "templateId" | "contentProfileId">> = {},
): Service {
  return {
    id,
    name: `Service ${id}`,
    slug: `service-${id}`,
    description: "S".repeat(120),
    benefits: ["b1", "b2", "b3"],
    ...overrides,
  };
}

function input(
  services: Service[],
  contentOverrides: Partial<StaticContentTemplate> = {},
): ValidatedInputData {
  return {
    businesses: [business],
    services,
    locations: [locA],
    content: { ...content, ...contentOverrides },
  };
}

/** A router over mock services, so every profile is honoured for real. */
function router() {
  const seen: GenerationRequest[] = [];
  const routed = createAuthoringRouter((profile) => {
    const mock = createMockService({ profile, sleepFn: () => Promise.resolve() });
    return {
      authorPage: (request) => {
        seen.push(request);
        return mock.authorPage(request);
      },
    };
  });

  const fn: GenerateContentFn = (request) => routed.authorPage(request);
  return { fn, seen, routed };
}

// --- Resolution ------------------------------------------------------------

test("a page defaults to the default profile when nothing pins one", () => {
  const [page] = buildPages(input([service("a")]), { locale: "en" });

  assert.equal(page?.contentProfileId, "default");
  assert.equal(page?.templateId, "default");
});

test("a project-level content profile applies to every page", () => {
  const pages = buildPages(
    input([service("a"), service("b")], { contentProfileId: "strictSeo" }),
    { locale: "en" },
  );

  for (const page of pages) {
    assert.equal(page.contentProfileId, "strictSeo");
  }
});

test("a service-level content profile outranks the project one", () => {
  const pages = buildPages(
    input([service("a", { contentProfileId: "default" }), service("b")], {
      contentProfileId: "strictSeo",
    }),
    { locale: "en" },
  );

  assert.equal(pages.find((page) => page.serviceId === "a")?.contentProfileId, "default");
  assert.equal(pages.find((page) => page.serviceId === "b")?.contentProfileId, "strictSeo");
});

test("the two axes resolve independently of each other", () => {
  // A premium visual template over modest content, and the reverse.
  const pages = buildPages(
    input([
      service("a", { templateId: "luxuryLanding", contentProfileId: "default" }),
      service("b", { templateId: "default", contentProfileId: "strictSeo" }),
    ]),
    { locale: "en" },
  );

  const a = pages.find((page) => page.serviceId === "a");
  const b = pages.find((page) => page.serviceId === "b");

  assert.equal(a?.templateId, "luxuryLanding");
  assert.equal(a?.contentProfileId, "default");
  assert.equal(b?.templateId, "default");
  assert.equal(b?.contentProfileId, "strictSeo");
});

test("every template-and-profile combination builds", () => {
  const templates = ["default", "luxuryLanding"];
  const profiles = Object.keys(CONTENT_PROFILES);

  for (const templateId of templates) {
    for (const contentProfileId of profiles) {
      const pages = buildPages(input([service("a", { templateId, contentProfileId })]), {
        locale: "en",
      });

      assert.equal(pages.length, 1, `${templateId} × ${contentProfileId}`);
      assert.equal(pages[0]?.templateId, templateId);
      assert.equal(pages[0]?.contentProfileId, contentProfileId);
    }
  }
});

test("an unknown content profile fails the build loudly", () => {
  // Unlike an unknown templateId, which the web registry catches: a profile is
  // consumed by the engine itself, so generating against a missing one would
  // mean applying no rules at all.
  assert.throws(
    () => buildPages(input([service("a", { contentProfileId: "notAProfile" })]), {
      locale: "en",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(
        error.issues.some((issue) => issue.message.includes('Unknown contentProfileId "notAProfile"')),
      );
      return true;
    },
  );
});

test("an unknown template does not fail the build, because rendering owns that", () => {
  // The asymmetry is deliberate and worth pinning down.
  const pages = buildPages(input([service("a", { templateId: "notARegisteredView" })]), {
    locale: "en",
  });

  assert.equal(pages[0]?.templateId, "notARegisteredView");
});

// --- Routing ---------------------------------------------------------------

test("each page is authored against the profile it names", async () => {
  const pages = buildPages(
    input([
      service("a", { contentProfileId: "default" }),
      service("b", { contentProfileId: "strictSeo" }),
    ]),
    { locale: "en" },
  );

  const { fn, seen, routed } = router();
  await applyAiContent(pages, input([service("a"), service("b")]), fn, { delayMs: 0 });

  assert.deepEqual(
    seen.map((request) => request.contentProfileId).sort(),
    ["default", "strictSeo"],
  );
  // One service built per profile, on first use.
  assert.deepEqual([...routed.profilesUsed].sort(), ["default", "strictSeo"]);
});

test("a run with one profile builds exactly one service", async () => {
  const pages = buildPages(input([service("a"), service("b")]), { locale: "en" });

  const { fn, routed } = router();
  await applyAiContent(pages, input([service("a"), service("b")]), fn, { delayMs: 0 });

  // The common case must not be made more expensive by supporting the rare one.
  assert.deepEqual(routed.profilesUsed, ["default"]);
});

test("routing to an unregistered profile is rejected, not silently defaulted", async () => {
  const { routed } = router();

  await assert.rejects(
    () =>
      routed.authorPage({
        businessName: "b",
        serviceName: "s",
        cityName: "c",
        contentProfileId: "notAProfile",
      }),
    (error: unknown) => {
      assert.ok(error instanceof UnknownContentProfileError);
      return true;
    },
  );
});

// --- The payoff: same template, different profiles -------------------------

test("the same template with two profiles produces different content", async () => {
  const services = [
    service("a", { templateId: "luxuryLanding", contentProfileId: "default" }),
    service("b", { templateId: "luxuryLanding", contentProfileId: "strictSeo" }),
  ];
  const data = input(services);
  const pages = buildPages(data, { locale: "en" });

  const { fn } = router();
  const authored = await applyAiContent(pages, data, fn, { delayMs: 0 });

  const loose = authored.find((page) => page.serviceId === "a");
  const strict = authored.find((page) => page.serviceId === "b");

  assert.ok(loose !== undefined && strict !== undefined);

  // The visual template is identical …
  assert.equal(loose.templateId, "luxuryLanding");
  assert.equal(strict.templateId, "luxuryLanding");

  // … while the content is measurably different, because the profile decides
  // how much a page must carry.
  assert.ok(
    strict.content.sections.length > loose.content.sections.length,
    `strict ${strict.content.sections.length} vs loose ${loose.content.sections.length}`,
  );
  assert.ok(strict.content.faq.length > loose.content.faq.length);
  assert.ok(
    strict.content.sections[0]!.body.length > loose.content.sections[0]!.body.length,
  );
});

test("each page satisfies the profile it was held to, and not the other", () => {
  const looseContent = buildMockContent(
    { businessName: "B", serviceName: "S", cityName: "C" },
    DEFAULT_CONTENT_PROFILE,
  );

  const asPage = (partial: typeof looseContent): GeneratedPage => ({
    ...partial,
    slug: "s-c",
    locale: "en",
    schemaOrg: { "@type": "Service" },
    templateId: "luxuryLanding",
    contentProfileId: "default",
    businessId: business.id,
    serviceId: "a",
    locationId: "loc-a",
    links: [],
  });

  // Content sized for the loose profile clears it …
  assert.deepEqual(collectContentIssues(asPage(looseContent), DEFAULT_CONTENT_PROFILE), []);
  // … and fails the strict one, which is what makes the profiles meaningful.
  assert.ok(collectContentIssues(asPage(looseContent), STRICT_SEO_PROFILE).length > 0);
});

test("provenance records the profile that judged the page", async () => {
  const services = [service("a", { contentProfileId: "strictSeo" })];
  const data = input(services);

  const { fn } = router();
  const authored = await applyAiContent(buildPages(data, { locale: "en" }), data, fn, {
    delayMs: 0,
  });

  assert.equal(authored[0]?.generation?.profileId, "strictSeo");
  // And the page still records which template will render it, separately.
  assert.equal(authored[0]?.contentProfileId, "strictSeo");
  assert.equal(authored[0]?.templateId, "default");
});
