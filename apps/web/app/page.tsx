import type { ReactElement } from "react";
import Link from "next/link";
import { getOutputManifest } from "@/lib/staticforge-output";

export default async function HomePage(): Promise<ReactElement> {
  const manifest = await getOutputManifest();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8 text-center">
      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          StaticForge Engine MVP
        </h1>
        <p className="max-w-md text-lg text-neutral-500 dark:text-neutral-400">
          Generated static SEO pages from structured data.
        </p>
      </div>

      <section className="w-full max-w-md rounded-lg border border-neutral-200 p-6 text-left text-sm dark:border-neutral-800">
        {manifest === null ? (
          <p className="text-neutral-500 dark:text-neutral-400">
            No generated output found yet.
          </p>
        ) : (
          <dl className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-neutral-500 dark:text-neutral-400">
                Generated pages
              </dt>
              <dd className="font-medium tabular-nums">{manifest.count}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-neutral-500 dark:text-neutral-400">
                Output source
              </dt>
              <dd className="font-mono text-xs">manifest.json</dd>
            </div>
            {manifest.pages.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-neutral-200 pt-3 dark:border-neutral-800">
                <dt className="text-neutral-500 dark:text-neutral-400">
                  Sample slugs
                </dt>
                <dd>
                  <ul className="flex flex-col gap-1 font-mono text-xs">
                    {manifest.pages.slice(0, 3).map((page) => (
                      <li key={page.slug}>
                        <Link
                          href={`/${page.slug}`}
                          className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                        >
                          {page.slug}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        )}
      </section>
    </main>
  );
}
