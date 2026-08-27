import type { CSSProperties, ReactElement } from "react";
import type { GeneratedPage } from "@staticforge/schemas";

/**
 * Alternate template (`templateId: "luxuryLanding"`) — a dark, high-ticket
 * landing page rendered purely from page data.
 *
 * Server Component by construction: no `"use client"`, no hooks, no data
 * loading, no route access. Entrance animations are pure CSS keyframes
 * (see `tailwind.config.ts`), so nothing here ships JavaScript, and every one
 * of them is disabled under `prefers-reduced-motion`.
 *
 * Language-agnostic: every visible string comes from `page`. No human-language
 * text is hardcoded — section and FAQ markers are numerals, which read the same
 * in any locale.
 */

/** Stagger helper — successive blocks fade up slightly later. */
function delay(index: number, step = 90, base = 0): CSSProperties {
  return { animationDelay: `${base + index * step}ms` };
}

/** Two-digit ordinal marker (01, 02, …). Locale-neutral. */
function ordinal(index: number): string {
  return String(index + 1).padStart(2, "0");
}

export function LuxuryLandingView({
  page,
}: {
  page: GeneratedPage;
}): ReactElement {
  const { content } = page;
  const introText = content.hero.subheading ?? page.metaDescription;
  const jsonLd = JSON.stringify(page.schemaOrg).replace(/</g, "\\u003c");

  return (
    <main
      lang={page.locale}
      className="relative isolate min-h-screen overflow-hidden bg-zinc-950 text-zinc-100 antialiased selection:bg-amber-200/20 selection:text-amber-100"
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />

      {/* Ambient depth: a warm halo behind the hero and a cool one lower down.
          Decorative only — never in the accessibility tree. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 animate-fade-in motion-reduce:animate-none"
      >
        <div className="absolute left-1/2 top-[-18rem] h-[36rem] w-[52rem] -translate-x-1/2 rounded-full bg-amber-500/[0.07] blur-[130px]" />
        <div className="absolute left-[-10rem] top-[40rem] h-[30rem] w-[30rem] rounded-full bg-zinc-500/[0.06] blur-[120px]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-200/25 to-transparent" />
      </div>

      <div className="mx-auto flex max-w-4xl flex-col px-6 py-24 sm:px-8 sm:py-32">
        {/* ---------- Hero ---------- */}
        <header className="flex animate-fade-up flex-col items-center gap-7 text-center motion-reduce:animate-none">
          <span
            aria-hidden="true"
            className="h-px w-16 bg-gradient-to-r from-transparent via-amber-200/60 to-transparent"
          />

          <h1 className="text-balance bg-gradient-to-b from-white via-zinc-100 to-zinc-400 bg-clip-text font-serif text-4xl font-medium leading-[1.1] tracking-tight text-transparent sm:text-6xl">
            {page.h1}
          </h1>

          <p className="max-w-2xl text-pretty text-lg leading-relaxed text-zinc-400 sm:text-xl">
            {introText}
          </p>

          <div
            className="mt-2 flex animate-fade-up flex-wrap items-center justify-center gap-3 motion-reduce:animate-none"
            style={delay(1, 120)}
          >
            <a
              href={content.cta.href}
              className="rounded-full bg-gradient-to-b from-amber-200 to-amber-400 px-8 py-3.5 text-sm font-semibold tracking-wide text-zinc-950 shadow-lg shadow-amber-500/20 transition hover:from-amber-100 hover:to-amber-300 hover:shadow-amber-400/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200"
            >
              {content.cta.buttonLabel}
            </a>
            {content.cta.secondary && (
              <a
                href={content.cta.secondary.href}
                className="rounded-full border border-white/15 bg-white/[0.04] px-8 py-3.5 text-sm font-semibold tracking-wide text-zinc-200 backdrop-blur-sm transition hover:border-amber-200/40 hover:bg-white/[0.08] hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200"
              >
                {content.cta.secondary.buttonLabel}
              </a>
            )}
          </div>
        </header>

        {/* ---------- Sections ---------- */}
        {content.sections.length > 0 && (
          <div className="mt-28 grid gap-5 sm:mt-36 sm:grid-cols-2">
            {content.sections.map((section, index) => (
              <article
                key={index}
                style={delay(index, 90, 120)}
                className="group relative animate-fade-up overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.055] to-white/[0.015] p-8 backdrop-blur-sm transition-colors duration-300 hover:border-amber-200/25 motion-reduce:animate-none"
              >
                {/* Top edge highlight — the glass "lip". */}
                <span
                  aria-hidden="true"
                  className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
                />

                <span
                  aria-hidden="true"
                  className="font-mono text-xs tracking-[0.3em] text-amber-200/50 transition-colors duration-300 group-hover:text-amber-200/80"
                >
                  {ordinal(index)}
                </span>

                <h2 className="mt-5 text-balance font-serif text-2xl font-medium leading-snug tracking-tight text-zinc-50">
                  {section.heading}
                </h2>

                <p className="mt-3 text-pretty leading-relaxed text-zinc-400">
                  {section.body}
                </p>
              </article>
            ))}
          </div>
        )}

        {/* ---------- FAQ ---------- */}
        {content.faq.length > 0 && (
          <section
            style={delay(0, 90, 160)}
            className="mt-28 animate-fade-up sm:mt-36 motion-reduce:animate-none"
          >
            <span
              aria-hidden="true"
              className="block h-px w-full bg-gradient-to-r from-transparent via-white/10 to-transparent"
            />

            <dl className="divide-y divide-white/[0.07]">
              {content.faq.map((item, index) => (
                <div
                  key={index}
                  className="grid gap-3 py-8 sm:grid-cols-[auto_1fr] sm:gap-x-8"
                >
                  <dt className="flex items-baseline gap-4 sm:contents">
                    <span
                      aria-hidden="true"
                      className="font-mono text-xs tracking-[0.3em] text-amber-200/40 sm:pt-1"
                    >
                      {ordinal(index)}
                    </span>
                    <span className="text-balance text-lg font-medium leading-snug text-zinc-100">
                      {item.question}
                    </span>
                  </dt>
                  <dd className="text-pretty leading-relaxed text-zinc-400 sm:col-start-2">
                    {item.answer}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {/* ---------- Closing CTA ---------- */}
        <section
          style={delay(0, 90, 200)}
          className="relative mt-28 animate-fade-up overflow-hidden rounded-3xl border border-white/[0.09] bg-gradient-to-b from-white/[0.07] to-white/[0.02] px-8 py-16 text-center backdrop-blur-sm sm:mt-36 sm:px-16 motion-reduce:animate-none"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-10"
          >
            <div className="absolute left-1/2 top-[-8rem] h-[22rem] w-[34rem] -translate-x-1/2 rounded-full bg-amber-400/[0.09] blur-[100px]" />
            <span className="absolute inset-x-16 top-0 h-px bg-gradient-to-r from-transparent via-amber-200/40 to-transparent" />
          </div>

          <h2 className="text-balance font-serif text-3xl font-medium leading-tight tracking-tight text-zinc-50 sm:text-4xl">
            {content.cta.heading}
          </h2>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a
              href={content.cta.href}
              className="rounded-full bg-gradient-to-b from-amber-200 to-amber-400 px-9 py-3.5 text-sm font-semibold tracking-wide text-zinc-950 shadow-lg shadow-amber-500/20 transition hover:from-amber-100 hover:to-amber-300 hover:shadow-amber-400/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200"
            >
              {content.cta.buttonLabel}
            </a>
            {content.cta.secondary && (
              <a
                href={content.cta.secondary.href}
                className="rounded-full border border-white/15 bg-white/[0.04] px-9 py-3.5 text-sm font-semibold tracking-wide text-zinc-200 backdrop-blur-sm transition hover:border-amber-200/40 hover:bg-white/[0.08] hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200"
              >
                {content.cta.secondary.buttonLabel}
              </a>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
