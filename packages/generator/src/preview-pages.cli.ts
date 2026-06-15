import { resolve, join } from "node:path";
import { loadInputData, defaultInputPaths } from "./load-data.js";
import { validateInputData } from "./validate-input.js";
import { buildPages } from "./build-pages.js";
import { ValidationError } from "./errors.js";

/** Expected number of pages for the current sample data (1 × 3 × 3). */
const EXPECTED_PAGE_COUNT = 9;

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

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const inputDir = join(repoRoot, "data", "input");
  const paths = defaultInputPaths(inputDir);

  console.log(`Loading input from: ${inputDir}`);
  const raw = await loadInputData(paths);
  const validated = validateInputData(raw);
  const pages = buildPages(validated, { locale: "de" });

  console.log("\nCounts");
  console.log(`  businesses:      ${validated.businesses.length}`);
  console.log(`  services:        ${validated.services.length}`);
  console.log(`  locations:       ${validated.locations.length}`);
  console.log(`  generated pages: ${pages.length}`);

  if (pages.length !== EXPECTED_PAGE_COUNT) {
    console.error(
      `\nAssertion failed: expected ${EXPECTED_PAGE_COUNT} pages, got ${pages.length}`,
    );
    process.exit(1);
  }

  const sample = pages[0];
  if (sample === undefined) {
    console.error("\nAssertion failed: no pages were generated");
    process.exit(1);
  }

  console.log("\nSample generated page");
  console.log(`  slug:            ${sample.slug}`);
  console.log(`  locale:          ${sample.locale}`);
  console.log(`  title:           ${sample.title}`);
  console.log(`  metaDescription: ${sample.metaDescription}`);
  console.log(`  h1:              ${sample.h1}`);
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
