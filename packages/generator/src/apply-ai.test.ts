import { test } from "vitest";
import assert from "node:assert/strict";
import type {
  GeneratedPageContent,
  GenerationRequest,
} from "@staticforge/ai";
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
function fakeContent(details: GenerationRequest): GeneratedPageContent {
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

/** Provenance a stub reports, standing in for the real service's. */
const STUB_PROVENANCE = {
  promptVersion: "test-prompt",
  modelVersion: "test-model",
  profileId: "default",
  sourceHash: undefined,
  cacheHit: false,
};

/** Wrap bare content in the authored envelope the interface now returns. */
function authored(content: GeneratedPageContent, cacheHit = false) {
  return {
    content,
    provenance: { ...STUB_PROVENANCE, cacheHit },
  };
}

/** Stub generator that records the requests it was called with. */
function stub(): { fn: GenerateContentFn; calls: GenerationRequest[] } {
  const calls: GenerationRequest[] = [];
  const fn: GenerateContentFn = (request) => {
    calls.push(request);
    return Promise.resolve(authored(fakeContent(request)));
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
  }
});

test("applyAiContent realigns schemaOrg with the content it just wrote", async () => {
  const before = baseline();
  const after = await applyAiContent(before, input, stub().fn, noDelay);

  for (const page of after) {
    // Structured data that still described the template copy would tell a
    // crawler one thing while the page showed a reader another — a documented
    // negative signal, on a product whose whole purpose is to rank.
    assert.equal(page.schemaOrg.name, page.h1);
    assert.equal(page.schemaOrg.description, page.metaDescription);
  }
});

