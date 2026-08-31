import type { ReactElement } from "react";

import { isDatabaseReachable, prisma } from "@staticforge/database";

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
 * Removing the constant leaves this page with no way to know who is asking. A
 * server component receives no `Authorization` header, and there is no session
 * cookie yet — Phase 27 verifies a bearer token, and nothing has been built to
 * turn a browser session into one. So the page stops pretending, and points at
 * the endpoint that does authenticate.
 *
 * That is a real loss of function and it is the correct trade. The alternative
 * was keeping an unauthenticated read of tenant data because it was convenient,
 * which is the shape of every "temporary" hole that ships.
 *
 * The next step is a session cookie and a client-side fetch against
 * `GET /api/dashboard/projects`, which already enforces exactly this.
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
          This view is not signed in. Project data is tenant data, and the web
          server no longer reads it without a credential.
        </p>
      </header>

      <div className="flex flex-col gap-4 rounded-md border border-neutral-200 p-6 text-sm dark:border-neutral-800">
        <p className="text-neutral-600 dark:text-neutral-300">
          Every project listing goes through the authenticated API. Ask it with
          a Supabase session token, or with an organization API key:
        </p>

        <pre className="overflow-x-auto rounded bg-neutral-100 p-4 font-mono text-xs dark:bg-neutral-900">
          {`curl -H "Authorization: Bearer <token-or-sf_org_key>" \\
  http://localhost:3000/api/dashboard/projects`}
        </pre>

        <p className="text-neutral-500">
          Mint a key with{" "}
          <code>
            corepack pnpm staticforge api-keys create --org-id &lt;id&gt; --name
            &quot;local&quot;
          </code>
          .
        </p>
      </div>

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
