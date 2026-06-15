import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

    for (const entry of manifest.pages) {
      assert.ok(
        pageFiles.includes(`${entry.slug}.json`),
        `missing page file for slug "${entry.slug}"`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
