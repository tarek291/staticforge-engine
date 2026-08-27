import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestSchema, type GeneratedPage } from "@staticforge/schemas";

import { savePages } from "./save-output.js";

/**
 * The published site *is* the output directory, so the question these tests ask
 * is not "were the right files written" — the existing suite covers that — but
 * "what does a reader see if the write does not finish".
 *
 * The old implementation deleted every page and then wrote the new ones, so the
 * answer for the whole duration of the write was "an empty site, and the last
 * good copy is gone". These assert the property that replaced it.
 */

/** A minimal page that satisfies the contract. */
function page(slug: string): GeneratedPage {
  return {
    slug,
    locale: "en",
    title: `Title for ${slug}`,
    metaDescription: `A meta description for ${slug} that is long enough.`,
    h1: `Heading for ${slug}`,
    content: {
      hero: { heading: "Hero" },
      sections: [{ heading: "Section", body: "Body text." }],
      faq: [{ question: "Q?", answer: "A." }],
      cta: { heading: "CTA", buttonLabel: "Go", href: "#contact" },
    },
    schemaOrg: { "@type": "Service" },
    templateId: "default",
    contentProfileId: "default",
    businessId: "11111111-1111-4111-8111-111111111111",
    serviceId: "svc-1",
    locationId: "loc-1",
    links: [],
  };
}

/** Names of the `.json` files currently in `<dir>/pages`. */
async function livePages(dir: string): Promise<string[]> {
  const names = await readdir(join(dir, "pages")).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".json")).sort();
}

/** Every entry directly inside the output directory. */
async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "staticforge-atomic-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("savePages writes without destroying the live site first", () => {
  test("a failed write leaves the previous site completely intact", async () => {
    await withTempDir(async (dir) => {
      await savePages([page("first"), page("second")], dir);

      const before = await livePages(dir);
      const manifestBefore = await readFile(join(dir, "manifest.json"), "utf-8");

      // An invalid page fails validation, which happens before anything is
      // written. Under the delete-then-write implementation the pages would
      // already be gone by the time an equivalent failure landed.
      const broken = { ...page("third"), slug: "Not A Slug" } as GeneratedPage;

      await assert.rejects(() => savePages([page("first"), broken], dir));

      assert.deepEqual(
        await livePages(dir),
        before,
        "the live site changed despite the write failing",
      );
      assert.equal(
        await readFile(join(dir, "manifest.json"), "utf-8"),
        manifestBefore,
        "the manifest changed despite the write failing",
      );
    });
  });

  test("the live pages directory is never emptied in the process", async () => {
    await withTempDir(async (dir) => {
      await savePages([page("first"), page("second")], dir);

      // A second run replaces both pages with a different set. At no point
      // should the directory the site is served from be missing or empty.
      await savePages([page("third")], dir);

      const after = await livePages(dir);
      assert.deepEqual(after, ["third.json"]);
    });
  });

  test("leaves no staging or retired directories behind on success", async () => {
    await withTempDir(async (dir) => {
      await savePages([page("first")], dir);
      await savePages([page("second")], dir);

      assert.deepEqual(
        await entries(dir),
        ["manifest.json", "pages"],
        "housekeeping directories survived a successful run",
      );
    });
  });

  test("sweeps leftovers from a run that was killed mid-write", async () => {
    await withTempDir(async (dir) => {
      await savePages([page("first")], dir);

      // What a killed process leaves behind: a staging tree that never got
      // swapped in, and a retired copy that never got discarded.
      await mkdir(join(dir, ".staging-9999-abc", "pages"), { recursive: true });
      await writeFile(
        join(dir, ".staging-9999-abc", "pages", "orphan.json"),
        "{}\n",
        "utf-8",
      );
      await mkdir(join(dir, ".retired-9999-abc"), { recursive: true });

      await savePages([page("second")], dir);

      assert.deepEqual(
        await entries(dir),
        ["manifest.json", "pages"],
        "leftovers from an interrupted run were not swept",
      );
    });
  });

  test("leftovers are invisible to a reader of the site", async () => {
    await withTempDir(async (dir) => {
      await savePages([page("first")], dir);
      await mkdir(join(dir, ".staging-1-x", "pages"), { recursive: true });
      await writeFile(
        join(dir, ".staging-1-x", "pages", "ghost.json"),
        "{}\n",
        "utf-8",
      );

      // The web app and the validate stage read pages/ and manifest.json and
      // nothing else, so a leftover tree is inert rather than corrupting.
      const manifest = ManifestSchema.parse(
        JSON.parse(await readFile(join(dir, "manifest.json"), "utf-8")),
      );

      assert.equal(manifest.count, 1);
      assert.deepEqual(await livePages(dir), ["first.json"]);
    });
  });

  test("the manifest never disagrees with the pages beside it", async () => {
    await withTempDir(async (dir) => {
      await savePages([page("a"), page("b"), page("c")], dir);
      await savePages([page("a")], dir);

      const manifest = ManifestSchema.parse(
        JSON.parse(await readFile(join(dir, "manifest.json"), "utf-8")),
      );
      const files = await livePages(dir);

      // The manifest moves last, so it can lag its pages but never lead them —
      // and the validate stage reads a lead as corruption.
      assert.equal(manifest.count, files.length);
      assert.deepEqual(
        manifest.pages.map((entry) => `${entry.slug}.json`).sort(),
        files,
      );
    });
  });

  test("works when the output directory does not exist yet", async () => {
    await withTempDir(async (dir) => {
      const nested = join(dir, "does", "not", "exist");

      await savePages([page("first")], nested);

      assert.deepEqual(await livePages(nested), ["first.json"]);
    });
  });
});
