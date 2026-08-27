import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { createMockService } from "@staticforge/ai";
import {
  buildSitemapArtifacts,
  resolveOutputDir,
  validateInternalLinks,
  withInternalLinks,
} from "@staticforge/core";
import {
  CONTENT_PROFILES,
  DEFAULT_CONTENT_PROFILE,
  LocaleSchema,
  type Locale,
} from "@staticforge/schemas";

import { applyAiContent } from "./ai-content.js";
import { buildPages } from "./build-pages.js";
import { loadInputData, defaultInputPaths } from "./load-data.js";
import { publishSeoArtifacts, resolveSite } from "./publish-seo.js";
import { savePages } from "./save-output.js";
import { validateInputData } from "./validate-input.js";
import type { RawInputData } from "./types.js";

/**
 * Load benchmark for the generation pipeline.
 *
 * ```bash
 * corepack pnpm --filter @staticforge/generator bench --project-id prj-scale-500
 * corepack pnpm --filter @staticforge/generator bench --local
 * ```
 *
 * Runs the real pipeline stage by stage with a mock authoring service, timing
 * each stage and sampling heap use throughout. Authoring is mocked because the
 * question at this scale is whether the *architecture* holds — memory, the link
 * graph, slug uniqueness, sitemap generation — none of which depends on what
 * the prose says.
 *
 * Every invariant is asserted rather than eyeballed: a benchmark that reports
 * timings while quietly producing a broken graph is worse than no benchmark.
 */

interface Stage {
  name: string;
  ms: number;
}

