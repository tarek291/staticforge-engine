import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  FileContentCache,
  InMemoryContentCache,
  buildCacheKey,
  type CacheEntry,
  type CacheKeyParts,
} from "./cache.js";
import { AIGenerationService, type GeneratedPageContent } from "./service.js";

const PARTS: CacheKeyParts = {
  businessId: "biz-1",
  serviceId: "svc-1",
  locationId: "loc-1",
  profileId: "default",
  promptVersion: "1.0.0",
  modelVersion: "claude-opus-5",
  sourceHash: "abc123",
};

/** Minimal content that satisfies the structural contract. */
function content(): GeneratedPageContent {
  return {
    title: "Büroreinigung in Duisburg",
    metaDescription: "Professionelle Büroreinigung in Duisburg für Unternehmen.",
    h1: "Saubere Büros in Duisburg",
    content: {
      hero: { heading: "Büroreinigung in Duisburg" },
      sections: [{ heading: "Ablauf", body: "B".repeat(60) }],
      faq: [
        { question: "Wie schnell geht das?", answer: "Innerhalb weniger Tage." },
        { question: "Was kostet die Reinigung?", answer: "Nach Aufwand und Fläche." },
        { question: "Ist das Personal fest?", answer: "Ja, feste Teams pro Objekt." },
      ],
      cta: { heading: "Angebot", buttonLabel: "Anfragen", href: "#contact" },
    },
  };
}

function entry(): CacheEntry {
  return { content: content(), parts: PARTS, storedAt: "2026-08-27T00:00:00.000Z" };
}

// ---------------------------------------------------------------------------
// Key composition
// ---------------------------------------------------------------------------

describe("buildCacheKey", () => {
  test("is stable across calls", () => {
    expect(buildCacheKey(PARTS)).toBe(buildCacheKey(PARTS));
  });

  test("does not depend on the order keys were written in", () => {
    const reordered: CacheKeyParts = {
      sourceHash: PARTS.sourceHash,
      modelVersion: PARTS.modelVersion,
      promptVersion: PARTS.promptVersion,
      profileId: PARTS.profileId,
      locationId: PARTS.locationId,
      serviceId: PARTS.serviceId,
      businessId: PARTS.businessId,
    };

    // Same data loaded two different ways must hit, not miss.
    expect(buildCacheKey(reordered)).toBe(buildCacheKey(PARTS));
  });

  test("changes when any one dimension changes", () => {
    const base = buildCacheKey(PARTS);

    const variants: Array<[keyof CacheKeyParts, string]> = [
      ["businessId", "biz-2"],
      ["serviceId", "svc-2"],
      ["locationId", "loc-2"],
      ["profileId", "strictSeo"],
      ["promptVersion", "1.1.0"],
      ["modelVersion", "claude-sonnet-5"],
      ["sourceHash", "def456"],
    ];

    for (const [field, value] of variants) {
      expect(
        buildCacheKey({ ...PARTS, [field]: value }),
        `changing ${field} must change the key`,
      ).not.toBe(base);
    }
  });

  test("cannot be confused by parts that concatenate to the same string", () => {
    const a = buildCacheKey({ ...PARTS, businessId: "ab", serviceId: "cd" });
    const b = buildCacheKey({ ...PARTS, businessId: "abcd", serviceId: "" });

    expect(a).not.toBe(b);
  });

  test("is a short, filesystem-safe fingerprint", () => {
    expect(buildCacheKey(PARTS)).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

describe("InMemoryContentCache", () => {
  test("misses before anything is stored", async () => {
    expect(await new InMemoryContentCache().get("nothing")).toBeUndefined();
  });

  test("returns what was stored", async () => {
    const cache = new InMemoryContentCache();
    await cache.set("k", entry());

    expect((await cache.get("k"))?.content.title).toBe("Büroreinigung in Duisburg");
  });

  test("reports its size and clears", async () => {
    const cache = new InMemoryContentCache();
    await cache.set("a", entry());
    await cache.set("b", entry());

    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("FileContentCache", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "staticforge-cache-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("misses on an empty directory", async () => {
    expect(await new FileContentCache(join(dir, "empty")).get("k")).toBeUndefined();
  });

  test("survives being read by a fresh instance", async () => {
    const key = buildCacheKey(PARTS);
    await new FileContentCache(dir).set(key, entry());

    // A second process is the whole point: a rebuild must not re-buy content.
    const reread = await new FileContentCache(dir).get(key);

    expect(reread?.content.title).toBe("Büroreinigung in Duisburg");
    expect(reread?.parts.sourceHash).toBe("abc123");
  });

  test("creates the directory on first write", async () => {
    const nested = join(dir, "deep", "nested");
    await new FileContentCache(nested).set("k", entry());

    expect(await new FileContentCache(nested).keys()).toEqual(["k"]);
  });

  test("treats a corrupt entry as a miss rather than failing the run", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const broken = join(dir, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "bad.json"), "{ not json", "utf8");

    // Worst case is paying to regenerate one page. Failing the build over
    // unreadable *cache* would be a far worse trade.
    expect(await new FileContentCache(broken).get("bad")).toBeUndefined();
  });

  test("lists stored keys", async () => {
    const listed = join(dir, "listed");
    const cache = new FileContentCache(listed);
    await cache.set("one", entry());
    await cache.set("two", entry());

    expect((await cache.keys()).sort()).toEqual(["one", "two"]);
  });
});

// ---------------------------------------------------------------------------
// The service's use of it
// ---------------------------------------------------------------------------

describe("service caching", () => {
  let cache: InMemoryContentCache;

  const identity = {
    businessId: "biz-1",
    serviceId: "svc-1",
    locationId: "loc-1",
    sourceHash: "abc123",
  };

  const request = {
    businessName: "GlanzFix",
    serviceName: "Büroreinigung",
    cityName: "Duisburg",
    cacheIdentity: identity,
  };

  function toolResponse() {
    return {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t", name: "emit_page_content", input: content() },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }

  function serviceWith(create: ReturnType<typeof vi.fn>, overrides = {}) {
    return new AIGenerationService({
      client: { messages: { create } } as never,
      cache,
      retry: { sleepFn: () => Promise.resolve(), random: () => 0.5 },
      ...overrides,
    });
  }

  beforeEach(() => {
    cache = new InMemoryContentCache();
  });

  test("calls the provider on a miss and stores the result", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse());

    const result = await serviceWith(create).authorPage(request);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.provenance.cacheHit).toBe(false);
    expect(cache.size).toBe(1);
  });

  test("serves the second identical request without paying again", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse());
    const service = serviceWith(create);

    await service.authorPage(request);
    const second = await service.authorPage(request);

    // The saving is the entire reason this layer exists.
    expect(create).toHaveBeenCalledTimes(1);
    expect(second.provenance.cacheHit).toBe(true);
    expect(second.content.title).toBe("Büroreinigung in Duisburg");
  });

  test("shares the cache between service instances", async () => {
    const first = vi.fn().mockResolvedValue(toolResponse());
    const second = vi.fn().mockResolvedValue(toolResponse());

    await serviceWith(first).authorPage(request);
    await serviceWith(second).authorPage(request);

    expect(second).not.toHaveBeenCalled();
  });

  test("misses when the source data changed", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse());
    const service = serviceWith(create);

    await service.authorPage(request);
    await service.authorPage({
      ...request,
      cacheIdentity: { ...identity, sourceHash: "changed" },
    });

    // Edited source must be rewritten. A hit here would publish stale content.
    expect(create).toHaveBeenCalledTimes(2);
  });

  test("misses when the model changed", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse());

    await serviceWith(create).authorPage(request);
    await serviceWith(create, { model: "claude-sonnet-5" }).authorPage(request);

    expect(create).toHaveBeenCalledTimes(2);
  });

  test("misses when the prompt version changed", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse());

    await serviceWith(create).authorPage(request);
    await serviceWith(create, { promptVersion: "9.9.9" }).authorPage(request);

    expect(create).toHaveBeenCalledTimes(2);
  });

  test("misses when the content profile changed", async () => {
    const { STRICT_SEO_PROFILE } = await import("@staticforge/schemas");
    const create = vi.fn().mockResolvedValue(toolResponse());

    await serviceWith(create).authorPage(request);
    // The strict profile would reject this thin content, which is itself the
    // proof that the cached entry was not reused.
    await expect(
      serviceWith(create, { profile: STRICT_SEO_PROFILE }).authorPage(request),
    ).rejects.toBeDefined();

    expect(create).toHaveBeenCalledTimes(2);
  });

  test("bypasses the cache when no identity is supplied", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse());
    const service = serviceWith(create);
    const anonymous = { ...request, cacheIdentity: undefined };

    await service.authorPage(anonymous);
    await service.authorPage(anonymous);

    // A key that cannot be built reliably is worse than no cache.
    expect(create).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  test("never caches a rejection", async () => {
    const create = vi.fn().mockResolvedValue({
      ...toolResponse(),
      content: [
        {
          type: "tool_use",
          id: "t",
          name: "emit_page_content",
          input: { ...content(), title: "" },
        },
      ],
    });

    await expect(serviceWith(create).authorPage(request)).rejects.toBeDefined();

    // Caching a refusal would turn one bad answer into a permanent one.
    expect(cache.size).toBe(0);
  });

  test("works with no cache configured at all", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse());
    const service = new AIGenerationService({
      client: { messages: { create } } as never,
    });

    await service.authorPage(request);
    await service.authorPage(request);

    expect(create).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

