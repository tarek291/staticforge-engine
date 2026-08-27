import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { LocaleSchema, type Locale } from "@staticforge/schemas";
import { generatePageContent } from "@staticforge/ai";
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
  return process.env.INIT_CWD ?? resolve(process.cwd(), "../..");
}

/** Command-line options. `projectId` selects the data source. */
interface CliOptions {
  locale: Locale;
  /** When set, input comes from the database instead of `data/input/`. */
  projectId: string | undefined;
}

/** Parse `--locale` (required) and `--project-id` (optional). */
function parseOptions(): CliOptions {
  const { values } = parseArgs({
    options: {
      locale: { type: "string" },
      "project-id": { type: "string" },
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

  return { locale: parsed.data, projectId: values["project-id"] };
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
  const { getProjectPayload, prisma } = await import("@staticforge/database");

  const payload = await getProjectPayload(projectId, prisma);

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

async function main(): Promise<void> {
  const { locale, projectId } = parseOptions();
  const repoRoot = resolveRepoRoot();
  const inputDir = join(repoRoot, "data", "input");
  const outputDir = join(repoRoot, "data", "output");

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

  let pages = buildPages(validated, { locale });
  console.log(`✓ pages built (${pages.length})`);

  // Opt-in only. Without USE_AI_GENERATION=true the deterministic pages built
  // above are saved unchanged, exactly as before.
  if (isAiGenerationEnabled()) {
    console.log(`… authoring content with AI (${pages.length} pages)`);
    pages = await applyAiContent(pages, validated, generatePageContent, {
      onProgress: ({ done, total, slug }) => {
        console.log(`  · ${done}/${total} ${slug}`);
      },
    });
    console.log("✓ AI content applied");
  }

  await savePages(pages, outputDir);
  console.log("✓ output saved");

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
