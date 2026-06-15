import type { ReactElement } from "react";
import type { GeneratedPage } from "@staticforge/schemas";

/**
 * Inactive alternate template (`templateId: "luxuryLanding"`).
 *
 * A deliberately minimal, distinct skeleton rendered purely from page data.
 * Currently unused — no generated page selects this template yet. Kept as a
 * plain synchronous Server Component (no data loading, no client behavior).
 */
export function LuxuryLandingView({
  page,
}: {
  page: GeneratedPage;
}): ReactElement {
  const { content } = page;
  const introText = page.content.hero.subheading ?? page.metaDescription;
  const jsonLd = JSON.stringify(page.schemaOrg).replace(/</g, "\\u003c");

  return (
    <main
      lang={page.locale}
      className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-6 py-20"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />

      <header className="flex flex-col gap-3 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          {page.h1}
        </h1>
        <p className="text-lg text-neutral-500 dark:text-neutral-400">
          {introText}
        </p>
      </header>

      {content.sections.length > 0 && (
        <div className="flex flex-col gap-6">
          {content.sections.map((section, index) => (
            <section key={index} className="flex flex-col gap-2">
              <h2 className="text-2xl font-semibold">{section.heading}</h2>
              <p className="text-neutral-600 dark:text-neutral-300">
                {section.body}
              </p>
            </section>
          ))}
        </div>
      )}

      {content.faq.length > 0 && (
        <dl className="flex flex-col gap-4">
          {content.faq.map((item, index) => (
            <div key={index} className="flex flex-col gap-1">
              <dt className="font-semibold">{item.question}</dt>
              <dd className="text-neutral-600 dark:text-neutral-300">
                {item.answer}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <section className="flex flex-col items-center gap-3 text-center">
        <h2 className="text-2xl font-semibold">{content.cta.heading}</h2>
        <a
          href={content.cta.href}
          className="rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white dark:bg-white dark:text-neutral-900"
        >
          {content.cta.buttonLabel}
        </a>
      </section>
    </main>
  );
}
