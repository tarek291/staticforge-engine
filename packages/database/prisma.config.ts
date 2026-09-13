import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * Replaces the `prisma` block in `package.json`, which Prisma 6 deprecates and
 * Prisma 7 removes.
 *
 * ## The part that is not a rename
 *
 * Moving this out of `package.json` changes behaviour, and Prisma says so in one
 * line of build output that is easy to read past:
 *
 * ```
 * Prisma config detected, skipping environment variable loading.
 * ```
 *
 * With a config file present the CLI **stops loading `.env` by itself**. The
 * schema's datasource is `env("DATABASE_URL")`, so a straight migration takes
 * `prisma db push`, `db seed`, `validate` and `studio` from working to
 * `Environment variable not found: DATABASE_URL` — while `generate`, the one
 * command the deploy happens to run, keeps succeeding. A warning traded for a
 * failure that shows up later and somewhere else.
 *
 * So the file loads the environment itself, which is now this file's job.
 *
 * ## Why `process.loadEnvFile` and not `dotenv`
 *
 * It is built into Node from 20.12, and the repository already requires Node 20.
 * Adding a dependency to read a file the runtime can already read would be a
 * package to keep updated for no capability.
 *
 * Guarded by `existsSync`, because a missing `.env` is normal rather than
 * exceptional — CI has no database and does not need one, and the file is
 * git-ignored so a fresh clone starts without it. `loadEnvFile` throws on a
 * missing file, and an unguarded call would make every CI run fail on a file
 * that is *supposed* to be absent.
 *
 * Existing variables win. A `DATABASE_URL` exported by a deployment, a CI
 * secret, or a shell is the one somebody chose deliberately, and a file on disk
 * should not quietly replace it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const envFile = join(HERE, ".env");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    // Unchanged from the `package.json` block this replaces. `corepack pnpm
    // --filter @staticforge/database db:seed` still runs it.
    seed: "tsx prisma/seed.ts",
  },
});
