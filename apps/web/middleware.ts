import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
// Imported from the subpath, not the package root. Middleware runs on the Edge
// runtime, and the root barrel re-exports modules that reach for `node:crypto`
// — the API-key hashing among them — which the Edge runtime cannot load. The
// rule this file needs is pure and has no imports at all, so it is exposed on
// its own entry point rather than dragged in behind everything else.
import { LOGIN_PATH, decidePageAccess } from "@staticforge/core/auth-paths";

import { ServerEnvError, readServerEnv } from "@/lib/env";

/**
 * Page-level session handling.
 *
 * Two jobs, and the second is the one that is easy to lose. It decides whether
 * a browser may see a `/dashboard` page — and it *refreshes the session cookie*
 * on every request, which is what stops a working login expiring after an hour
 * because nothing ever rotated its token.
 *
 * ## Why the response object is threaded through
 *
 * `createServerClient` writes rotated cookies through `setAll`, and those
 * writes have to land on the response that is actually returned. Building a
 * fresh `NextResponse` afterwards — the obvious tidy-up — silently drops them,
 * and the symptom is users being logged out at seemingly random intervals with
 * nothing in any log. So the response is created first, mutated in place, and
 * returned; every early return copies its cookies across.
 *
 * ## What this is not
 *
 * It is not the API's protection. Every route under `/api` authenticates itself
 * (Phase 29) and refuses an unauthenticated call whatever happens here. This
 * only decides where to send a *browser*, and it deliberately does not run on
 * `/api` at all: an integration should get a `401` it can act on, not a `302`
 * to a sign-in page it cannot use.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Everything below costs a network call to the auth server. Paths that are
  // not protected do not need one.
  if (!decidePageAccess(pathname, true).redirect && !isProtected(pathname)) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  let env;

  try {
    env = readServerEnv();
  } catch (error: unknown) {
    if (error instanceof ServerEnvError) {
      // No identity provider configured. Nobody can be signed in, so nobody may
      // see a protected page — refused rather than waved through, because the
      // safe reading of "we cannot check" is "no".
      // eslint-disable-next-line no-console
      console.error(`[middleware] ${error.message}`);

      return redirectToLogin(request, pathname, response);
    }

    throw error;
  }

  const supabase = createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        // Rebuilt so the *request* carries the refreshed cookie onward to the
        // route, then the same values are set on the response so the browser
        // gets them too. Both halves are needed: one keeps this request
        // working, the other keeps the next one working.
        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // `getUser`, never `getSession`. The latter decodes the cookie the client
  // sent; only this one asks the auth server whether it is real. A page guard
  // built on a decode is a page guard an attacker writes their own cookie for.
  const { data, error } = await supabase.auth.getUser();
  const decision = decidePageAccess(pathname, error === null && data.user !== null);

  if (decision.redirect) {
    return redirectToLogin(request, pathname, response);
  }

  return response;
}

/** Whether this path is one the guard covers. */
function isProtected(pathname: string): boolean {
  return decidePageAccess(pathname, false).redirect;
}

/**
 * Send the browser to sign in, keeping any cookies the refresh produced.
 *
 * The cookies matter even on a redirect: a session that was rotated during this
 * request must reach the browser, or the very next request presents the stale
 * token and is bounced again — a redirect loop that looks like a broken login.
 */
function redirectToLogin(
  request: NextRequest,
  pathname: string,
  carrying: NextResponse,
): NextResponse {
  const decision = decidePageAccess(pathname, false);
  const url = request.nextUrl.clone();
  const [path, query] = (decision.location ?? LOGIN_PATH).split("?");

  url.pathname = path ?? LOGIN_PATH;
  url.search = query === undefined ? "" : `?${query}`;

  const redirect = NextResponse.redirect(url);

  for (const cookie of carrying.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }

  return redirect;
}

export const config = {
  /**
   * Everything except static assets, image optimisation, the favicon — and
   * `/api`.
   *
   * `/api` is excluded deliberately. Those routes authenticate themselves and
   * answer `401`; running a page guard in front of them would turn an
   * integration's clear refusal into a `302` toward an HTML sign-in form, which
   * is the least actionable thing a machine client can receive.
   */
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
