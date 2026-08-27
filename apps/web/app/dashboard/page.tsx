import Link from "next/link";
import type { ReactElement } from "react";

import { DASHBOARD_ENV_VAR, isDashboardEnabled } from "@/lib/dashboard/guard";
import { instanceId } from "@/lib/dashboard/instance";
import {
  LOCAL_OPERATOR_ID,
  failOrphanedJobs,
  isDatabaseReachable,
  listProjectsForUser,
  prisma,
} from "@staticforge/database";

/**
 * The dashboard index: every project the database holds.
 *
 * Dynamic, and it must be. The generated pages are static because their content
 * is fixed at build time; this reads live rows, and prerendering it would show
 * an operator whatever was true when the site was last built.
 *
 * The English chrome here is not a language-neutrality regression: that rule
 * governs *generated* pages, whose every string comes from tenant data. This is
 * operator tooling, and it has no tenant.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "StaticForge — Dashboard",
  robots: { index: false, follow: false },
};

export default async function DashboardPage(): Promise<ReactElement> {
  const reachable = await isDatabaseReachable(prisma);

  if (reachable) {
    // A job row outlives the process that was updating it, so a restart can
    // leave one saying RUNNING that nothing will ever finish. Closing those out
    // keeps a poller from waiting forever.
    //
    // Scoped to this instance's own leftovers and to claims that have lapsed —
    // never to "everything still RUNNING". A second instance is doing real work
    // under exactly that description, and for every tenant at once.
    await failOrphanedJobs(prisma, { instanceId: instanceId() });
  }

  const projects = reachable ? await listProjectsForUser(LOCAL_OPERATOR_ID, prisma) : [];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="text-sm text-neutral-500">
          Read-only view of the engine&apos;s data. Generation and builds run as
          host commands; nothing here writes to the database.
        </p>
      </header>

      {!isDashboardEnabled() && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          Control endpoints are disabled. They run build commands on this
          machine and ship no authentication, so they are opt-in: start the dev
          server with <code>{DASHBOARD_ENV_VAR}=local</code> to enable them.
        </p>
      )}

      {!reachable ? (
        <p className="rounded-md border border-neutral-200 p-6 text-sm text-neutral-500 dark:border-neutral-800">
          No database reachable. Set <code>DATABASE_URL</code> to browse cloud
          projects — the engine also runs entirely from <code>data/input</code>,
          which needs no database at all.
        </p>
      ) : projects.length === 0 ? (
        <p className="rounded-md border border-neutral-200 p-6 text-sm text-neutral-500 dark:border-neutral-800">
          No projects yet. Seed one with{" "}
          <code>corepack pnpm --filter @staticforge/database db:seed</code>.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="py-2 pr-4 font-medium">Project</th>
                <th className="py-2 pr-4 font-medium">Workspace</th>
                <th className="py-2 pr-4 font-medium">Business</th>
                <th className="py-2 pr-4 font-medium">Template</th>
                <th className="py-2 pr-4 font-medium">Profile</th>
                <th className="py-2 pr-4 text-right font-medium">Services</th>
                <th className="py-2 pr-4 text-right font-medium">Cities</th>
                <th className="py-2 text-right font-medium">Pages</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
              {projects.map((project) => (
                <tr key={project.id}>
                  <td className="py-3 pr-4">
                    <Link
                      href={`/dashboard/projects/${project.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {project.name}
                    </Link>
                    <span className="block text-xs text-neutral-500">
                      {project.id}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-neutral-500">
                    {project.workspaceName}
                  </td>
                  <td className="py-3 pr-4 text-neutral-500">
                    {project.businessName ?? "—"}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs">
                    {project.templateId}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs">
                    {project.contentProfileId}
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">
                    {project.serviceCount}
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums">
                    {project.locationCount}
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {project.pageCount}
                    {project.pageCount !== project.expectedPages && (
                      // The grid says how many pages *should* exist; a mismatch
                      // means the project has not been generated since it
                      // changed.
                      <span className="text-neutral-500">
                        {" "}
                        / {project.expectedPages}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
