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
  const diagnosis = reachable ? null : diagnoseDatabase();

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

      {diagnosis !== null && (
        <div className="flex flex-col gap-2 rounded-md border border-neutral-200 p-6 text-sm text-neutral-500 dark:border-neutral-800">
          <p className="font-medium text-neutral-700 dark:text-neutral-200">
            {diagnosis.headline}
          </p>
          <p>{diagnosis.detail}</p>
        </div>
      )}
    </div>
  );
}

/** What to tell somebody staring at a dashboard with no data. */
interface DatabaseDiagnosis {
  headline: string;
  detail: string;
}

/**
 * Say which of the two problems this is.
 *
 * "No database reachable. Set `DATABASE_URL`" was one message for two
 * situations, and it gave the wrong advice in the one that actually happened:
 * the variable *was* set, and telling somebody to set it sends them to check a
 * field that is already correct.
 *
 * The distinction that matters is unset versus unreachable, and the most common
 * cause of unreachable here is specific enough to name. Supabase's direct host —
 * `db.<ref>.supabase.co` — publishes **no A record**, only AAAA. Vercel's
 * serverless functions have no IPv6 outbound, so that host is not merely slow
 * from there, it is unresolvable. The connection pooler is the IPv4 route and
 * the one a serverless deployment has to use.
 *
 * Only reachable behind the middleware, so this is shown to somebody signed in.
 * It reports the *shape* of the host and never the credential.
 */
function diagnoseDatabase(): DatabaseDiagnosis {
  const url = process.env["DATABASE_URL"];

  if (url === undefined || url.trim() === "") {
    return {
      headline: "DATABASE_URL is not set.",
      detail:
        "Set it to browse cloud projects. The engine also runs entirely from " +
        "data/input, which needs no database at all.",
    };
  }

  // Parsed rather than pattern-matched, so a malformed value is reported as
  // malformed instead of silently failing the host test below.
  let host: string;

  try {
    host = new URL(url).hostname;
  } catch {
    return {
      headline: "DATABASE_URL is set but is not a valid URL.",
      detail:
        "Prisma could not parse it. Check for an unencoded character in the " +
        "password — a bare ? or # ends the authority and leaves no host.",
    };
  }

  if (host.startsWith("db.") && host.endsWith(".supabase.co")) {
    return {
      headline: "DATABASE_URL is set, but this host cannot be reached from here.",
      detail:
        `Supabase's direct host (${host}) publishes no IPv4 address, and ` +
        "serverless functions have no IPv6 outbound — so it is unresolvable " +
        "rather than slow. Use the connection pooler URL instead: Supabase → " +
        "Project Settings → Database → Connection string → Transaction pooler.",
    };
  }

  return {
    headline: "DATABASE_URL is set, but the database did not answer.",
    detail:
      `The host is ${host}. Check that it accepts connections from this ` +
      "deployment, and that the credential and database name are right.",
  };
}
