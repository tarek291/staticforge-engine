import type { ReactElement } from "react";
import { Suspense } from "react";

import { LoginForm } from "./login-form";

/**
 * The sign-in page.
 *
 * The last missing piece of an authentication stack that has otherwise been
 * built for five phases. Phase 30 wired sessions, cookies, middleware and a
 * login *route*; the middleware has been redirecting `/dashboard` here ever
 * since, to a 404. Everything behind this form was already working and had
 * never been used by a person.
 *
 * ## Why the page is a Server Component and the form is not
 *
 * The form needs state — a pending flag, an error, two controlled inputs — so
 * it is a Client Component. This wrapper is not, which keeps the page itself
 * out of the client bundle and lets the metadata below be static.
 *
 * The `Suspense` boundary is not decorative: `useSearchParams` opts a component
 * into client-side rendering, and without a boundary Next refuses to
 * prerender the route at build time. The fallback is the form's own frame, so
 * the page does not visibly reflow when it hydrates.
 */
export const metadata = {
  title: "Sign in — StaticForge",
  // Never indexed. A sign-in page in a search result is a phishing target with
  // a head start, and there is nothing here worth ranking.
  robots: { index: false, follow: false },
};

export default function LoginPage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-sm flex-col justify-center gap-8 px-4 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-neutral-500">
          Your session is held in a cookie the page itself cannot read.
        </p>
      </header>

      <Suspense
        fallback={
          <div
            className="h-64 rounded-md border border-neutral-200 dark:border-neutral-800"
            aria-hidden="true"
          />
        }
      >
        <LoginForm />
      </Suspense>
    </main>
  );
}
