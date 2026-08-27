import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactElement } from "react";

import { ControlPanel } from "../../_components/ControlPanel";
import { isDashboardEnabled } from "@/lib/dashboard/guard";
import { getProjectDetail, isDatabaseReachable } from "@/lib/dashboard/queries";

/** One project: its entities, its pages, and the two buttons that rebuild it. */
export const dynamic = "force-dynamic";

export const metadata = {
  robots: { index: false, follow: false },
};

interface Props {
  params: Promise<{ id: string }>;
}

/** A small labelled figure. */
function Stat({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
      <span className="text-xs uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

export default async function ProjectPage({ params }: Props): Promise<ReactElement> {
  const { id } = await params;

  if (!(await isDatabaseReachable())) {
    notFound();
  }

  const project = await getProjectDetail(id);

  if (project === null) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <Link
          href="/dashboard"
          className="text-sm text-neutral-500 underline underline-offset-4"
        >
          Projects
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <p className="text-sm text-neutral-500">
          {project.workspaceName}
          {project.businessName !== null && ` · ${project.businessName}`} ·{" "}
          <code>{project.id}</code>
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Locale" value={project.locale} />
        <Stat label="Template" value={project.templateId} />
        <Stat label="Content profile" value={project.contentProfileId} />
        <Stat
          label="Pages"
          value={
            project.pageCount === project.expectedPages
              ? String(project.pageCount)
              : `${project.pageCount} of ${project.expectedPages}`
          }
        />
      </div>

      {isDashboardEnabled() ? (
        <ControlPanel projectId={project.id} locale={project.locale} />
      ) : (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          Controls disabled. Run the equivalent by hand:{" "}
          <code>
            corepack pnpm staticforge build --project-id {project.id}
          </code>
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Services ({project.serviceCount})</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {project.services.map((service) => (
            <li
              key={service.id}
              className="flex items-baseline justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
            >
              <span>{service.name}</span>
              <span className="font-mono text-xs text-neutral-500">
                {service.slug}
                {service.templateId !== null && ` · ${service.templateId}`}
                {service.contentProfileId !== null &&
                  ` · ${service.contentProfileId}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Cities ({project.locationCount})</h2>
        <ul className="flex flex-wrap gap-2">
          {project.locations.map((location) => (
            <li
              key={location.id}
              className="rounded-md border border-neutral-200 px-3 py-1 text-sm dark:border-neutral-800"
            >
              {location.city}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Generated pages ({project.pages.length})
        </h2>

        {project.pages.length === 0 ? (
          <p className="rounded-md border border-neutral-200 p-6 text-sm text-neutral-500 dark:border-neutral-800">
            Nothing generated yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
                <tr>
                  <th className="py-2 pr-4 font-medium">Slug</th>
                  <th className="py-2 pr-4 font-medium">Title</th>
                  <th className="py-2 pr-4 font-medium">Template</th>
                  <th className="py-2 pr-4 font-medium">Profile</th>
                  <th className="py-2 pr-4 font-medium">Source</th>
                  <th className="py-2 pr-4 text-right font-medium">Links</th>
                  <th className="py-2 font-medium">Preview</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900">
                {project.pages.map((page) => (
                  <tr key={page.slug}>
                    <td className="py-2 pr-4 font-mono text-xs">{page.slug}</td>
                    <td className="py-2 pr-4">{page.title}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {page.templateId}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {page.contentProfileId}
                    </td>
                    <td className="py-2 pr-4 text-xs text-neutral-500">
                      {page.source}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {page.linkCount}
                    </td>
                    <td className="py-2">
                      {/* The canonical route, then the same page forced through
                          each registered template. The preview routes are
                          noindex and exist for exactly this comparison. */}
                      <span className="flex gap-3 text-xs">
                        <Link
                          href={`/${page.slug}`}
                          className="underline underline-offset-4"
                        >
                          live
                        </Link>
                        <Link
                          href={`/preview/default/${page.slug}`}
                          className="underline underline-offset-4 text-neutral-500"
                        >
                          default
                        </Link>
                        <Link
                          href={`/preview/luxuryLanding/${page.slug}`}
                          className="underline underline-offset-4 text-neutral-500"
                        >
                          luxury
                        </Link>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
