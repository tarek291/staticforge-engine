"use client";

import { safeReturnPath } from "@staticforge/core/auth-paths";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent, type ReactElement } from "react";

/**
 * The sign-in form.
 *
 * ## What it deliberately does not do
 *
 * It does not touch Supabase. The browser never sees the project URL or the
 * anon key, never holds a token, and never decides whether a password was
 * right — it posts to `/api/auth/login` and reads a status code. The tokens go
 * to that route's SSR client, whose adapter writes them as `HttpOnly` cookies,
 * so a cross-site script cannot read the session it establishes.
 *
 * The obvious alternative — `createBrowserClient` and `signInWithPassword` in
 * the page — is what most examples show and it puts the access token in
 * JavaScript's reach. That trades the one protection `HttpOnly` buys for the
 * convenience of not writing a route that already exists.
 *
 * ## Why every failure says the same thing
 *
 * A wrong password and an unknown address get one message, because two would
 * make this a way to find out which of a customer's addresses are real — the
 * first half of a credential-stuffing run. The server already answers both with
 * `401`; this must not undo that by rendering them differently.
 *
 * `429` and `500` *are* distinguished, and that is not an inconsistency: one
 * says "wait", the other says "this is not your fault". Neither reveals whether
 * an account exists.
 */

/** Where a successful sign-in lands when nothing else was asked for. */
const DEFAULT_DESTINATION = "/dashboard";

/** What the user is told, per status. Never more specific than the server was. */
function messageFor(status: number): string {
  switch (status) {
    case 400:
      return "Enter an email address and a password.";
    case 401:
      // One answer for a wrong password, an unknown address, an unconfirmed
      // account and a locked one.
      return "Those credentials were not accepted.";
    case 429:
      return "Too many attempts from here. Wait a moment and try again.";
    case 500:
      return "Sign-in is not configured on this server. Contact the operator.";
    default:
      return "Sign-in failed. Try again.";
  }
}

export function LoginForm(): ReactElement {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Validated, not trusted. `?next=` is attacker-controllable — the middleware
  // puts a path there, and anybody can type a URL — so a full URL, a
  // protocol-relative `//evil.com`, or a `/\evil.com` is discarded rather than
  // followed. "Sign in here, then we will send you on" is a phishing flow that
  // looks exactly like a working one.
  //
  // The same function the middleware uses, imported from the subpath rather
  // than the package root: the root barrel reaches for `node:crypto`, which has
  // no business in a browser bundle.
  const destination = safeReturnPath(params.get("next")) ?? DEFAULT_DESTINATION;

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
        // The response's `Set-Cookie` has to be honoured, and the request has
        // to carry any cookie already held. Same-origin is the default, and it
        // is stated rather than assumed because the whole mechanism is cookies.
        credentials: "same-origin",
      });

      if (!response.ok) {
        setError(messageFor(response.status));
        setPending(false);

        return;
      }

      // A full navigation rather than a client-side route change. The session
      // cookie was set on *this* response, and the middleware that guards
      // `/dashboard` reads cookies on the server — a soft navigation can reach
      // it before the browser has committed the new cookie, which bounces
      // straight back here and looks like a login that silently failed.
      //
      // `assign`, not `replace`: the sign-in page stays in history, so a person
      // who lands somewhere unexpected can go back.
      window.location.assign(destination);
    } catch {
      // A network failure, not a refusal. Saying "credentials not accepted"
      // here would send somebody to reset a password over a dropped connection.
      setError("Could not reach the server. Check your connection and retry.");
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-4 rounded-md border border-neutral-200 p-6 dark:border-neutral-800"
      noValidate
    >
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Email</span>
        <input
          type="email"
          name="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          // The browser's own hints. `username` is what a password manager
          // needs to offer the right credential, and getting it wrong is the
          // difference between autofill working and a person typing.
          autoComplete="username"
          autoFocus
          disabled={pending}
          className="rounded border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Password</span>
        <input
          type="password"
          name="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          autoComplete="current-password"
          disabled={pending}
          className="rounded border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      {error !== null && (
        // `role="alert"` so a screen reader announces the refusal. A visual-only
        // error is a form that silently does nothing for anyone not looking at
        // that part of the page.
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>

      <p className="text-xs text-neutral-500">
        Accounts are created in Supabase, not here. There is deliberately no
        sign-up form: this dashboard administers tenants that already exist.
      </p>
    </form>
  );
}
