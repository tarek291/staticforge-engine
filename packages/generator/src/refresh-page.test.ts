import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildMockContent,
  createMockService,
  type AuthoredContent,
  type RefreshRequest,
} from "@staticforge/ai";
import {
  DEFAULT_CONTENT_PROFILE,
  type Business,
  type GeneratedPage,
  type Location,
  type Service,
} from "@staticforge/schemas";
import { withInternalLinks } from "@staticforge/core";

import { applyAiContent } from "./ai-content.js";
import { buildPages } from "./build-pages.js";
import { ValidationError } from "./errors.js";
import { computeContentHash, refreshPage, type RefreshContentFn } from "./refresh-page.js";
import type { StaticContentTemplate, ValidatedInputData } from "./types.js";

/**
 * A refresh must change the content and nothing else.
 *
 * The changing half is easy to see. The *not* changing half is what these tests
 * are really for: a revised slug orphans every inbound link and breaks a
 * published URL, and revised links break the graph — both invisible until a
 * crawler finds them.
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

const svcA: Service = {
  id: "svc-a",
  name: "Service A",
  slug: "service-a",
  description: "A".repeat(120),
  benefits: ["b1", "b2", "b3"],
  templateId: "luxuryLanding",
};

const svcB: Service = {
  id: "svc-b",
  name: "Service B",
  slug: "service-b",
  description: "B".repeat(120),
  benefits: ["b1", "b2", "b3"],
};

const locA: Location = { id: "loc-a", city: "Alphaville", state: "S", country: "DE" };
const locB: Location = { id: "loc-b", city: "Betaville", state: "S", country: "DE" };

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

/** A generated, authored, linked page — the state a refresh actually starts from. */
async function livePage(): Promise<GeneratedPage> {
  const mock = createMockService({ sleepFn: () => Promise.resolve() });
  const authored = await applyAiContent(
    buildPages(input, { locale: "en" }),
    input,
    (request) => mock.authorPage(request),
    { delayMs: 0 },
  );

  const linked = withInternalLinks(authored);
  const page = linked[0];
  assert.ok(page !== undefined);
  return page;
}

/** A refresh function that records its request and returns distinct content. */
function refresher(): { fn: RefreshContentFn; calls: RefreshRequest[] } {
  const calls: RefreshRequest[] = [];

  const fn: RefreshContentFn = (request) => {
    calls.push(request);
    const revised = buildMockContent(request, DEFAULT_CONTENT_PROFILE);

    return Promise.resolve<AuthoredContent>({
      content: { ...revised, title: `Revised: ${revised.title}`.slice(0, 70) },
      provenance: {
        promptVersion: "refresh-prompt",
        modelVersion: "refresh-model",
        profileId: DEFAULT_CONTENT_PROFILE.id,
        sourceHash: undefined,
        cacheHit: false,
      },
    });
  };

  return { fn, calls };
}

// --- What must not change --------------------------------------------------

test("a refresh keeps the slug, so no published URL moves", async () => {
  const before = await livePage();
  const { page } = await refreshPage(before, input, "Be more formal.", refresher().fn);

  assert.equal(page.slug, before.slug);
});

test("a refresh keeps the internal links exactly", async () => {
  const before = await livePage();
  assert.ok(before.links.length > 0, "fixture must carry links to be meaningful");

  const { page } = await refreshPage(before, input, "Add pricing detail.", refresher().fn);

  // Revised links would break the graph Phase 05 guarantees is sound.
  assert.deepEqual(page.links, before.links);
});

test("a refresh keeps every field that was resolved by rules, not written", async () => {
  const before = await livePage();
  const { page } = await refreshPage(before, input, "Shorter sentences.", refresher().fn);

  assert.equal(page.templateId, before.templateId);
  assert.equal(page.contentProfileId, before.contentProfileId);
  assert.equal(page.locale, before.locale);
  assert.equal(page.businessId, before.businessId);
  assert.equal(page.serviceId, before.serviceId);
  assert.equal(page.locationId, before.locationId);
  assert.deepEqual(page.schemaOrg, before.schemaOrg);
});

test("the visual template survives a refresh", async () => {
  const before = await livePage();
  assert.equal(before.templateId, "luxuryLanding");

  const { page } = await refreshPage(before, input, "Warmer tone.", refresher().fn);

  assert.equal(page.templateId, "luxuryLanding");
});

// --- What must change ------------------------------------------------------

test("a refresh changes the content", async () => {
  const before = await livePage();
  const { page } = await refreshPage(before, input, "Be more formal.", refresher().fn);

  assert.notEqual(page.title, before.title);
  assert.ok(page.title.startsWith("Revised: "));
});

test("a refresh changes the content hash", async () => {
  const before = await livePage();
  const { contentHash, previousContentHash, changed } = await refreshPage(
    before,
    input,
    "Add pricing detail.",
    refresher().fn,
  );

  assert.notEqual(contentHash, previousContentHash);
  assert.equal(changed, true);
  assert.match(contentHash, /^[0-9a-f]{16}$/);
});

