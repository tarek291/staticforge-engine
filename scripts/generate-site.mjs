#!/usr/bin/env node
/**
 * Produce the content the web build reads.
 *
 * ## Why this exists rather than a line in `vercel-build`
 *
 * Because the interesting part is the branch, and a branch in a shell one-liner
 * is a branch nobody tests.
 *
 * The web app reads `data/output/manifest.json` at build time and renders one
 * static page per entry. `data/output` is **gitignored**, so a fresh clone — a
 * CI runner, a Vercel build, a new laptop — has no manifest. The build then
 * succeeds and emits **zero content pages**, silently. Verified by doing it: 9
 * pages with the manifest present, 0 without, and the same green exit code
 * either way.
 *
 * A deploy that fails is an incident. A deploy that succeeds and serves an empty
 * site is an incident nobody opens, because every signal says it worked.
 *
 * ## What it does
 *
 * With `STATICFORGE_PROJECT_ID` set, it generates that project from the
 * database, which is what a real deployment wants: content fresh as of the
 * build, and a rebuild triggered whenever the content changes — the deploy hook
 * Phase 22 already emits on queue drain, finally connected to something.
 *
 * Without it, it generates from `data/input`, which is committed. That keeps CI
 * and a clone-and-build working with no database and no secrets.
 *
 * Either way it refuses to exit 0 having produced nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectId = process.env["STATICFORGE_PROJECT_ID"]?.trim();
const locale = process.env["STATICFORGE_LOCALE"]?.trim() ?? "de";

/**
 * Run a workspace script, inheriting stdio so its output is the build log.
 *
 * `pnpm` directly, not `corepack pnpm`. Corepack is how this repository pins its
 * package manager and it is the right thing locally — but on Vercel it is
 * gated behind `ENABLE_EXPERIMENTAL_COREPACK`, which is off by default. The
 * builder already has pnpm on `PATH`, because it detected the lockfile and used
 * pnpm to install; going through corepack adds a dependency on a flag nobody
 * sets and fails with a missing binary rather than anything about pnpm.
 */
function run(args, env = {}) {
  execFileSync("pnpm", args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
    // `shell` on Windows, where `pnpm` is a `.cmd` and cannot be executed
    // directly. Harmless elsewhere, and the alternative is a script that only
    // works on the CI runner.
    shell: process.platform === "win32",
  });
}

/** Where the generator wrote, which depends on which mode it ran in. */
function manifestPath() {
  // Database mode writes under a per-project directory; file mode writes to the
  // root of `data/output`. The web app reads whichever `STATICFORGE_OUTPUT_DIR`
  // names, so this has to agree with what is exported below.
  return projectId === undefined || projectId === ""
    ? join(ROOT, "data/output/manifest.json")
    : join(ROOT, "data/output", projectId, "manifest.json");
}

if (projectId === undefined || projectId === "") {
  console.log(
    "[generate-site] No STATICFORGE_PROJECT_ID — generating from data/input.\n" +
      "               Set it to build a tenant's real content from the database.",
  );
  run(["generate", "--locale", locale]);
} else {
  console.log(`[generate-site] Generating project ${projectId} from the database.`);
  run(["generate", "--locale", locale, "--project-id", projectId]);
}

const manifest = manifestPath();

if (!existsSync(manifest)) {
  console.error(
    `[generate-site] The generator reported success and wrote no manifest at\n` +
      `                ${manifest}\n` +
      `                Refusing to build a site with no content.`,
  );
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(manifest, "utf8"));
const pages = Array.isArray(parsed) ? parsed : (parsed.pages ?? []);

if (pages.length === 0) {
  console.error(
    "[generate-site] The manifest is empty. The build would succeed and serve\n" +
      "                nothing, which is the failure nobody notices.",
  );
  process.exit(1);
}

console.log(`[generate-site] ${String(pages.length)} page(s) ready at ${manifest}`);

// The web build runs from *here*, with the output directory passed to it,
// rather than being a second command that has to remember where the first one
// wrote. In database mode the output is a per-project subdirectory and the
// app's fallback points at the root, so a build launched separately reads the
// wrong place and finds nothing — succeeding, and serving an empty site.
//
// Printing the variable for a human to set would be the same bug with an extra
// step: an instruction is not a mechanism.
run(["build:web"], { STATICFORGE_OUTPUT_DIR: dirname(manifest) });

// The artifact has to be where the host will look for it, and "where" is
// `outputDirectory` resolved against the Root Directory — `apps/web/.next`.
//
// Getting that wrong does not fail the build. It fails *after* the build, on the
// host, as "output directory not found", which reads like a missing build rather
// than a misconfigured path — and the value that produced it is in a dashboard
// field nobody is looking at. `apps/web/.next` set against a root of `apps/web`
// resolves to `apps/web/apps/web/.next`, and that is exactly the shape of the
// mistake.
//
// Checked here so the error arrives in the build log, next to the thing that
// caused it.
const built = join(ROOT, "apps/web/.next");

if (!existsSync(join(built, "BUILD_ID"))) {
  console.error(
    `[generate-site] The web build finished and left no BUILD_ID at
` +
      `                ${built}
` +
      `                Nothing downstream can serve this.`,
  );
  process.exit(1);
}

console.log(`[generate-site] Built the site from that manifest, into ${built}`);
