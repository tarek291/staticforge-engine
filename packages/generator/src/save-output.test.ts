import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManifestSchema,
  type Business,
  type Service,
  type Location,
} from "@staticforge/schemas";
import { buildPages } from "./build-pages.js";
import { savePages } from "./save-output.js";
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
    city: "Alphaville",
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

// Two distinct cities → two unique slugs → two pages.
const locations: Location[] = [
  { id: "loc-1", city: "Alphaville", state: "Sample State", country: "DE" },
  { id: "loc-2", city: "Betatown", state: "Sample State", country: "DE" },
];

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
  services: [service],
  locations,
  content,
};

test("savePages keeps manifest entries and page files consistent", async () => {
  const pages = buildPages(input, { locale: "en" });
  assert.equal(pages.length, 2);

  const dir = await mkdtemp(join(tmpdir(), "staticforge-save-"));
  try {
    await savePages(pages, dir);

    const manifestRaw = await readFile(join(dir, "manifest.json"), "utf-8");
    const manifest = ManifestSchema.parse(JSON.parse(manifestRaw));

    // count equals pages.length, and matches what was built.
    assert.equal(manifest.count, manifest.pages.length);
    assert.equal(manifest.count, pages.length);

    // One page JSON file per manifest entry; file count matches pages.length.
    const pageFiles = (await readdir(join(dir, "pages"))).filter((name) =>
      name.endsWith(".json"),
    );
    assert.equal(pageFiles.length, manifest.pages.length);

    // Each manifest entry carries the page's templateId.
    const templateBySlug = new Map(
      pages.map((page) => [page.slug, page.templateId]),
    );
    for (const entry of manifest.pages) {
      assert.ok(
        pageFiles.includes(`${entry.slug}.json`),
        `missing page file for slug "${entry.slug}"`,
      );
      assert.equal(entry.templateId, templateBySlug.get(entry.slug));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("savePages removes stale page files from a previous generation", async () => {
  const pages = buildPages(input, { locale: "en" });
  const currentSlugs = pages.map((page) => page.slug);
  assert.equal(pages.length, 2);

  const dir = await mkdtemp(join(tmpdir(), "staticforge-stale-"));
  try {
    // Pre-seed a stale page file as if left over from an earlier generation.
    const pagesDir = join(dir, "pages");
    await mkdir(pagesDir, { recursive: true });
    await writeFile(join(pagesDir, "old-slug.json"), "{}\n", "utf-8");

    await savePages(pages, dir);

    const pageFiles = (await readdir(pagesDir)).filter((name) =>
      name.endsWith(".json"),
    );

    // Stale file gone; only the current page files remain.
    assert.ok(!pageFiles.includes("old-slug.json"), "stale file was not removed");
    assert.equal(pageFiles.length, currentSlugs.length);
    for (const slug of currentSlugs) {
      assert.ok(
        pageFiles.includes(`${slug}.json`),
        `missing current page file for slug "${slug}"`,
      );
    }

    // Manifest reflects only the current pages.
    const manifestRaw = await readFile(join(dir, "manifest.json"), "utf-8");
    const manifest = ManifestSchema.parse(JSON.parse(manifestRaw));
    assert.equal(manifest.count, currentSlugs.length);
    assert.deepEqual(
      manifest.pages.map((entry) => entry.slug).sort(),
      [...currentSlugs].sort(),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
