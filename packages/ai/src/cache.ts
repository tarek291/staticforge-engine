import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { combineHash } from "@staticforge/core";
import { z } from "zod";

import {
  GeneratedPageContentSchema,
  type GeneratedPageContent,
} from "./content-schema.js";

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
 *
 * ## The store is not a trusted input
 *
 * A hit returns without re-running the gates, on the reasoning that an entry
 * was only stored because it passed them. That reasoning holds for entries this
 * process wrote and for nothing else. The store is a directory: it is shared in
 * CI, mounted into containers, and editable by anything with write access to
 * the workspace. Content read back from it has not been through the schema, the
 * profile or the grounding record in *this* run — so it is parsed on the way
 * out, exactly as a provider response is parsed on the way in.
 *
 * That check is structural, which is what a cache can honestly promise: the
 * profile depends on which profile is in force and grounding on facts the cache
 * never saw, and both are already re-checked over the finished output before a
 * build. What this stops is a cache entry widening the payload contract.
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

/**
 * The shape a stored entry must have to be usable.
 *
 * The key parts are validated too, not only the content: they are what an
 * operator reads to audit why a page was reused, and an entry whose recorded
 * identity is missing or malformed cannot answer that question.
 */
const CacheEntrySchema = z.object({
  content: GeneratedPageContentSchema,
  parts: z.object({
    businessId: z.string().min(1),
    serviceId: z.string().min(1),
    locationId: z.string().min(1),
    profileId: z.string().min(1),
    promptVersion: z.string().min(1),
    modelVersion: z.string().min(1),
    sourceHash: z.string().min(1),
  }),
  storedAt: z.string().min(1),
});

/** A stored entry: the content plus enough context to audit a hit. */
export interface CacheEntry {
  content: GeneratedPageContent;
  parts: CacheKeyParts;
  storedAt: string;
}

/**
 * Parse an entry read back from storage.
 *
 * @returns The entry, or `undefined` when it does not satisfy the contract —
 * which is deliberately the same answer as a miss. A malformed entry costs one
 * regenerated page; trusting it costs a published page the gates never saw.
 */
export function parseCacheEntry(value: unknown): CacheEntry | undefined {
  const parsed = CacheEntrySchema.safeParse(value);

  return parsed.success ? (parsed.data as CacheEntry) : undefined;
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
    let raw: string;

    try {
      raw = await readFile(this.pathFor(key), "utf8");
    } catch {
      // A missing file is an ordinary miss.
      return undefined;
    }

    let value: unknown;

    try {
      value = JSON.parse(raw);
    } catch {
      // A corrupt file is treated as a miss too: the worst outcome is paying to
      // regenerate a page, and failing a whole run over unreadable *cache*
      // would be a far worse trade.
      return undefined;
    }

    // Parsed, not cast. This file is a boundary like any other — the previous
    // `as CacheEntry` asserted a shape rather than checking one, so anything
    // that could write here could hand a page straight past the gates.
    return parseCacheEntry(value);
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
