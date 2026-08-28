import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import {
  LocaleSchema,
  type GeneratedPage,
  type Locale,
} from "@staticforge/schemas";
import {
  FileContentCache,
  createAnthropicService,
  createAuthoringRouter,
  createMockService,
  isMockAiEnabled,
} from "@staticforge/ai";
import {
  resolveOutputDir,
  validateInternalLinks,
  withInternalLinks,
} from "@staticforge/core";
import { publishSeoArtifacts, resolveSite } from "./publish-seo.js";
import { loadInputData, defaultInputPaths } from "./load-data.js";
import { validateInputData } from "./validate-input.js";
import { buildPages } from "./build-pages.js";
import { applyAiContent, isAiGenerationEnabled } from "./ai-content.js";
import { savePages } from "./save-output.js";
import { ValidationError } from "./errors.js";
import type { RawInputData } from "./types.js";

/**
 * Resolve the monorepo root.
 *
 * pnpm sets `INIT_CWD` to the directory the user invoked the command from
 * (the repo root, when run from `staticforge-engine/`). Filtered scripts
 * otherwise run from `packages/generator`, so we fall back to walking up two
 * levels from the current working directory.
 */
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

/** Command-line options. `projectId` selects the data source. */
interface CliOptions {
  locale: Locale;
  /** Absolute origin to publish at. Overrides SITE_URL and content.siteUrl. */
  siteUrl: string | undefined;
  /** When set, input comes from the database instead of `data/input/`. */
  projectId: string | undefined;
}

/** Parse `--locale` (required) and `--project-id` (optional). */
function parseOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      locale: { type: "string" },
      "project-id": { type: "string" },
      "site-url": { type: "string" },
    },
    allowPositionals: false,
  });

  const parsed = LocaleSchema.safeParse(values.locale);
  if (!parsed.success) {
    const supported = LocaleSchema.options.join(", ");
    console.error(
      `Missing or unsupported --locale. Pass one of: ${supported}\n` +
        `Example: generate --locale ${LocaleSchema.options[0]}`,
    );
    process.exit(1);
  }

  return {
    locale: parsed.data,
    projectId: values["project-id"],
    siteUrl: values["site-url"],
  };
}

/**
 * Load one project's input from the database.
 *
 * `@staticforge/database` is imported dynamically so a local-file run never
 * loads Prisma at all — no client construction, no engine binary, no reason for
 * a machine without a database to carry the cost.
 */
async function loadFromDatabase(
  projectId: string,
  locale: Locale,
): Promise<RawInputData> {
  const { getProjectPayload, prisma, resolveOperatorId } = await import(
    "@staticforge/database"
  );

  // The owner this run acts as. A project belonging to anyone else is simply
  // not found — the same answer as an id that never existed.
  const payload = await getProjectPayload(projectId, resolveOperatorId(), prisma);

  console.log(
    `  workspace: ${payload.workspace.name} (${payload.workspace.slug})`,
  );

  if (payload.locale !== locale) {
    console.warn(
      `  ! project locale is "${payload.locale}" but --locale is "${locale}"; ` +
        `the flag wins.`,
    );
  }

  return {
    businesses: payload.businesses,
    services: payload.services,
    locations: payload.locations,
    content: payload.content,
  };
}

/**
 * Environment variable naming the queue job this run belongs to.
 *
 * Set by the worker. Its presence is what turns an ordinary generation into a
 * *reported* one: the run writes its progress back to the job row a dashboard
 * is polling. Absent — a run started by hand — and nothing is reported, because
 * there is no row to report to.
 */
const JOB_ID_ENV_VAR = "STATICFORGE_JOB_ID";