test("a revision that changes nothing reports itself as unchanged", async () => {
  const before = await livePage();

  // Returning the current content is a legitimate answer — "already done" — and
  // is more useful reported than hidden.
  const noop: RefreshContentFn = () =>
    Promise.resolve({
      content: {
        title: before.title,
        metaDescription: before.metaDescription,
        h1: before.h1,
        content: before.content,
      },
      provenance: {
        promptVersion: "p",
        modelVersion: "m",
        profileId: "default",
        sourceHash: undefined,
        cacheHit: false,
      },
    });

  const result = await refreshPage(before, input, "Nothing to do.", noop);

  assert.equal(result.changed, false);
  assert.equal(result.contentHash, result.previousContentHash);
});

test("provenance records the revision, including the feedback that caused it", async () => {
  const before = await livePage();
  const { page } = await refreshPage(before, input, "Add pricing detail.", refresher().fn);

  assert.equal(page.generation?.promptVersion, "refresh-prompt");
  assert.equal(page.generation?.modelVersion, "refresh-model");
  assert.equal(page.generation?.refreshedFrom, "Add pricing detail.");
  assert.ok(page.generation?.generatedAt !== undefined);
  assert.notEqual(page.generation?.generatedAt, before.generation?.generatedAt);
});

test("the stored content hash matches the page it describes", async () => {
  const before = await livePage();
  const { page, contentHash } = await refreshPage(
    before,
    input,
    "Be more formal.",
    refresher().fn,
  );

  assert.equal(page.generation?.contentHash, contentHash);
  assert.equal(computeContentHash(page), contentHash);
});

// --- What the reviser is given ---------------------------------------------

test("the reviser sees the current content, not a blank page", async () => {
  const before = await livePage();
  const { fn, calls } = refresher();

  await refreshPage(before, input, "Be more formal.", fn);

  assert.equal(calls[0]?.current.title, before.title);
  assert.deepEqual(calls[0]?.current.content, before.content);
});

test("the reviser is held to the same verified record", async () => {
  const before = await livePage();
  const { fn, calls } = refresher();

  await refreshPage(before, input, "Add a price.", fn);

  // A rewrite is when an invention is easiest to slip in, so grounding is not
  // relaxed for it.
  assert.ok(calls[0]?.facts !== undefined);
  assert.equal(calls[0].facts.emails[0], business.contactEmail);
});

test("the reviser is held to the page's own content profile", async () => {
  const before = await livePage();
  const { fn, calls } = refresher();

  await refreshPage(before, input, "Tighten it.", fn);

  assert.equal(calls[0]?.contentProfileId, before.contentProfileId);
});

test("the feedback reaches the reviser verbatim", async () => {
  const before = await livePage();
  const { fn, calls } = refresher();

  await refreshPage(before, input, "Mention the 24h response window.", fn);

  assert.equal(calls[0]?.feedback, "Mention the 24h response window.");
});

// --- Failure -----------------------------------------------------------------

test("a revision that breaks the contract is rejected and nothing is returned", async () => {
  const before = await livePage();

  const overlong: RefreshContentFn = (request) =>
    Promise.resolve({
      content: {
        ...buildMockContent(request, DEFAULT_CONTENT_PROFILE),
        title: "T".repeat(71),
      },
      provenance: {
        promptVersion: "p",
        modelVersion: "m",
        profileId: "default",
        sourceHash: undefined,
        cacheHit: false,
      },
    });

  await assert.rejects(
    () => refreshPage(before, input, "Longer title.", overlong),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.entityType, "refresh");
      return true;
    },
  );
});

test("a page referencing an unknown entity cannot be revised", async () => {
  const before = await livePage();
  const orphan: GeneratedPage = { ...before, serviceId: "svc-missing" };

  await assert.rejects(
    () => refreshPage(orphan, input, "Anything.", refresher().fn),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.ok(error.issues.some((issue) => issue.message.includes("svc-missing")));
      return true;
    },
  );
});

test("refreshPage does not mutate the page it was given", async () => {
  const before = await livePage();
  const snapshot = structuredClone(before);

  await refreshPage(before, input, "Be more formal.", refresher().fn);

  assert.deepEqual(before, snapshot);
});

// --- The graph still holds --------------------------------------------------

test("a refreshed page still validates as part of the whole graph", async () => {
  const mock = createMockService({ sleepFn: () => Promise.resolve() });
  const authored = await applyAiContent(
    buildPages(input, { locale: "en" }),
    input,
    (request) => mock.authorPage(request),
    { delayMs: 0 },
  );
  const linked = withInternalLinks(authored);

  const target = linked[0];
  assert.ok(target !== undefined);

  const { page } = await refreshPage(target, input, "Be more formal.", refresher().fn);

  const { validateInternalLinks } = await import("@staticforge/core");
  const rebuilt = linked.map((item) => (item.slug === page.slug ? page : item));

  // Substituting the revised page back into the build leaves the graph sound —
  // which is only true because slug and links survived.
  assert.deepEqual(validateInternalLinks(rebuilt), []);
});