describe("provenance", () => {
  function serviceWith(create: ReturnType<typeof vi.fn>, overrides = {}) {
    return new AIGenerationService({
      client: { messages: { create } } as never,
      ...overrides,
    });
  }

  const toolResponse = {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "t", name: "emit_page_content", input: content() },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  test("records the prompt version, model and profile", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse);

    const { provenance } = await serviceWith(create, {
      promptVersion: "2.3.4",
      model: "claude-opus-5",
    }).authorPage({
      businessName: "B",
      serviceName: "S",
      cityName: "C",
    });

    expect(provenance).toMatchObject({
      promptVersion: "2.3.4",
      modelVersion: "claude-opus-5",
      profileId: "default",
      cacheHit: false,
    });
  });

  test("carries the source fingerprint through", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse);

    const { provenance } = await serviceWith(create).authorPage({
      businessName: "B",
      serviceName: "S",
      cityName: "C",
      cacheIdentity: {
        businessId: "b",
        serviceId: "s",
        locationId: "l",
        sourceHash: "fingerprint",
      },
    });

    expect(provenance.sourceHash).toBe("fingerprint");
  });

  test("defaults to the package's declared prompt version", async () => {
    const { PROMPT_VERSION } = await import("./prompts.js");
    const create = vi.fn().mockResolvedValue(toolResponse);

    const { provenance } = await serviceWith(create).authorPage({
      businessName: "B",
      serviceName: "S",
      cityName: "C",
    });

    expect(provenance.promptVersion).toBe(PROMPT_VERSION);
  });

  test("generatePageContent still returns bare content", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse);

    const result = await serviceWith(create).generatePageContent({
      businessName: "B",
      serviceName: "S",
      cityName: "C",
    });

    // The narrower signature is preserved for callers that predate provenance.
    expect(result.title).toBe("Büroreinigung in Duisburg");
    expect("provenance" in result).toBe(false);
  });
});
