import test from "node:test";
import assert from "node:assert/strict";
import { ManifestSchema } from "@staticforge/schemas";

// Tiny, language-agnostic manifest entry fixture.
const validEntry = {
  slug: "alpha",
  locale: "en",
  title: "Alpha",
  metaDescription: "Alpha description.",
};

test("manifest schema: accepts a valid manifest", () => {
  const result = ManifestSchema.safeParse({ count: 1, pages: [validEntry] });
  assert.ok(result.success, "a valid manifest should parse");
});

test("manifest schema: entry templateId round-trips when provided", () => {
  const result = ManifestSchema.safeParse({
    count: 1,
    pages: [{ ...validEntry, templateId: "luxuryLanding" }],
  });
  assert.ok(result.success);
  assert.equal(result.data.pages[0]?.templateId, "luxuryLanding");
});

test("manifest schema: older entry without templateId still parses (default)", () => {
  // Backward compatibility: a manifest written before templateId existed.
  const result = ManifestSchema.safeParse({ count: 1, pages: [validEntry] });
  assert.ok(result.success);
  assert.equal(result.data.pages[0]?.templateId, "default");
});

test("manifest schema: rejects count not matching pages.length", () => {
  const result = ManifestSchema.safeParse({ count: 2, pages: [validEntry] });
  assert.equal(result.success, false);
});

test("manifest schema: rejects an invalid/missing page entry", () => {
  // Missing locale/title/metaDescription.
  const result = ManifestSchema.safeParse({
    count: 1,
    pages: [{ slug: "alpha" }],
  });
  assert.equal(result.success, false);
});