test("applyAiContent moves only the schemaOrg fields that describe the page", async () => {
  const before = baseline();
  const after = await applyAiContent(before, input, stub().fn, noDelay);

  for (const [index, page] of after.entries()) {
    const original = before[index];
    assert.ok(original !== undefined);

    // These come from the business record rather than from any prose, so the
    // model has no say in them and no reason to be consulted about them.
    assert.equal(page.schemaOrg["@context"], original.schemaOrg["@context"]);
    assert.equal(page.schemaOrg["@type"], original.schemaOrg["@type"]);
    assert.deepEqual(page.schemaOrg.serviceType, original.schemaOrg.serviceType);
    assert.deepEqual(page.schemaOrg.provider, original.schemaOrg.provider);
    assert.deepEqual(page.schemaOrg.areaServed, original.schemaOrg.areaServed);
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

// --- Phase 04: grounding is wired, and provenance travels with the page ---

test("applyAiContent supplies a verified record, activating the grounding gate", async () => {
  const before = baseline();
  const { fn, calls } = stub();
  await applyAiContent(before, input, fn, noDelay);

  for (const call of calls) {
    assert.ok(call.facts !== undefined, "every request must carry a record");
    assert.equal(call.facts.businessName, business.name);
    assert.equal(call.facts.emails[0], business.contactEmail);
    assert.equal(call.facts.phones[0], business.contactPhone);
  }
});

test("the record names every service and city, so scope claims are checkable", async () => {
  const before = baseline();
  const { fn, calls } = stub();
  await applyAiContent(before, input, fn, noDelay);

  const facts = calls[0]?.facts;
  assert.ok(facts !== undefined);
  // No eligibility declared, so everything is approved and nothing is off-limits.
  assert.deepEqual(facts.approvedServices, ["Service A", "Service B"]);
  assert.deepEqual(facts.approvedCities, ["Alphaville", "Betaville"]);
  assert.deepEqual(facts.unapprovedServices, []);
});

test("a narrowed business marks the rest of the catalogue off-limits", async () => {
  const narrowed: ValidatedInputData = {
    ...input,
    businesses: [{ ...business, serviceIds: ["svc-a"], locationIds: ["loc-a"] }],
  };
  const { fn, calls } = stub();
  await applyAiContent(buildPages(narrowed, { locale: "en" }), narrowed, fn, noDelay);

  const facts = calls[0]?.facts;
  assert.ok(facts !== undefined);
  assert.deepEqual(facts.approvedServices, ["Service A"]);
  assert.deepEqual(facts.unapprovedServices, ["Service B"]);
  assert.deepEqual(facts.unapprovedCities, ["Betaville"]);
});

test("applyAiContent supplies a cache identity for every page", async () => {
  const before = baseline();
  const { fn, calls } = stub();
  await applyAiContent(before, input, fn, noDelay);

  for (const [index, call] of calls.entries()) {
    const page = before[index];
    assert.ok(page !== undefined);
    assert.ok(call.cacheIdentity !== undefined);
    assert.equal(call.cacheIdentity.businessId, page.businessId);
    assert.equal(call.cacheIdentity.serviceId, page.serviceId);
    assert.equal(call.cacheIdentity.locationId, page.locationId);
    assert.match(call.cacheIdentity.sourceHash, /^[0-9a-f]{16}$/);
  }
});

test("each page gets its own source fingerprint", async () => {
  const before = baseline();
  const { fn, calls } = stub();
  await applyAiContent(before, input, fn, noDelay);

  const hashes = calls.map((call) => call.cacheIdentity?.sourceHash);
  assert.equal(new Set(hashes).size, hashes.length);
});

test("the fingerprint is stable across identical runs", async () => {
  const first = stub();
  const second = stub();
  await applyAiContent(baseline(), input, first.fn, noDelay);
  await applyAiContent(baseline(), input, second.fn, noDelay);

  // An unstable fingerprint would miss the cache on every run and quietly
  // re-buy every page.
  assert.deepEqual(
    first.calls.map((call) => call.cacheIdentity?.sourceHash),
    second.calls.map((call) => call.cacheIdentity?.sourceHash),
  );
});

test("the fingerprint moves when the source data is edited", async () => {
  const edited: ValidatedInputData = {
    ...input,
    services: [{ ...svcA, description: "Z".repeat(150) }, svcB],
  };
  const first = stub();
  const second = stub();

  await applyAiContent(baseline(), input, first.fn, noDelay);
  await applyAiContent(buildPages(edited, { locale: "en" }), edited, second.fn, noDelay);

  assert.notEqual(
    first.calls[0]?.cacheIdentity?.sourceHash,
    second.calls[0]?.cacheIdentity?.sourceHash,
  );
});

test("computeSourceHash ignores fields the model never sees", async () => {
  // The slug is the engine's, never the model's, so editing it must not force
  // a paid rewrite of prose that would come out identical.
  const restyled: ValidatedInputData = {
    ...input,
    services: [{ ...svcA, slug: "renamed-service" }, svcB],
  };
  const first = stub();
  const second = stub();

  await applyAiContent(baseline(), input, first.fn, noDelay);
  await applyAiContent(
    buildPages(restyled, { locale: "en" }),
    restyled,
    second.fn,
    noDelay,
  );

  assert.equal(
    first.calls[0]?.cacheIdentity?.sourceHash,
    second.calls[0]?.cacheIdentity?.sourceHash,
  );
});

test("applyAiContent records provenance on every authored page", async () => {
  const after = await applyAiContent(baseline(), input, stub().fn, noDelay);

  for (const page of after) {
    assert.ok(page.generation !== undefined);
    assert.equal(page.generation.promptVersion, "test-prompt");
    assert.equal(page.generation.modelVersion, "test-model");
    assert.equal(page.generation.profileId, "default");
    assert.match(page.generation.sourceHash, /^[0-9a-f]{16}$/);
    assert.ok(page.generation.generatedAt !== undefined);
  }
});

test("provenance is absent on deterministic pages", () => {
  for (const page of baseline()) {
    assert.equal(page.generation, undefined);
  }
});

test("applyAiContent reports whether each page came from the cache", async () => {
  const cached: GenerateContentFn = (request) =>
    Promise.resolve(authored(fakeContent(request), true));

  const seen: boolean[] = [];
  await applyAiContent(baseline(), input, cached, {
    ...noDelay,
    onProgress: ({ cacheHit }) => seen.push(cacheHit),
  });

  assert.deepEqual(seen, [true, true, true, true]);
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
    Promise.resolve(authored({ ...fakeContent(details), title: "T".repeat(71) }));

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

/** A stub whose pages all come back from the cache. */
function cachedStub(): GenerateContentFn {
  return (request) => Promise.resolve(authored(fakeContent(request), true));
}

/** Records the pauses a run took instead of taking them. */
function recordingSleep(): { fn: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    fn: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
    waits,
  };
}

test("applyAiContent does not pace a page that came from the cache", async () => {
  const before = baseline();
  const sleeper = recordingSleep();

  await applyAiContent(before, input, cachedStub(), {
    delayMs: 3000,
    sleepFn: sleeper.fn,
  });

  // The pacing exists to stay inside a provider's rate limit. A cache hit made
  // no request, so there is nothing to pace: a fully cached re-run of five
  // hundred pages used to spend twenty-five minutes asleep to make zero calls.
  assert.deepEqual(sleeper.waits, []);
});

test("applyAiContent still paces pages it actually bought", async () => {
  const before = baseline();
  const sleeper = recordingSleep();

  await applyAiContent(before, input, stub().fn, {
    delayMs: 3000,
    sleepFn: sleeper.fn,
  });

  // One pause between each pair of paid calls, and none after the last.
  assert.equal(sleeper.waits.length, before.length - 1);
  assert.ok(sleeper.waits.every((ms) => ms === 3000));
});

test("applyAiContent paces only the paid pages in a mixed run", async () => {
  const before = baseline();
  const sleeper = recordingSleep();

  // Every other page is a hit, which is what a re-run after editing one
  // service looks like.
  let call = 0;
  const mixed: GenerateContentFn = (request) => {
    const hit = call % 2 === 0;
    call += 1;
    return Promise.resolve(authored(fakeContent(request), hit));
  };

  await applyAiContent(before, input, mixed, {
    delayMs: 3000,
    sleepFn: sleeper.fn,
  });

  const paidBeforeLast = before
    .slice(0, -1)
    .filter((_page, index) => index % 2 !== 0).length;

  assert.equal(sleeper.waits.length, paidBeforeLast);
});

test("applyAiContent reports a cache hit through progress", async () => {
  const before = baseline();
  const seen: boolean[] = [];

  await applyAiContent(before, input, cachedStub(), {
    delayMs: 0,
    onProgress: ({ cacheHit }) => seen.push(cacheHit),
  });

  assert.equal(seen.length, before.length);
  assert.ok(seen.every((hit) => hit === true));
});