/** Samples heap use so the report shows a peak, not a single lucky reading. */
class HeapSampler {
  private peak = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(intervalMs = 25) {
    this.timer = setInterval(() => {
      this.peak = Math.max(this.peak, process.memoryUsage().heapUsed);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): number {
    clearInterval(this.timer);
    return Math.max(this.peak, process.memoryUsage().heapUsed);
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Run one stage, recording how long it took. */
async function stage<T>(
  stages: Stage[],
  name: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const started = Date.now();
  const result = await run();
  stages.push({ name, ms: Date.now() - started });
  return result;
}

/** Assert an invariant, failing the benchmark loudly when it does not hold. */
function check(label: string, condition: boolean, detail = ""): boolean {
  console.log(`  ${condition ? "✓" : "✗"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  return condition;
}

function resolveRepoRoot(): string {
  // STATICFORGE_REPO_ROOT is the explicit contract, checked first: npx and npm
  // rewrite INIT_CWD to their own working directory, so a parent process cannot
  // hand the root down through it.
  return (
    process.env.STATICFORGE_REPO_ROOT ??
    process.env.INIT_CWD ??
    resolve(process.cwd(), "../..")
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "project-id": { type: "string" },
      local: { type: "boolean", default: false },
      locale: { type: "string", default: "de" },
      "sitemap-split-at": { type: "string" },
      profile: { type: "string" },
    },
    allowPositionals: false,
  });

  const locale: Locale = LocaleSchema.parse(values.locale);
  const repoRoot = resolveRepoRoot();
  const projectId = values["project-id"];
  // Isolated per project, matching the generate run this benchmarks.
  const outputDir = resolveOutputDir(repoRoot, projectId);

  if (projectId === undefined && values.local !== true) {
    console.error("Pass --project-id <id> to benchmark a database project, or --local.");
    process.exit(1);
  }

  const sampler = new HeapSampler();
  const stages: Stage[] = [];
  const startedAt = Date.now();

  const raw: RawInputData = await stage(stages, "load", async () => {
    if (projectId === undefined) {
      return loadInputData(defaultInputPaths(join(repoRoot, "data", "input")));
    }
    const { getProjectPayload, prisma, resolveOperatorId } = await import(
      "@staticforge/database"
    );
    const payload = await getProjectPayload(projectId, resolveOperatorId(), prisma);
    return {
      businesses: payload.businesses,
      services: payload.services,
      locations: payload.locations,
      content: payload.content,
    };
  });

  const validated = await stage(stages, "validate", () => validateInputData(raw));

  const built = await stage(stages, "build", () => buildPages(validated, { locale }));

  // The mock sizes its content from the profile, so the profile decides how
  // much body each page carries — and therefore how many links a page earns.
  const profile = CONTENT_PROFILES[values.profile ?? "default"] ?? DEFAULT_CONTENT_PROFILE;
  const mockService = createMockService({ profile });

  const authored = await stage(stages, "author (mock)", () =>
    applyAiContent(
      built,
      validated,
      (request) => mockService.authorPage(request),
      { delayMs: 0 },
    ),
  );

  const linked = await stage(stages, "link graph", () => withInternalLinks(authored));

  const linkIssues = await stage(stages, "link validate", () =>
    validateInternalLinks(linked),
  );

  await stage(stages, "save output", () => savePages(linked, outputDir));

  const site = resolveSite({
    flag: undefined,
    env: process.env.SITE_URL,
    contentSiteUrl: validated.content.siteUrl,
  });

  const artifacts = await stage(stages, "publish", async () =>
    site === undefined ? [] : publishSeoArtifacts(linked, site.site, outputDir),
  );

  const peak = sampler.stop();
  const totalMs = Date.now() - startedAt;

  // --- Report ---------------------------------------------------------------

  console.log(
    `\n=== Scale benchmark: ${linked.length} pages, profile "${profile.id}" ===\n`,
  );

  console.log("Stages");
  for (const item of stages) {
    const perPage = linked.length > 0 ? (item.ms / linked.length).toFixed(2) : "—";
    console.log(
      `  ${item.name.padEnd(14)} ${String(item.ms).padStart(7)} ms   ${perPage} ms/page`,
    );
  }
  console.log(`  ${"TOTAL".padEnd(14)} ${String(totalMs).padStart(7)} ms`);

  console.log("\nMemory");
  console.log(`  peak heap      ${mb(peak)}`);
  console.log(`  rss            ${mb(process.memoryUsage().rss)}`);
  console.log(`  heap per page  ${mb(peak / Math.max(1, linked.length))}`);

  console.log("\nInvariants");

  const slugs = linked.map((page) => page.slug);
  const known = new Set(slugs);
  const inbound = new Map(slugs.map((slug) => [slug, 0]));
  let brokenTargets = 0;
  let selfLinks = 0;
  let totalLinks = 0;

  for (const page of linked) {
    for (const link of page.links) {
      totalLinks += 1;
      if (!known.has(link.slug)) brokenTargets += 1;
      if (link.slug === page.slug) selfLinks += 1;
      inbound.set(link.slug, (inbound.get(link.slug) ?? 0) + 1);
    }
  }

  const orphans = [...inbound].filter(([, count]) => count === 0).length;

  const results = [
    check("slugs are unique", known.size === slugs.length, `${known.size}/${slugs.length}`),
    check("no broken link targets", brokenTargets === 0, `${brokenTargets} broken`),
    check("no self links", selfLinks === 0),
    check("no orphan pages", orphans === 0, `${orphans} orphaned`),
    check("link graph validates", linkIssues.length === 0, `${linkIssues.length} issues`),
    check(
      "every page carries provenance",
      linked.every((page) => page.generation !== undefined),
    ),
    check("sitemap published", artifacts.some((a) => a.fileName === "sitemap.xml")),
    check("robots published", artifacts.some((a) => a.fileName === "robots.txt")),
  ];

  console.log(`\n  ${totalLinks} internal links, ${(totalLinks / Math.max(1, linked.length)).toFixed(2)} per page`);

  // Splitting only engages past the protocol ceiling, which 500 pages does not
  // reach — so prove it here at a threshold this run does cross.
  if (site !== undefined) {
    const splitAt = Number(values["sitemap-split-at"] ?? 200);
    const split = buildSitemapArtifacts(linked, site.site, { urlsPerFile: splitAt });
    const locs = split
      .slice(1)
      .flatMap((part) => [...part.contents.matchAll(/<loc>/g)]).length;

    console.log(
      `\n  sitemap at ${splitAt}/file → ${split.length} files, ${locs} URLs across parts`,
    );
    results.push(
      check(
        "sitemap splits into an index",
        split.length > 1 && split[0]?.contents.includes("<sitemapindex") === true,
      ),
      check("split loses no URL", locs === linked.length),
    );
  }

  if (results.includes(false)) {
    console.error("\n✗ Benchmark failed: an invariant did not hold.");
    process.exitCode = 1;
    return;
  }

  console.log("\n✓ All invariants held.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
