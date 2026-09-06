import type { ReactElement } from "react";

import { isDatabaseReachable, prisma } from "@staticforge/database";

import { ProjectsList } from "./projects-list";

/**
 * The dashboard index.
 *
 * ## Why this page no longer lists projects
 *
 * It used to read them server-side as `LOCAL_OPERATOR_ID` — a constant, not an
 * identity. That was honest while there was one operator and no notion of who
 * anyone was, and it stopped being defensible the moment organizations,
 * memberships and roles existed: a server component rendering one tenant's data
 * on the strength of a hardcoded string is a tenancy boundary that exists
 * everywhere except here.
 *
 * Removing the constant left this page with no way to know who was asking, so
 * it rendered a shell that pointed at the authenticated API. That was a real
 * loss of function and the correct trade: the alternative was keeping an
 * unauthenticated read of tenant data because it was convenient, which is the
 * shape of every "temporary" hole that ships.
 *
 * ## What Phase 32 changed
 *
 * The shell is gone. There is a session cookie now, and the list is fetched
 * from the browser against `GET /api/dashboard/projects` — the same endpoint an
 * API key calls, with the same membership scoping.
 *
 * Deliberately *not* read server-side from Prisma, even though a Server
 * Component could and it would save a round trip. That would be a second
 * authorisation path, and a second path is where the two quietly diverge the
 * first time a rule changes in one of them. One door.
 *
 * This page stays a Server Component for the one thing it can still answer
 * without knowing who is asking: whether there is a database at all.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "StaticForge — Dashboard",
  robots: { index: false, follow: false },
};

export default async function DashboardPage(): Promise<ReactElement> {
  // The one thing this page can still answer without knowing who is asking:
  // whether the engine has a database at all. It names no tenant and leaks no
  // row.
  const reachable = await isDatabaseReachable(prisma);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-neutral-500">
          Every organization you belong to, through the same authenticated
          endpoint an integration calls.
        </p>
      </header>

      <ProjectsList />

      {!reachable && (
        <p className="rounded-md border border-neutral-200 p-6 text-sm text-neutral-500 dark:border-neutral-800">
          No database reachable. Set <code>DATABASE_URL</code> to browse cloud
          projects — the engine also runs entirely from <code>data/input</code>,
          which needs no database at all.
        </p>
      )}
    </div>
  );
}
