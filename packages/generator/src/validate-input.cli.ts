import { resolve, join } from "node:path";
import { loadInputData, defaultInputPaths } from "./load-data.js";
import { validateInputData } from "./validate-input.js";
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

async function main(): Promise<void> {
  const repoRoot = resolveRepoRoot();
  const inputDir = join(repoRoot, "data", "input");
  const paths = defaultInputPaths(inputDir);

  console.log(`Loading input from: ${inputDir}`);
  const raw = await loadInputData(paths);
  const validated = validateInputData(raw);

  console.log("Validation passed ✓");
  console.log(`  businesses: ${validated.businesses.length}`);
  console.log(`  services:   ${validated.services.length}`);
  console.log(`  locations:  ${validated.locations.length}`);
  console.log(`  faqs:       ${validated.content.faqs.length}`);
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
