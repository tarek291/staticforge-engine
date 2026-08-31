import { describe, expect, test } from "vitest";

import {
  LOGIN_PATH,
  PROTECTED_PREFIXES,
  decidePageAccess,
  isProtectedPath,
  safeReturnPath,
} from "./protected-paths.js";

/**
 * The page guard's rule, separated from the middleware that applies it.
 *
 * Two failure directions and they are not equal. Failing to protect a page
 * renders a shell for nobody, which is a usability bug — every API call that
 * page would make is refused on its own. Sending a signed-in person to the
 * sign-in page is worse in practice: it is a loop, and a loop looks like a
 * broken product rather than a permissions message.
 *
 * The genuinely dangerous piece is the `next=` parameter. A redirect target a
 * caller controls is an open redirect, and "sign in here, then we will send you
 * on" is a phishing flow indistinguishable from a working one.
 */

describe("which paths need a session", () => {
  test("the dashboard does", () => {
    expect(isProtectedPath("/dashboard")).toBe(true);
    expect(isProtectedPath("/dashboard/projects")).toBe(true);
    expect(isProtectedPath("/dashboard/projects/prj_1")).toBe(true);
  });

  test("public pages do not", () => {
    expect(isProtectedPath("/")).toBe(false);
    expect(isProtectedPath("/bueroreinigung-duisburg")).toBe(false);
    expect(isProtectedPath("/preview/default/bueroreinigung-duisburg")).toBe(false);
    expect(isProtectedPath(LOGIN_PATH)).toBe(false);
  });

  test("a path that merely starts with the prefix is a different page", () => {
    // `startsWith("/dashboard")` alone matches these. Protecting them today is
    // harmless; the real cost is that the same sloppiness silently stops
    // protecting `/dashboard` the day somebody edits the prefix.
    expect(isProtectedPath("/dashboards-public")).toBe(false);
    expect(isProtectedPath("/dashboarding")).toBe(false);
  });

  test("the prefix list is what the middleware and this agree on", () => {
    expect([...PROTECTED_PREFIXES]).toEqual(["/dashboard"]);
  });
});

describe("an unauthenticated browser is redirected", () => {
  test("it is sent to the sign-in page", () => {
    const decision = decidePageAccess("/dashboard", false);

    expect(decision.redirect).toBe(true);
    expect(decision.location).toContain(LOGIN_PATH);
  });

  test("where it was going travels with it", () => {
    const decision = decidePageAccess("/dashboard/projects/prj_1", false);

    expect(decision.location).toBe(
      `${LOGIN_PATH}?next=${encodeURIComponent("/dashboard/projects/prj_1")}`,
    );
  });

  test("the destination can be left out", () => {
    expect(decidePageAccess("/dashboard", false, false).location).toBe(LOGIN_PATH);
  });

  test("only a path is carried, never a whole URL", () => {
    // The value is taken from the request's own pathname rather than from
    // anything a caller supplied, so there is nothing here to point elsewhere.
    const decision = decidePageAccess("/dashboard/x", false);

    expect(decision.location).not.toMatch(/https?:/);
    expect(decision.location).not.toContain("//");
  });
});

describe("a signed-in browser is left alone", () => {
  test("a protected page renders", () => {
    expect(decidePageAccess("/dashboard", true)).toEqual({ redirect: false });
  });

  test("a public page renders either way", () => {
    expect(decidePageAccess("/", false)).toEqual({ redirect: false });
    expect(decidePageAccess("/", true)).toEqual({ redirect: false });
  });

  test("the sign-in page itself is never redirected to itself", () => {
    // The loop this prevents is the one a user cannot escape and cannot
    // diagnose.
    expect(decidePageAccess(LOGIN_PATH, false)).toEqual({ redirect: false });
  });
});

describe("the return path cannot leave this origin", () => {
  test("an ordinary path comes back", () => {
    expect(safeReturnPath("/dashboard/projects")).toBe("/dashboard/projects");
  });

  test("a protocol-relative URL is refused", () => {
    // `//evil.com` looks like a path and is read by a browser as an absolute
    // URL. This is the open redirect, and it is one character away from the
    // safe case.
    expect(safeReturnPath("//evil.com")).toBeUndefined();
    expect(safeReturnPath("//evil.com/dashboard")).toBeUndefined();
  });

  test("a backslash form is refused too", () => {
    // Some parsers normalise `/\` to `//`. Refusing only the obvious spelling
    // is refusing half of it.
    expect(safeReturnPath("/\\evil.com")).toBeUndefined();
  });

  test("an absolute URL is refused", () => {
    expect(safeReturnPath("https://evil.com/dashboard")).toBeUndefined();
    expect(safeReturnPath("http://evil.com")).toBeUndefined();
  });

  test("anything that is not a path is refused", () => {
    for (const value of [null, undefined, "", "dashboard", "javascript:alert(1)"]) {
      expect(safeReturnPath(value)).toBeUndefined();
    }
  });
});
