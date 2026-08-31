import Link from "next/link";
import type { ReactElement } from "react";

/**
 * One project's detail view.
 *
 * ## Why this page renders no project
 *
 * The same reason the index does not list them. It read the project as
 * `LOCAL_OPERATOR_ID` — a constant standing in for an identity — and a server
 * component has no `Authorization` header to replace it with. There is no
 * session cookie yet: Phase 27 verifies a bearer token, and nothing turns a
 * browser session into one.
 *
 * The control buttons went with it, and they were the more dangerous half. They
 * queued generation runs — paid AI work, against a tenant's quota — from a page
 * that could not say who was clicking. `POST /api/dashboard/jobs` now
 * authenticates, checks the role and checks the quota; a button that calls it
 * without a credential would simply be refused, so shipping one that *looks*
 * functional would be worse than shipping none.
 *
 * The next step is a session cookie and a client-side view over the
 * authenticated API, which already enforces all of this.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ProjectPage({ params }: Props): Promise<ReactElement> {
  const { id } = await params;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <Link
          href="/dashboard"
          className="text-sm text-neutral-500 underline underline-offset-4"
        >
          Projects
        </Link>
        <h1 className="font-mono text-xl font-semibold tracking-tight">{id}</h1>
        <p className="text-sm text-neutral-500">
          This view is not signed in. A project belongs to an organization, and
          the web server no longer reads one without a credential.
        </p>
      </header>

      <div className="flex flex-col gap-4 rounded-md border border-neutral-200 p-6 text-sm dark:border-neutral-800">
        <p className="text-neutral-600 dark:text-neutral-300">
          Read it through the authenticated API instead:
        </p>

        <pre className="overflow-x-auto rounded bg-neutral-100 p-4 font-mono text-xs dark:bg-neutral-900">
          {`curl -H "Authorization: Bearer <token-or-sf_org_key>" \\
  http://localhost:3000/api/dashboard/projects`}
        </pre>

        <p className="text-neutral-500">
          Generation runs are queued the same way, with{" "}
          <code>POST /api/dashboard/jobs</code> — which checks the caller&apos;s
          role and the organization&apos;s quota before it writes a row. Or run
          the engine directly:{" "}
          <code>corepack pnpm staticforge build --project-id {id}</code>.
        </p>
      </div>
    </div>
  );
}
