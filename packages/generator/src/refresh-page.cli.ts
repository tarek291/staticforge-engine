import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { createAnthropicService, createMockService, isMockAiEnabled } from "@staticforge/ai";
import { resolveOutputDir } from "@staticforge/core";
import {
  CONTENT_PROFILES,
  DEFAULT_CONTENT_PROFILE,
  GeneratedPageSchema,
  LocaleSchema,
  PageSlugSchema,
} from "@staticforge/schemas";

import { refreshPage } from "./refresh-page.js";
import { savePages } from "./save-output.js";
import { validateInputData } from "./validate-input.js";
import { ValidationError } from "./errors.js";

/**
 * Revise one page against operator feedback.
 *
 * ```bash
 * STATICFORGE_FEEDBACK="Add pricing detail." \
 *   corepack pnpm --filter @staticforge/generator refresh \
 *   --project-id prj-glanzfix-de --slug bueroreinigung-duisburg
 * ```
 *
 * ## Why the feedback is an environment variable
 *
 * It is free text written by an operator, and this command is spawned by the
 * dashboard. On Windows the spawn goes through a shell, so anything in `argv`
 * is shell-parsed: a note containing `&` or a quote would break the command at
 * best and inject at worst. Values passed through the environment are handed to
 * the process directly and never parsed.
 *
 * The ids that *do* travel in `argv` are validated against their own formats
 * before the command is built, for the same reason.
 */

const FEEDBACK_ENV_VAR = "STATICFORGE_FEEDBACK";

function resolveRepoRoot(): string {
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
      slug: { type: "string" },
      locale: { type: "string", default: "de" },
    },
    allowPositionals: false,
  });

  const projectId = values["project-id"];
  const slug = values.slug;
  const feedback = process.env[FEEDBACK_ENV_VAR] ?? "";

  if (projectId === undefined || slug === undefined) {
    console.error("Both --project-id and --slug are required.");
    process.exit(1);
  }

  if (!PageSlugSchema.safeParse(slug).success) {
    console.error(`Invalid slug "${slug}".`);
    process.exit(1);
  }

  if (feedback.trim().length === 0) {
    console.error(
      `${FEEDBACK_ENV_VAR} is empty. A refresh with no feedback would rewrite ` +
        `a page for no stated reason.`,
    );
    process.exit(1);
  }

  const locale = LocaleSchema.parse(values.locale);
  const repoRoot = resolveRepoRoot();
  // The same isolated subtree the generate run wrote, or the refresh would
  // rewrite a different tenant's output file.
  const outputDir = resolveOutputDir(repoRoot, projectId);

  const {
    getPageForUser,
    getProjectPayload,
    prisma,
    resolveOperatorId,
    saveRefreshedPage,
  } = await import("@staticforge/database");

  const userId = resolveOperatorId();

  const payload = await getProjectPayload(projectId, userId, prisma);
  const validated = validateInputData({
    businesses: payload.businesses,
    services: payload.services,
    locations: payload.locations,
    content: payload.content,
  });

  const stored = await getPageForUser(projectId, slug, userId, prisma);

  if (stored === null) {
    console.error(`No page "${slug}" in project "${projectId}".`);
    process.exit(1);
  }

  // The page row carries no businessId — a project has exactly one business —
  // so it is restored from the payload rather than stored twice.
  const business = payload.businesses[0];
  if (business === undefined) {
    console.error("Project has no business record.");
    process.exit(1);
  }

  const page = GeneratedPageSchema.parse({ ...stored, businessId: business.id, locale });

  console.log(`✓ loaded ${slug} (${page.contentProfileId} / ${page.templateId})`);

  const profile = CONTENT_PROFILES[page.contentProfileId] ?? DEFAULT_CONTENT_PROFILE;
  const mocked = isMockAiEnabled();

  const service = mocked
    ? createMockService({ profile })
    : createAnthropicService({ profile });

  if (mocked) {
    console.log("  ! AI_MOCK=true — content is generated, not authored");
  }

  const result = await refreshPage(page, validated, feedback, (request) =>
    // A refresh never reads the cache: the operator is asking for a change, and
    // the base key does not encode the feedback anyway.
    service.refreshPage === undefined
      ? service.authorPage(request)
      : service.refreshPage(request),
  );

  console.log(
    result.changed
      ? `✓ revised (${result.previousContentHash} → ${result.contentHash})`
      : `· unchanged (${result.contentHash}) — the model judged the feedback already satisfied`,
  );

  const written = await saveRefreshedPage(projectId, result.page, userId, prisma);

  if (!written) {
    // The scoped read above found the page, so reaching this means it moved or
    // changed hands mid-run. Writing the file anyway would leave the static
    // output claiming a revision the database never accepted.
    console.error(
      `Page "${slug}" in project "${projectId}" could not be written. ` +
        `It no longer exists, or is no longer yours.`,
    );
    process.exit(1);
  }

  console.log("✓ database updated");

  // The static file has to move with the row, or the next build would publish
  // the old copy and quietly undo the revision.
  const { readdir, readFile } = await import("node:fs/promises");
  const pagesDir = join(outputDir, "pages");
  const files = await readdir(pagesDir);
  const all = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) =>
        GeneratedPageSchema.parse(
          JSON.parse(await readFile(join(pagesDir, file), "utf8")) as unknown,
        ),
      ),
  );

  await savePages(
    all.map((item) => (item.slug === result.page.slug ? result.page : item)),
    outputDir,
  );

  console.log("✓ output saved");
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
