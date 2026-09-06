"use client";

import { useEffect, useState, type ReactElement } from "react";

/**
 * The signed-in project list.
 *
 * ## Why this is fetched from the browser rather than rendered on the server
 *
 * A Server Component could read the cookie and query Prisma directly, and that
 * is one query faster. It would also be a *second* authorisation path: the
 * route already resolves the principal, checks membership and scopes the read,
 * and a page doing its own version is the place those two quietly diverge —
 * usually when a rule changes in one of them.
 *
 * So the page asks the same endpoint an API key would. One door, one set of
 * rules, and the thing the dashboard exercises is the thing integrations use.
 *
 * The cost is a flash of loading state, which is the right price for not
 * maintaining two answers to "may this person see this project".
 */

/** A project, as the dashboard endpoint returns one. */
interface DashboardProject {
  id: string;
  name: string;
  slug: string;
  locale: string;
  workspaceName: string;
  serviceCount: number;
  locationCount: number;
  pageCount: number;
  /** Services times locations — what a full run would produce. */
  expectedPages: number;
}

/** Who the API resolved this browser as. */
interface Principal {
  kind: string;
  label: string;
}

type Load =
  | { state: "loading" }
  | { state: "ready"; projects: DashboardProject[]; principal: Principal | null }
  | { state: "unauthenticated" }
  | { state: "error"; message: string };

export function ProjectsList(): ReactElement {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    // Aborted on unmount, so a navigation away mid-flight does not resolve into
    // a component that no longer exists.
    const controller = new AbortController();

    async function run(): Promise<void> {
      try {
        const response = await fetch("/api/dashboard/projects", {
          credentials: "same-origin",
          signal: controller.signal,
        });

        if (response.status === 401) {
          // Not an error to render as one. The session expired or was never
          // established, and the useful thing is a way back to sign in.
          setLoad({ state: "unauthenticated" });

          return;
        }

        if (!response.ok) {
          setLoad({
            state: "error",
            message: `The projects endpoint answered ${String(response.status)}.`,
          });

          return;
        }

        const body = (await response.json()) as {
          projects?: DashboardProject[];
          principal?: Principal;
        };

        setLoad({
          state: "ready",
          projects: body.projects ?? [],
          principal: body.principal ?? null,
        });
      } catch (error: unknown) {
        if (controller.signal.aborted) {
          return;
        }

        setLoad({
          state: "error",
          message:
            error instanceof Error ? error.message : "Could not reach the server.",
        });
      }
    }

    void run();

    return () => {
      controller.abort();
    };
  }, []);

  if (load.state === "loading") {
    return (
      <p className="text-sm text-neutral-500" aria-live="polite">
        Loading projects…
      </p>
    );
  }

  if (load.state === "unauthenticated") {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-6 text-sm dark:border-neutral-800">
        <p className="text-neutral-600 dark:text-neutral-300">
          This session is not signed in.
        </p>
        <a
          href="/login?next=%2Fdashboard"
          className="w-fit rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900"
        >
          Sign in
        </a>
      </div>
    );
  }

  if (load.state === "error") {
    return (
      <p
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      >
        {load.message}
      </p>
    );
  }

  if (load.projects.length === 0) {
    // An empty list and a failed read look identical if both render nothing,
    // and only one of them means "you have no projects".
    return (
      <p className="rounded-md border border-neutral-200 p-6 text-sm text-neutral-500 dark:border-neutral-800">
        No projects in any organization you belong to.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {load.principal !== null && (
        // Shown because an empty list has two causes that look identical — no
        // projects, or signed in as somebody else — and only one of them is
        // fixed by signing in again.
        <p className="text-xs text-neutral-500">
          Acting as <span className="font-mono">{load.principal.label}</span> (
          {load.principal.kind})
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {load.projects.map((project) => (
          <li
            key={project.id}
            className="rounded-md border border-neutral-200 dark:border-neutral-800"
          >
            <a
              href={`/dashboard/projects/${project.id}`}
              className="flex flex-col gap-1 p-4 text-sm"
            >
              <span className="font-medium">{project.name}</span>
              <span className="font-mono text-xs text-neutral-500">
                {project.workspaceName} / {project.slug} · {project.locale}
              </span>
              <span className="text-xs text-neutral-500">
                {project.pageCount} page{project.pageCount === 1 ? "" : "s"} from{" "}
                {project.serviceCount} service
                {project.serviceCount === 1 ? "" : "s"} × {project.locationCount}{" "}
                location{project.locationCount === 1 ? "" : "s"}
                {project.pageCount !== project.expectedPages &&
                  ` · ${project.expectedPages} expected`}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
