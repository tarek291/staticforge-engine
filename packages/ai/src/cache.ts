import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { combineHash } from "@staticforge/core";
import type { GeneratedPageContent } from "./service.js";

/**
 * Content cache.
 *
 * Every authoring call is paid for. Re-running the pipeline after an unrelated
 * change — a template tweak, a new city, a rebuild in CI — must not re-buy
 * content that would come out identical.
 *
 * ## What the key has to cover
 *
 * A cached page is reusable only when *nothing that shaped it* has changed.
 * That is more than the entity ids: the same business, service and city produce
 * different content under a different quality profile, a rewritten prompt, a
 * different model, or edited source data. All seven parts go into the key, so a
 * change to any one of them misses the cache and pays for a fresh page — which
 * is the correct outcome, not a failure.
 *
 * The inverse matters just as much: a run that changed none of them must hit.
 * A key that accidentally varies per run (a timestamp, an unordered object)
 * would look like a working cache while silently costing full price every time.
 */

/** The seven things that decide whether cached content is still valid. */
export interface CacheKeyParts {
  businessId: string;
  serviceId: string;
  locationId: string;
  profileId: string;
  promptVersion: string;
  modelVersion: string;
  /** Fingerprint of the source entities and content template. */
  sourceHash: string;
}

/**
 * Build the cache key.
 *
 * Deliberately built from explicit parts in a fixed order rather than from a
 * loose object, so adding a dimension later is a compile error at every call
 * site instead of a silent cache poisoning.
 */
export function buildCacheKey(parts: CacheKeyParts): string {
  return combineHash([
    parts.businessId,
    parts.serviceId,
    parts.locationId,
    parts.profileId,
    parts.promptVersion,
    parts.modelVersion,
    parts.sourceHash,
  ]);
}

/** A stored entry: the content plus enough context to audit a hit. */
export interface CacheEntry {
  content: GeneratedPageContent;
  parts: CacheKeyParts;
  storedAt: string;
}

/** Storage for authored content. */
export interface ContentCache {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
}

/**
 * Process-lifetime cache.
 *
 * Useful within one run — a generator pass that revisits the same combination,
 * a test — but buys nothing across runs. Use {@link FileContentCache} for that.
 */
export class InMemoryContentCache implements ContentCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string): Promise<CacheEntry | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  set(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
    return Promise.resolve();
  }

  /** Number of stored entries. Exposed for inspection and testing. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Cache backed by one JSON file per entry.
 *
 * Survives process restarts, which is where the real saving is: a CI rebuild or
 * a second local run costs nothing when the source has not changed.
 *
 * Entries are never evicted. A key encodes everything that shaped its content,
 * so a stale entry is simply one nothing will ask for again — it wastes disk,
 * not correctness. Reclaiming that disk is a housekeeping job, not a cache
 * concern.
 */
export class FileContentCache implements ContentCache {
  constructor(private readonly directory: string) {}

  private pathFor(key: string): string {
    return join(this.directory, `${key}.json`);
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      return JSON.parse(raw) as CacheEntry;
    } catch {
      // A missing file is an ordinary miss. A corrupt one is treated the same:
      // the worst outcome is paying to regenerate a page, and failing the whole
      // run over unreadable *cache* would be a far worse trade.
      return undefined;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.pathFor(key), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  }

  /** Keys currently stored. */
  async keys(): Promise<string[]> {
    try {
      const files = await readdir(this.directory);
      return files
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length));
    } catch {
      return [];
    }
  }
}

/** Outcome of one cache consultation, for reporting. */
export interface CacheOutcome {
  key: string;
  hit: boolean;
}
