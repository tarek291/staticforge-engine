import { parseArgs } from "node:util";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { CsvImportError, importFromCsv } from "./csv-importer.js";

/**
 * CSV → `data/input/*.json` importer.
 *
 * ```bash
 * corepack pnpm import:csv                  # data/input/sample.csv
 * corepack pnpm import:csv --in my.csv      # explicit sheet
 * corepack pnpm import:csv --dry-run        # report only, write nothing
 * ```
 *
 * Pass flags without a `--` separator: the root script delegates through a
 * second pnpm invocation, which would forward the separator itself as an
 * argument.
 *
 * This command **overwrites** `services.json` and `locations.json`. Anything
 * the sheet does not carry is gone, so `--dry-run` prints the summary first.
 */

/**
 * Resolve the monorepo root.
 *
 * pnpm sets `INIT_CWD` to the directory the command was invoked from (the repo
 * root, when run from `staticforge-engine/`). Filtered scripts otherwise run
 * from `packages/core`, so we fall back to walking up two levels.
 */
function resolveRepoRoot(): string {
  return process.env.INIT_CWD ?? resolve(process.cwd(), "../..");
}

/** Candidate sheets, in order, when `--in` is not given. */
function defaultCsvPaths(repoRoot: string): string[] {
  return [join(repoRoot, "data", "input", "sample.csv"), join(repoRoot, "data.csv")];
}

/** Write a JSON file with the 2-space indentation used across `data/`. */
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main(): void {
  const { values } = parseArgs({
    options: {
      in: { type: "string" },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const repoRoot = resolveRepoRoot();

  const csvPath =
    values.in !== undefined
      ? resolve(repoRoot, values.in)
      : defaultCsvPaths(repoRoot).find((candidate) => existsSync(candidate));

  if (csvPath === undefined) {
    console.error(
      `No CSV found. Looked for:\n` +
        defaultCsvPaths(repoRoot)
          .map((candidate) => `  - ${candidate}`)
          .join("\n") +
        `\nPass one explicitly: import:csv -- --in path/to/sheet.csv`,
    );
    process.exit(1);
  }

  if (!existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }

  const { services, locations } = importFromCsv(csvPath);

  console.log(`✓ parsed ${csvPath}`);
  console.log(`  services:  ${services.length}`);
  console.log(`  locations: ${locations.length}`);
  console.log(`  pages this yields: ${services.length * locations.length}`);

  if (values["dry-run"] === true) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  const outDir =
    values["out-dir"] !== undefined
      ? resolve(repoRoot, values["out-dir"])
      : join(repoRoot, "data", "input");

  const servicesPath = join(outDir, "services.json");
  const locationsPath = join(outDir, "locations.json");

  writeJson(servicesPath, services);
  writeJson(locationsPath, locations);

  console.log(`\n✓ wrote ${servicesPath}`);
  console.log(`✓ wrote ${locationsPath}`);
  console.log(`\nRun \`corepack pnpm generate\` to rebuild the pages.`);
}

try {
  main();
} catch (error: unknown) {
  if (error instanceof CsvImportError) {
    console.error(`\n${error.name}: ${error.issues.length} issue(s) in ${error.filePath}\n`);
    for (const issue of error.issues) {
      console.error(`  - row ${issue.row}, ${issue.column}: ${issue.message}`);
    }
  } else if (error instanceof Error) {
    console.error(`\n${error.name}: ${error.message}`);
  } else {
    console.error("\nUnknown error:", error);
  }
  process.exit(1);
}
