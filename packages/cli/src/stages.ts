import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateInternalLinks } from "@staticforge/core";
import { verifyPagePolicy } from "@staticforge/generator";
import {
  GeneratedPageSchema,
  LocaleSchema,
  ManifestSchema,
  type GeneratedPage,
} from "@staticforge/schemas";

import { PipelineError, type PipelineContext, type PipelineStage } from "./pipeline.js";

/**
 * The three stages of a deploy.
 *
 * Generation and validation run in-process; only the Next.js build is a
 * subprocess, because that is the one thing this repository does not own.
 */

// ---------------------------------------------------------------------------
// 1. Generate
// ---------------------------------------------------------------------------

/**
 * Produce the pages.
 *
 * Runs the generator's own CLI as a subprocess rather than importing it. The
 * generator is a program with an argument contract, and shelling out means the
 * pipeline exercises exactly the command an operator would run by hand — no
 * second code path that can drift from the documented one.
 */
export const generateStage: PipelineStage = {
  name: "generate",
  description: "load input, build pages, link, publish artifacts",

  async run(context) {
    const args = ["--locale", context.locale];

    if (context.projectId !== undefined) {
      args.push("--project-id", context.projectId);
    }
    if (context.siteUrl !== undefined) {
      args.push("--site-url", context.siteUrl);
    }

    await runCommand(
      "generate",
      "npx",
      ["tsx", "src/generate-pages.cli.ts", ...args],
      join(context.repoRoot, "packages", "generator"),
      // Handed down explicitly. INIT_CWD cannot carry it: npx rewrites that
      // variable to its own working directory, so the generator would resolve
      // the root as `packages/generator` and look for input that is not there.
      { STATICFORGE_REPO_ROOT: context.repoRoot },
      context,
    );
  },
};

// ---------------------------------------------------------------------------
// 2. Validate
// ---------------------------------------------------------------------------