/** The job this run is reporting to, if any. */
function resolveJobId(): string | undefined {
  const value = process.env[JOB_ID_ENV_VAR]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Environment variable carrying this run's page scope, comma-separated.
 *
 * Set by the worker from the job row. Absent for a run started by hand, which
 * is a full run — the behaviour every run had before scopes existed.
 */
const ONLY_SLUGS_ENV_VAR = "STATICFORGE_ONLY_SLUGS";

/** Environment variables tuning the shared token bucket. */
const RATE_LIMIT_CAPACITY_ENV_VAR = "STATICFORGE_RATE_LIMIT_CAPACITY";
const RATE_LIMIT_REFILL_ENV_VAR = "STATICFORGE_RATE_LIMIT_REFILL_PER_SEC";

/**
 * How much of the provider's allowance one tenant may hold and spend.
 *
 * The defaults are deliberately conservative rather than tuned: a limiter set
 * too high protects nothing, and the cost of one set too low is a slower run
 * rather than a failed one. Both are overridable, because the right numbers
 * belong to the account's actual plan and this engine cannot know it.
 */
function resolveRateLimitPolicy(): {
  maxCapacity: number;
  refillRatePerSec: number;
} {
  const read = (name: string, fallback: number): number => {
    const raw = process.env[name];
    const value = raw === undefined ? Number.NaN : Number(raw);

    // A malformed value falls back rather than propagating. `NaN` capacity
    // would make every comparison false and refuse every call — a limiter that
    // fails closed on a typo is a build that never starts.
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  return {
    maxCapacity: read(RATE_LIMIT_CAPACITY_ENV_VAR, 160_000),
    refillRatePerSec: read(RATE_LIMIT_REFILL_ENV_VAR, 2_600),
  };
}

/**
 * The pages this run may author, if it is scoped.
 *
 * An unset or blank variable means unscoped, and that fallback is the important
 * one: a scope that fails to arrive costs a full run, which is expensive and
 * correct. The opposite reading — treating an unreadable scope as "author
 * nothing" — would be cheap and silently wrong, publishing a project whose
 * pages nobody had ever authored.
 */
function resolveOnlySlugs(): string[] | undefined {
  const raw = process.env[ONLY_SLUGS_ENV_VAR]?.trim();

  if (raw === undefined || raw === "") {
    return undefined;
  }

  const slugs = raw
    .split(",")
    .map((slug) => slug.trim())
    .filter((slug) => slug !== "");

  return slugs.length === 0 ? undefined : slugs;
}

/**
 * Persist a run's pages for one project.
 *
 * Runs only in database mode, after validation and the optional AI pass have
 * both succeeded, so a failed run never writes half-authored pages. Prisma is
 * imported dynamically here for the same reason as on the read side.
 */
async function persistToDatabase(
  projectId: string,
  pages: GeneratedPage[],
): Promise<{ saved: number; removed: number; preserved: number }> {
  const { saveGeneratedPages, prisma, resolveOperatorId } = await import(
    "@staticforge/database"
  );

  return saveGeneratedPages(projectId, resolveOperatorId(), pages, prisma, {
    // Provenance, so a dashboard can tell an authored page from a templated one.
    source: isAiGenerationEnabled() ? "AI" : "TEMPLATE",
  });
}

async function main(): Promise<void> {
  const { locale, projectId, siteUrl } = parseOptions();
  const repoRoot = resolveRepoRoot();
  const inputDir = join(repoRoot, "data", "input");
  // Isolated per project. A database run writes its own subtree, because
  // `savePages` clears the pages directory before writing it: two tenants
  // sharing one directory means one run deletes the other's site.
  const outputDir = resolveOutputDir(repoRoot, projectId);

  // Dual mode: --project-id switches the source of input. Everything after this
  // point — validation, page building, AI, saving — is identical either way.
  const raw =
    projectId !== undefined
      ? await loadFromDatabase(projectId, locale)
      : await loadInputData(defaultInputPaths(inputDir));

  console.log(
    projectId !== undefined
      ? `✓ input loaded from database (project ${projectId})`
      : "✓ input loaded from data/input",
  );

  const validated = validateInputData(raw);
  console.log("✓ input validated");

  // Profiles are data now. Resolved here, at the composition root, and handed
  // to a `buildPages` that stays pure and synchronous — a local file run has no
  // database to ask and must keep working exactly as it did.
  const profiles =
    projectId === undefined
      ? undefined
      : await (async () => {
          const { loadProfileRegistry, prisma, resolveOperatorId } = await import(
            "@staticforge/database"
          );
          const loaded = await loadProfileRegistry(resolveOperatorId(), prisma);
          console.log(
            `✓ ${Object.keys(loaded).length} content profile(s) loaded: ` +
              `${Object.keys(loaded).join(", ")}`,
          );
          return loaded;
        })();

  let pages = buildPages(validated, {
    locale,
    ...(profiles !== undefined ? { profiles } : {}),
  });
  console.log(`✓ pages built (${pages.length})`);

  const jobId = resolveJobId();

  // The total is reported as soon as it is known and not before: a job that has
  // not loaded its input cannot honestly say how many pages it will produce,
  // and zero would read as "nothing to do".
  if (jobId !== undefined && projectId !== undefined) {
    const { prisma, reportJobProgress, resolveOperatorId } = await import(
      "@staticforge/database"
    );
    await reportJobProgress(
      jobId,
      { totalCount: pages.length, completedCount: 0, failedCount: 0 },
      resolveOperatorId(),
      prisma,
    );
  }

  // Opt-in only. Without USE_AI_GENERATION=true the deterministic pages built
  // above are saved unchanged, exactly as before.
  const onlySlugs = resolveOnlySlugs();

  if (isAiGenerationEnabled()) {
    console.log(
      onlySlugs === undefined
        ? `… authoring content with AI (${pages.length} pages)`
        : `… authoring content with AI (${onlySlugs.length} of ${pages.length} pages; ` +
            `the rest are outside this run's scope and are left as they are)`,
    );

    // AI_MOCK swaps in a no-cost authoring service. Every downstream gate still
    // runs — the mock builds its content from the real content profile — so a
    // load test exercises the architecture without buying prose.
    const mocked = isMockAiEnabled();

    // One service per content profile, built on first use. Pages in a single
    // run may be held to different profiles, and a service is built around one.
    const cache = new FileContentCache(join(repoRoot, "data", "cache", "content"));

    // The tenant's shared token budget, when there is a tenant. Built here, at
    // the composition root, because this is the only place that knows both the
    // project id and the database — and because the service must not be able to
    // choose its own bucket.
    //
    // A local file run gets none: there is no tenant, no other worker, and
    // nothing to coordinate with.
    const rateLimiter =
      projectId === undefined
        ? undefined
        : await (async () => {
            const { createProjectRateLimiter, prisma } = await import(
              "@staticforge/database"
            );
            const policy = resolveRateLimitPolicy();
            console.log(
              `  · rate limit: ${policy.maxCapacity} tokens, ` +
                `${policy.refillRatePerSec}/s refill (shared across workers)`,
            );
            return createProjectRateLimiter(projectId, policy, prisma);
          })();

    const router = createAuthoringRouter(
      (profile) =>
        mocked
          ? createMockService({ profile })
          : // Cached content survives between runs, so an unrelated rebuild does
            // not re-buy pages whose source has not moved.
            createAnthropicService({
              profile,
              cache,
              ...(rateLimiter !== undefined ? { rateLimiter } : {}),
              rateLimit: {
                onWait: ({ waitForMs, totalWaitedMs }) => {
                  // Said out loud. A run that pauses without explaining itself
                  // looks like a run that has hung, and the operator's next
                  // move is to kill it.
                  console.log(
                    `  · rate limited — waiting ${Math.round(waitForMs / 1000)}s ` +
                      `(${Math.round(totalWaitedMs / 1000)}s total)`,
                  );
                },
              },
            }),
      // The same registry the page assembly was checked against. Two registries
      // would let a page pass validation under one policy and be authored under
      // another.
      profiles,
    );

    if (mocked) {
      console.log("  ! AI_MOCK=true — content is generated, not authored");
    }

    let hits = 0;
    let resumedCount = 0;
    let skippedCount = 0;

    // Pages a previous attempt at this project already authored. Only available
    // in database mode: a local file run has no earlier attempt to resume from.
    const resumeFrom =
      projectId === undefined
        ? undefined
        : await (async () => {
            const { loadResumablePages, prisma, resolveOperatorId } = await import(
              "@staticforge/database"
            );
            const found = await loadResumablePages(
              projectId,
              resolveOperatorId(),
              prisma,
            );
            if (found.size > 0) {
              console.log(
                `  · ${found.size} page(s) from an earlier attempt are available to resume`,
              );
            }
            return found;
          })();

    // Reported after every page, so a dashboard polling the job row sees a run
    // advancing rather than a blank bar followed by a verdict.
    const reportCount =
      jobId === undefined || projectId === undefined
        ? undefined
        : async ({ completed, total }: { completed: number; total: number }) => {
            const { prisma, reportJobProgress, resolveOperatorId } = await import(
              "@staticforge/database"
            );
            await reportJobProgress(
              jobId,
              { completedCount: completed, totalCount: total },
              resolveOperatorId(),
              prisma,
            ).catch(() => {
              // A failed progress write must not abort the run it only reports
              // on. The next page reports again, and the lease is what proves
              // the run is alive.
            });
          };

    pages = await applyAiContent(
      pages,
      validated,
      (request) => router.authorPage(request),
      {
        ...(resumeFrom !== undefined ? { resumeFrom } : {}),
        ...(reportCount !== undefined ? { onCount: reportCount } : {}),
        ...(onlySlugs !== undefined ? { onlySlugs } : {}),
        // Rate-limit pacing is meaningless against a mock, and at scale it
        // would dominate the run: 500 pages three seconds apart is 25 minutes
        // of sleeping.
        ...(mocked ? { delayMs: 0 } : {}),
        onProgress: ({ done, total, slug, cacheHit, resumed, skipped }) => {
          if (cacheHit) hits += 1;
          if (resumed) resumedCount += 1;
          if (skipped) skippedCount += 1;
          // One line per page buries the result at scale, so report in batches
          // once a run is large.
          if (total <= 20 || done % 50 === 0 || done === total) {
            const mark = skipped
              ? " (out of scope)"
              : resumed
                ? " (resumed)"
                : cacheHit
                  ? " (cached)"
                  : "";
            console.log(`  · ${done}/${total} ${slug}${mark}`);
          }
        },
      },
    );

    console.log(
      `✓ AI content applied ` +
        `(${pages.length - hits - resumedCount - skippedCount} generated, ` +
        `${hits} from cache, ${resumedCount} resumed` +
        (skippedCount > 0 ? `, ${skippedCount} out of scope` : "") +
        `, profiles: ${router.profilesUsed.join(", ")})`,
    );
  }

  // Internal links are computed last, over the final set of pages, because a
  // link may only target a page that exists in this build — and AI authoring
  // rewrites the very titles the anchors are drawn from.
  pages = withInternalLinks(pages);

  const linkIssues = validateInternalLinks(pages);
  if (linkIssues.length > 0) {
    throw new ValidationError(
      "links",
      linkIssues.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }

  const linkCount = pages.reduce((total, page) => total + page.links.length, 0);
  console.log(`✓ internal links (${linkCount} across ${pages.length} pages)`);

  // Dual-write: the static files are always produced, because Next builds from
  // them in both modes. In database mode the pages are additionally persisted.
  await savePages(pages, outputDir);
  console.log("✓ output saved");

  const resolved = resolveSite({
    flag: siteUrl,
    env: process.env.SITE_URL,
    contentSiteUrl: validated.content.siteUrl,
  });

  if (resolved === undefined) {
    // A local build with no domain is ordinary, but silence would hide a
    // missing sitemap on a real deploy, so say so plainly.
    console.log(
      "· no site URL (--site-url, SITE_URL or content.siteUrl) — skipping sitemap and robots.txt",
    );
  } else {
    const artifacts = await publishSeoArtifacts(pages, resolved.site, outputDir);
    console.log(
      `✓ published ${artifacts.map((a) => a.fileName).join(", ")} for ${resolved.site.url} (from ${resolved.source})`,
    );
  }

  if (projectId !== undefined) {
    const { saved, removed, preserved } = await persistToDatabase(projectId, pages);
    console.log(
      `✓ database updated (${saved} saved` +
        (removed > 0 ? `, ${removed} stale removed` : "") +
        (preserved > 0 ? `, ${preserved} kept` : "") +
        ")",
    );

    if (preserved > 0) {
      // Said plainly rather than tucked into the count: an operator who edited
      // these pages and then pressed Generate would otherwise assume the run
      // overwrote them and go looking for damage that never happened.
      console.log(
        `  · ${preserved} page(s) carry manual edits and were left untouched. ` +
          `Delete the page to let a run rewrite it.`,
      );
    }
  }

  // The closing progress report.
  //
  // Needed for its own sake, not merely as a rounding-up: the per-page counter
  // lives inside the AI pass, so a deterministic run never touches it and a
  // finished template job would sit at 0% while reading COMPLETED. A run that
  // reached here produced every page it set out to, and the row should say so
  // before the worker writes the verdict.
  if (jobId !== undefined && projectId !== undefined) {
    const { prisma, reportJobProgress, resolveOperatorId } = await import(
      "@staticforge/database"
    );
    await reportJobProgress(
      jobId,
      { totalCount: pages.length, completedCount: pages.length },
      resolveOperatorId(),
      prisma,
    ).catch(() => {
      // The pages are written and the run succeeded. Failing it now over a
      // progress row would turn a completed build into a reported failure.
    });
  }

  console.log(`\nGenerated ${pages.length} pages (locale: ${locale})`);
  console.log(`Output directory: ${outputDir}`);
}

main().catch((error: unknown) => {
  if (error instanceof ValidationError) {
    console.error(`\n${error.name}: ${error.issues.length} issue(s)\n`);
    for (const issue of error.issues) {
      console.error(`  - ${issue.path}: ${issue.message}`);
    }
  } else if (error instanceof Error) {
    console.error(`\n${error.name}: ${error.message}`);
  } else {
    console.error("\nUnknown error:", error);
  }
  process.exit(1);
});
