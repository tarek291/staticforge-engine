import test from "node:test";
import assert from "node:assert/strict";
import type { GeneratedPageContent, PagePromptDetails } from "@staticforge/ai";
import type {
  Business,
  GeneratedPage,
  Location,
  Service,
} from "@staticforge/schemas";
import { buildPages } from "./build-pages.js";
import { applyAiContent, type GenerateContentFn } from "./ai-content.js";
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

const svcA: Service = {
  id: "svc-a",
  name: "Service A",
  slug: "service-a",
  description: "A".repeat(120),
  benefits: ["b1", "b2", "b3"],
  // Non-default template, so the test proves templateId survives the merge
  // rather than being reset to "default".
  templateId: "luxuryLanding",
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
  city: "Betaville",
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

const input: ValidatedInputData = {
  businesses: [business],
  services: [svcA, svcB],
  locations: [locA, locB],
  content,
};

/** Deterministic baseline: 2 services × 2 locations → 4 pages. */
function baseline(): GeneratedPage[] {
  return buildPages(input, { locale: "en" });
}

/** Fake AI output, distinct per call so per-page mapping is observable. */
function fakeContent(details: PagePromptDetails): GeneratedPageContent {
  const tag = `${details.serviceName}/${details.cityName}`;
  return {
    title: `AI title ${tag}`,
    metaDescription: `AI meta ${tag}`,
    h1: `AI h1 ${tag}`,
    content: {
      hero: { heading: `AI hero ${tag}`, subheading: `AI sub ${tag}` },
      sections: [{ heading: `AI section ${tag}`, body: `AI body ${tag}` }],
      faq: [{ question: `AI q ${tag}`, answer: `AI a ${tag}` }],
      cta: { heading: `AI cta ${tag}`, buttonLabel: "AI go", href: "#contact" },
    },
  };
}

/** Stub generator that records the details it was called with. */
function stub(): { fn: GenerateContentFn; calls: PagePromptDetails[] } {
  const calls: PagePromptDetails[] = [];
  const fn: GenerateContentFn = (details) => {
    calls.push(details);
    return Promise.resolve(fakeContent(details));
  };
  return { fn, calls };
}

/** `delayMs: 0` keeps the suite fast; the real pacing is exercised in the CLI. */
const noDelay = { delayMs: 0 } as const;

test("applyAiContent leaves every deterministic field untouched", async () => {
  const before = baseline();
  const after = await applyAiContent(before, input, stub().fn, noDelay);

  assert.equal(after.length, before.length);

  for (const [index, page] of after.entries()) {
    const original = before[index];
    assert.ok(original !== undefined);

    assert.equal(page.slug, original.slug);
    assert.equal(page.locale, original.locale);
    assert.equal(page.templateId, original.templateId);
    assert.equal(page.businessId, original.businessId);
    assert.equal(page.serviceId, original.serviceId);
    assert.equal(page.locationId, original.locationId);
    assert.deepEqual(page.schemaOrg, original.schemaOrg);
  }
});

test("applyAiContent preserves a non-default templateId", async () => {
  const before = baseline();
  const after = await applyAiContent(before, input, stub().fn, noDelay);

  const luxury = after.filter((page) => page.serviceId === "svc-a");
  assert.equal(luxury.length, 2);
  for (const page of luxury) {
    assert.equal(page.templateId, "luxuryLanding");
  }
});

test("applyAiContent replaces every authored content field", async () => {
  const before = baseline();
  const after = await applyAiContent(before, input, stub().fn, noDelay);

  for (const [index, page] of after.entries()) {
    const original = before[index];
    assert.ok(original !== undefined);

    assert.ok(page.title.startsWith("AI title "));
    assert.ok(page.metaDescription.startsWith("AI meta "));
    assert.ok(page.h1.startsWith("AI h1 "));
    assert.ok(page.content.hero.heading.startsWith("AI hero "));
    assert.equal(page.content.sections.length, 1);
    assert.equal(page.content.faq.length, 1);
    assert.equal(page.content.cta.href, "#contact");

    // The deterministic values really were displaced, not coincidentally equal.
    assert.notEqual(page.title, original.title);
    assert.notEqual(page.h1, original.h1);
    assert.notDeepEqual(page.content, original.content);
  }
});

test("applyAiContent passes the right entity names for each page", async () => {
  const before = baseline();
  const { fn, calls } = stub();
  await applyAiContent(before, input, fn, noDelay);

  assert.equal(calls.length, before.length);

  for (const [index, call] of calls.entries()) {
    const page = before[index];
    assert.ok(page !== undefined);

    const service = input.services.find((item) => item.id === page.serviceId);
    const location = input.locations.find((item) => item.id === page.locationId);

    assert.equal(call.businessName, business.name);
    assert.equal(call.serviceName, service?.name);
    assert.equal(call.cityName, location?.city);
  }
});

test("applyAiContent does not mutate the pages it was given", async () => {
  const before = baseline();
  const snapshot = structuredClone(before);

  await applyAiContent(before, input, stub().fn, noDelay);

  assert.deepEqual(before, snapshot);
});

test("applyAiContent rejects authored content that breaks the page schema", async () => {
  const before = baseline();

  // 71 characters — one over the GeneratedPageSchema title limit. A stub can
  // return this because it bypasses the Zod parse inside generatePageContent,
  // which is exactly what the re-validation in applyAiContent guards against.
  const overlongTitle: GenerateContentFn = (details) =>
    Promise.resolve({ ...fakeContent(details), title: "T".repeat(71) });

  await assert.rejects(
    () => applyAiContent(before, input, overlongTitle, noDelay),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.entityType, "ai-content");
      assert.ok(
        error.issues.some((issue) => issue.path.includes(".title")),
        "expected an issue pointing at the title field",
      );
      return true;
    },
  );
});

test("applyAiContent fails loudly when a page references an unknown entity", async () => {
  const [first] = baseline();
  assert.ok(first !== undefined);

  const orphan: GeneratedPage = { ...first, serviceId: "svc-missing" };

  await assert.rejects(
    () => applyAiContent([orphan], input, stub().fn, noDelay),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.entityType, "ai-content");
      assert.ok(
        error.issues.some((issue) => issue.message.includes("svc-missing")),
        "expected the unknown service id in the issue message",
      );
      return true;
    },
  );
});

test("applyAiContent reports progress once per page, in order", async () => {
  const before = baseline();
  const seen: Array<{ done: number; total: number; slug: string }> = [];

  await applyAiContent(before, input, stub().fn, {
    ...noDelay,
    onProgress: (progress) => seen.push(progress),
  });

  assert.equal(seen.length, before.length);
  seen.forEach((progress, index) => {
    const page = before[index];
    assert.ok(page !== undefined);
    assert.equal(progress.done, index + 1);
    assert.equal(progress.total, before.length);
    assert.equal(progress.slug, page.slug);
  });
});

test("applyAiContent returns an empty result without calling the generator", async () => {
  const { fn, calls } = stub();
  const result = await applyAiContent([], input, fn, noDelay);

  assert.deepEqual(result, []);
  assert.equal(calls.length, 0);
});