/** Read every generated page off disk, parsed and validated. */
async function readPages(outputDir: string): Promise<GeneratedPage[]> {
  const pagesDir = join(outputDir, "pages");
  let files: string[];

  try {
    files = (await readdir(pagesDir)).filter((file) => file.endsWith(".json"));
  } catch {
    throw new PipelineError(
      "validate",
      "No generated pages found.",
      [`Expected JSON files in ${pagesDir}`],
    );
  }

  const pages: GeneratedPage[] = [];
  const problems: string[] = [];

  for (const file of files.sort()) {
    const raw: unknown = JSON.parse(await readFile(join(pagesDir, file), "utf8"));
    const parsed = GeneratedPageSchema.safeParse(raw);

    if (parsed.success) {
      pages.push(parsed.data);
    } else {
      for (const issue of parsed.error.issues) {
        problems.push(`${file}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new PipelineError(
      "validate",
      `${problems.length} page(s) do not satisfy the page contract.`,
      problems,
    );
  }

  return pages;
}

/**
 * Check what was actually written, not what the generator believed it wrote.
 *
 * This is a deliberately independent pass. The generator validates as it goes,
 * but this stage re-reads the files a crawler would be served and checks them
 * cold — which is the only way to catch a truncated write, a stale file the
 * cleanup missed, or a manifest that disagrees with the directory.
 *
 * It runs *before* the build for one reason: the build takes a minute and
 * produces a publishable site. Discovering a broken graph afterwards means
 * discovering it after publishing.
 *
 * ## Shape is not the same question as policy
 *
 * This stage used to check only that each file satisfied the page schema, which
 * left a real gap: every rule that decides whether content is *publishable* —
 * the quality profile, the verified record — runs in memory, in the process
 * that authored the page. A page that reached disk without passing them still
 * satisfies its schema, and there were three ways to reach disk that way: a
 * cache hit skips those gates by design, a mock authoring run never touches
 * them, and a file can simply be edited after it is written.
 *
 * So the policy is re-applied here, to the artifact rather than to the process.
 * The point of a cold read is to trust nothing the run remembers, and "this
 * content was acceptable" was exactly such a memory.
 */
export const validateStage: PipelineStage = {
  name: "validate",
  description: "re-read the output cold and check every invariant",

  async run(context) {
    const pages = await readPages(context.outputDir);

    // --- Manifest agrees with the directory ---
    const manifestRaw: unknown = JSON.parse(
      await readFile(join(context.outputDir, "manifest.json"), "utf8"),
    );
    const manifest = ManifestSchema.safeParse(manifestRaw);

    if (!manifest.success) {
      throw new PipelineError(
        "validate",
        "manifest.json does not satisfy its schema.",
        manifest.error.issues.map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        ),
      );
    }

    if (manifest.data.pages.length !== pages.length) {
      throw new PipelineError(
        "validate",
        "The manifest disagrees with the pages directory.",
        [
          `manifest lists ${manifest.data.pages.length} pages`,
          `${pages.length} page files on disk`,
        ],
      );
    }

    const onDisk = new Set(pages.map((page) => page.slug));
    const missing = manifest.data.pages
      .filter((entry) => !onDisk.has(entry.slug))
      .map((entry) => `manifest lists "${entry.slug}", but no file exists`);

    if (missing.length > 0) {
      throw new PipelineError("validate", "The manifest references missing pages.", missing);
    }

    // --- Slugs are unique ---
    const duplicates = pages
      .map((page) => page.slug)
      .filter((slug, index, all) => all.indexOf(slug) !== index);

    if (duplicates.length > 0) {
      throw new PipelineError(
        "validate",
        "Duplicate slugs would fight for the same URL.",
        [...new Set(duplicates)],
      );
    }

    // --- Locale is one the engine supports ---
    const badLocales = pages
      .filter((page) => !LocaleSchema.safeParse(page.locale).success)
      .map((page) => `${page.slug}: locale "${page.locale}"`);

    if (badLocales.length > 0) {
      throw new PipelineError("validate", "Unsupported locale on some pages.", badLocales);
    }

    // --- The internal link graph holds ---
    const linkIssues = validateInternalLinks(pages);

    if (linkIssues.length > 0) {
      throw new PipelineError(
        "validate",
        `The internal link graph has ${linkIssues.length} problem(s).`,
        linkIssues.map((issue) => `${issue.path}: ${issue.message}`),
      );
    }

    // --- Content still satisfies the policy that governed it ---
    const policyIssues = await verifyPagePolicy(pages, {
      repoRoot: context.repoRoot,
      projectId: context.projectId,
    });

    if (policyIssues.length > 0) {
      throw new PipelineError(
        "validate",
        `${policyIssues.length} page(s) violate the content policy on disk.`,
        policyIssues.map((issue) => `${issue.path}: ${issue.message}`),
      );
    }

    context.notes.push(
      `· ${pages.length} pages re-checked against their content profile and verified record`,
    );

    // --- Publishing artifacts, when a site URL was configured ---
    const robots = await readIfPresent(join(context.outputDir, "robots.txt"));
    const sitemap = await readIfPresent(join(context.outputDir, "sitemap.xml"));

    if (robots === null || sitemap === null) {
      context.notes.push(
        "· no sitemap or robots.txt — the run had no site URL, so nothing was published for crawlers",
      );
    } else {
      const indexable = pages.filter((page) => (page.seo?.index ?? true) === true);
      const isIndex = sitemap.includes("<sitemapindex");
      const locs = [...sitemap.matchAll(/<loc>/g)].length;

      if (!isIndex && locs !== indexable.length) {
        throw new PipelineError(
          "validate",
          "The sitemap does not list every indexable page.",
          [`${locs} <loc> entries`, `${indexable.length} indexable pages`],
        );
      }

      if (!robots.includes("Sitemap:")) {
        throw new PipelineError("validate", "robots.txt does not point at a sitemap.", []);
      }

      context.notes.push(
        `· ${pages.length} pages, ${indexable.length} indexable, ${isIndex ? "sitemap index" : `${locs} sitemap URLs`}`,
      );
    }

    const linkCount = pages.reduce((total, page) => total + page.links.length, 0);
    context.notes.push(
      `· ${linkCount} internal links across ${pages.length} pages`,
    );

    context.log(`  ${pages.length} pages verified`);
  },
};

/** Read a file, or `null` when it does not exist. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Build
// ---------------------------------------------------------------------------

/**
 * Build the static site.
 *
 * The handoff is made explicit: `STATICFORGE_OUTPUT_DIR` is passed to the
 * subprocess rather than relying on the web app's relative-path fallback, which
 * only resolves when the build happens to run from `apps/web`. A pipeline that
 * works because of the directory it was started from is a pipeline that breaks
 * in CI.
 */
export const buildStage: PipelineStage = {
  name: "build",
  description: "run next build against the generated output",

  async run(context) {
    await runCommand(
      "build",
      "npx",
      ["next", "build"],
      context.webDir,
      { STATICFORGE_OUTPUT_DIR: context.outputDir },
      context,
    );
  },
};

// ---------------------------------------------------------------------------
// Subprocess plumbing
// ---------------------------------------------------------------------------

/**
 * Run a command, forwarding its output and failing readably.
 *
 * The last lines of output are attached to the error, because a non-zero exit
 * code on its own tells an operator nothing about what went wrong.
 */
async function runCommand(
  stage: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  context: PipelineContext,
): Promise<void> {
  const tail: string[] = [];

  const code = await new Promise<number>((resolveCode, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      // Windows resolves npx through the shell; without this the spawn fails
      // with ENOENT rather than running anything.
      shell: process.platform === "win32",
    });

    const capture = (chunk: Buffer): void => {
      const text = chunk.toString();
      process.stdout.write(text);
      for (const line of text.split("\n")) {
        if (line.trim().length > 0) {
          tail.push(line.trimEnd());
          if (tail.length > 40) tail.shift();
        }
      }
    };

    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", rejectRun);
    child.on("close", (exitCode) => resolveCode(exitCode ?? 1));
  });

  if (code !== 0) {
    throw new PipelineError(
      stage,
      `${command} ${args.join(" ")} exited with code ${code}.`,
      tail.slice(-15),
    );
  }

  void context;
}

/** The pipeline, in order. */
export const DEPLOY_STAGES: PipelineStage[] = [
  generateStage,
  validateStage,
  buildStage,
];
