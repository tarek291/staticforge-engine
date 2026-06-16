import type { ReactElement } from "react";
import type { GeneratedPage } from "@staticforge/schemas";
import Link from "next/link";

interface GeneratedPageViewProps {
  page: GeneratedPage;
}

export function GeneratedPageView({
  page,
}: GeneratedPageViewProps): ReactElement {
  const { content } = page;

  // Prefer the dedicated visible hero subheading; fall back to the meta text.
  const introText = page.content.hero.subheading ?? page.metaDescription;

  // Serialize the validated structured-data object to JSON-LD, escaping "<"
  // to prevent the closing-tag/script-injection edge case.
  const jsonLd = page.schemaOrg
    ? JSON.stringify(page.schemaOrg).replace(/</g, "\\u003c")
    : null;

  return (
    <main
      lang={page.locale}
      className="mx-auto flex min-h-screen max-w-2xl flex-col gap-12 px-6 py-16"
    >
      {jsonLd ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLd }}
        />
      ) : null}

      <nav>
        <Link
          href="/"
          className="text-sm text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
        >
          ← Back
        </Link>
      </nav>

      <header className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {page.h1}
        </h1>
        <p className="text-lg text-neutral-500 dark:text-neutral-400">
          {introText}
        </p>
      </header>

      {content.sections.length > 0 && (
        <div className="flex flex-col gap-8">
          {content.sections.map((section, index) => (
            <section key={index} className="flex flex-col gap-2">
              <h2 className="text-xl font-medium">{section.heading}</h2>
              <p className="leading-relaxed text-neutral-600 dark:text-neutral-300">
                {section.body}
              </p>
            </section>
          ))}
        </div>
      )}

      {content.faq.length > 0 && (
        <section className="flex flex-col gap-6">
          <dl className="flex flex-col gap-5">
            {content.faq.map((item, index) => (
              <div key={index} className="flex flex-col gap-1">
                <dt className="font-medium">{item.question}</dt>
                <dd className="text-neutral-600 dark:text-neutral-300">
                  {item.answer}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section
        id="contact"
        className="flex flex-col items-start gap-4 rounded-lg border border-neutral-200 p-6 dark:border-neutral-800"
      >
        <h2 className="text-lg font-medium">{content.cta.heading}</h2>
        <a
          href={content.cta.href}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
        >
          {content.cta.buttonLabel}
        </a>
      </section>
    </main>
  );
}
