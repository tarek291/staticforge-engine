import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { LocaleSchema, type Locale } from "@staticforge/schemas";
import { loadInputData, defaultInputPaths } from "./load-data.js";
import { validateInputData } from "./validate-input.js";
import { buildPages } from "./build-pages.js";
import { savePages } from "./save-output.js";
import { ValidationError } from "./errors.js";

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

/** Parse and validate the required `--locale` argument. */
function parseLocale(): Locale {
  const { values } = parseArgs({
    options: { locale: { type: "string" } },
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
  return parsed.data;
}

async function main(): Promise<void> {
  const locale = parseLocale();
  const repoRoot = resolveRepoRoot();
  const inputDir = join(repoRoot, "data", "input");
  const outputDir = join(repoRoot, "data", "output");

  const raw = await loadInputData(defaultInputPaths(inputDir));
  console.log("✓ input loaded");

  const validated = validateInputData(raw);
  console.log("✓ input validated");

  const pages = buildPages(validated, { locale });
  console.log(`✓ pages built (${pages.length})`);

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
