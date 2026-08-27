import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  FileContentCache,
  buildCacheKey,
  parseCacheEntry,
  type CacheEntry,
  type CacheKeyParts,
} from "./cache.js";

/**
 * The cache is a directory, and a directory is an input.
 *
 * A hit returns without re-running the gates, on the reasoning that an entry
 * was only stored because it passed them. That reasoning covers entries this
 * process wrote and nothing else: the store is shared in CI, mounted into
 * containers, and writable by anything with access to the workspace. Before
 * this fix the read was `JSON.parse(raw) as CacheEntry` — an assertion, not a
 * check — so anything that could write a file there could hand a page straight
 * past the schema.
 */

const PARTS: CacheKeyParts = {
  businessId: "biz-1",
  serviceId: "svc-1",
  locationId: "loc-1",
  profileId: "default",
  promptVersion: "1.0.0",
  modelVersion: "claude-opus-5",
  sourceHash: "abc123",
};

/** A well-formed entry. */
function entry(): CacheEntry {
  return {
    parts: PARTS,
    storedAt: "2026-08-27T10:00:00.000Z",
    content: {
      title: "A perfectly ordinary page title here",
      metaDescription: "A meta description long enough to look like a real one.",
      h1: "A heading written for the reader",
      content: {
        hero: { heading: "Hero" },
        sections: [{ heading: "Section", body: "Body." }],
        faq: [{ question: "Q?", answer: "A." }],
        cta: { heading: "CTA", buttonLabel: "Go", href: "#contact" },
      },
    },
  };
}

async function withCache(
  run: (cache: FileContentCache, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "staticforge-cache-"));
  try {
    await run(new FileContentCache(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write raw JSON straight into the store, as a poisoner would. */
async function poison(dir: string, key: string, value: unknown): Promise<void> {
  await writeFile(join(dir, `${key}.json`), JSON.stringify(value), "utf8");
}

describe("parseCacheEntry", () => {
  test("accepts a well-formed entry", () => {
    expect(parseCacheEntry(entry())).toBeDefined();
  });

  test("rejects content that does not satisfy the page contract", () => {
    // The exact shape a poisoned entry takes: valid JSON, wrong payload.
    const bad = { ...entry(), content: { title: 123 } };

    expect(parseCacheEntry(bad)).toBeUndefined();
  });

  test("rejects an entry missing the sections a page must have", () => {
    const bad = entry();
    bad.content.content.sections = [];

    expect(parseCacheEntry(bad)).toBeUndefined();
  });

  test("rejects an entry whose recorded identity is incomplete", () => {
    // The parts are what an operator reads to audit why a page was reused. An
    // entry that cannot answer that is not auditable, so it is not usable.
    const bad = { ...entry(), parts: { ...PARTS, sourceHash: "" } };

    expect(parseCacheEntry(bad)).toBeUndefined();
  });

  test("rejects values that are not entries at all", () => {
    for (const value of [null, undefined, 42, "text", [], {}]) {
      expect(parseCacheEntry(value)).toBeUndefined();
    }
  });
});

describe("FileContentCache reads are parsed, not asserted", () => {
  test("round-trips an entry it wrote itself", async () => {
    await withCache(async (cache) => {
      const key = buildCacheKey(PARTS);
      await cache.set(key, entry());

      const hit = await cache.get(key);

      expect(hit?.content.title).toBe(entry().content.title);
    });
  });

  test("a poisoned entry is a miss, not a hit", async () => {
    await withCache(async (cache, dir) => {
      const key = buildCacheKey(PARTS);

      // Structurally invalid, and previously indistinguishable from a real hit:
      // the old read cast rather than parsed, so this reached the merge step
      // and from there the published page.
      await poison(dir, key, {
        parts: PARTS,
        storedAt: "2026-08-27T10:00:00.000Z",
        content: { title: "Cheap!", h1: 7, content: "not an object" },
      });

      expect(await cache.get(key)).toBeUndefined();
    });
  });

  test("an entry with extra fields does not smuggle them through", async () => {
    await withCache(async (cache, dir) => {
      const key = buildCacheKey(PARTS);
      const smuggled = entry() as CacheEntry & { content: { evil?: string } };

      await poison(dir, key, {
        ...smuggled,
        content: { ...smuggled.content, evil: "<script>alert(1)</script>" },
      });

      const hit = await cache.get(key);

      // The pick-based schema strips what it does not name, so a widened
      // payload cannot ride along into a page.
      expect(hit).toBeDefined();
      expect(hit?.content).not.toHaveProperty("evil");
    });
  });

  test("a corrupt file is a miss rather than a failed run", async () => {
    await withCache(async (cache, dir) => {
      const key = buildCacheKey(PARTS);
      await writeFile(join(dir, `${key}.json`), "{ not json", "utf8");

      // The worst outcome of an unreadable cache is paying to regenerate a
      // page. Failing the whole run over it would be a far worse trade.
      await expect(cache.get(key)).resolves.toBeUndefined();
    });
  });

  test("a missing file is an ordinary miss", async () => {
    await withCache(async (cache) => {
      await expect(cache.get(buildCacheKey(PARTS))).resolves.toBeUndefined();
    });
  });

  test("rejecting an entry does not delete it", async () => {
    // The store is not this process's to tidy: another run may be mid-write,
    // and a cache that erases what it cannot read is a cache that erases a
    // concurrent writer's work.
    await withCache(async (cache, dir) => {
      const key = buildCacheKey(PARTS);
      await poison(dir, key, { parts: PARTS, storedAt: "x", content: {} });

      await cache.get(key);

      await expect(
        readFile(join(dir, `${key}.json`), "utf8"),
      ).resolves.toContain("parts");
    });
  });
});
