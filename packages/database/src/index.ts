import { PrismaClient } from "@prisma/client";

/**
 * Shared Prisma client.
 *
 * Next.js hot-reloads modules on every edit in development. A module-scope
 * `new PrismaClient()` would therefore create a fresh client — and a fresh
 * connection pool — on each reload, until Postgres refuses new connections.
 * Caching the instance on `globalThis`, which survives module reloads, keeps
 * exactly one client alive per process.
 *
 * In production the module graph is stable, so the cache is skipped and the
 * client stays a plain module-scope singleton.
 */

/** `globalThis`, widened with the slot the development cache uses. */
const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

/**
 * Process-wide Prisma client.
 *
 * Reads `DATABASE_URL` from the environment (see `prisma/schema.prisma`).
 * Connects lazily on the first query, so importing this module is safe in
 * contexts that never touch the database.
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export * from "./retry.js";
export * from "./repository.js";
export * from "./queue.js";
export * from "./sync.js";
export * from "./impact.js";
export * from "./registry.js";
export * from "./registry-seed.js";
export * from "./tenant.js";

export { PrismaClient } from "@prisma/client";
export type {
  Workspace,
  Project,
  Service,
  Location,
  GeneratedPage,
  GenerationJob,
  JobKind,
  JobStatus,
  PageSource,
  Prisma,
} from "@prisma/client";
