import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Every API route in the web app authenticates.
 *
 * ## Why this is a test and not a convention
 *
 * The individual gates are tested where they live. What no unit test can see is
 * the route somebody adds next month that forgets to call one — it compiles, it
 * works, and it is unauthenticated. That failure is invisible to every test
 * except one that looks at the whole directory.
 *
 * So this walks `apps/web/app/**\/route.ts` and asserts that each handler
 * reaches an authentication call. It is a coarse check by nature: it reads
 * source rather than behaviour, and a route could satisfy it while using the
 * guard wrongly. It is not trying to prove correctness — it is trying to make
 * *omission* impossible, and omission is the failure that actually happens.
 *
 * Public routes are listed explicitly. A new one has to be added here by hand,
 * which is the point: making a route public becomes a visible decision in a
 * file about authentication rather than an absence nobody notices.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "../../../../apps/web/app");

/**
 * Routes that are deliberately open, and why.
 *
 * `robots.txt` and `sitemap.xml` are public by definition — a crawler cannot
 * present a credential — and neither reads tenant data: they render from the
 * static manifest the build produced, not from the database.
 *
 * `auth/login` is open because obtaining a credential is what it is for. It is
 * exempted by name rather than by a pattern like "anything under /auth", so
 * opening a second unauthenticated endpoint stays a visible edit to this list
 * rather than a route that quietly matched a rule.
 */
const PUBLIC_ROUTES = new Set([
  "robots.txt/route.ts",
  "sitemap.xml/route.ts",
  "api/auth/login/route.ts",
]);

/** Calls that count as authenticating. */
const AUTH_CALLS = ["requireApiAuth", "authorizeProjectAccess", "authenticateRequest"];

/** Every `route.ts` under the app directory, relative to it. */
function findRoutes(dir: string, base = dir): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      found.push(...findRoutes(full, base));
    } else if (entry === "route.ts" || entry === "route.tsx") {
      found.push(relative(base, full).split("\\").join("/"));
    }
  }

  return found;
}

const ROUTES = findRoutes(APP_DIR);

describe("every API route authenticates", () => {
  test("the app has routes to check, so a broken path cannot pass silently", () => {
    // Without this, a wrong `APP_DIR` would make every assertion below vacuous
    // and the suite would go green while checking nothing.
    expect(ROUTES.length).toBeGreaterThan(4);
  });

  test.each(ROUTES.filter((route) => !PUBLIC_ROUTES.has(route)))(
    "%s calls an authentication guard",
    (route) => {
      const source = readFileSync(join(APP_DIR, route), "utf8");

      expect(AUTH_CALLS.some((call) => source.includes(`${call}(`))).toBe(true);
    },
  );

  test("no route trusts the local-operator constant", () => {
    for (const route of ROUTES) {
      const source = readFileSync(join(APP_DIR, route), "utf8");
      // Prose may mention it — the routes explain what they used to do — so the
      // check is for a *use*, not a mention.
      const uses = /LOCAL_OPERATOR_ID[\s,)]/.test(
        source
          .split("\n")
          .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
          .join("\n"),
      );

      expect(uses, `${route} uses LOCAL_OPERATOR_ID`).toBe(false);
    }
  });

  test("the public routes are only the ones that cannot present a credential", () => {
    // Pinned, so adding a third is a deliberate edit to this list rather than a
    // route that quietly joined it.
    expect([...PUBLIC_ROUTES].sort()).toEqual([
      "api/auth/login/route.ts",
      "robots.txt/route.ts",
      "sitemap.xml/route.ts",
    ]);
  });

  test("every listed public route still exists", () => {
    // A stale exemption is worse than none: it silently covers whatever path
    // later takes that name.
    for (const route of PUBLIC_ROUTES) {
      expect(ROUTES, `${route} is exempted but does not exist`).toContain(route);
    }
  });
});

describe("the one route without a credential has a limiter instead", () => {
  /** The login route's source, comments stripped. */
  function loginSource(): string {
    return readFileSync(join(APP_DIR, "api/auth/login/route.ts"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n");
  }

  test("it spends from the token bucket", () => {
    // The route is exempt from authentication because obtaining a credential is
    // what it is for. Exempt from authentication and unmetered is an open
    // password-guessing endpoint, so the exemption is paid for here.
    expect(loginSource()).toContain("consumeApiTokens");
  });

  test("it is limited on the global key as well as the caller's", () => {
    const source = loginSource();

    // Both, and the global one is what actually holds. The per-address key is
    // derived from a header, and a request that has not passed through a
    // trusted proxy can carry any header it likes — so an attacker rotating
    // that value would get a fresh bucket every time. The global key is derived
    // from nothing, so no header changes it.
    expect(source).toContain("LOGIN_GLOBAL_RATE_LIMIT_KEY");
    expect(source).toContain("loginRateLimitKey");
  });

  test("it is not keyed on the email", () => {
    // That would be a denial of service dressed as a protection: anyone could
    // lock a named user out of their own account by failing on their behalf.
    expect(loginSource()).not.toMatch(/rateLimitKey\([^)]*email/i);
  });

  test("the limit is spent before the credentials are checked", () => {
    const source = loginSource();
    const limited = source.indexOf("refuseIfTooFast");
    const checked = source.indexOf("signInWithPassword");

    // A limiter that ran after the check would charge for successes and let the
    // guessing through free, which is the exact inverse of the point.
    expect(limited).toBeGreaterThanOrEqual(0);
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(limited).toBeLessThan(checked);
  });

  test("a refusal says nothing about the account", () => {
    const source = loginSource();

    // "Too many attempts" and nothing else. Naming which bucket filled would
    // tell a caller whether anybody else is signing in from their address.
    expect(source).toContain("Too many sign-in attempts");
    expect(source).toMatch(/status: 429/);
  });
});

describe("server-rendered pages do not read tenant data unauthenticated", () => {
  test("no dashboard page uses the local-operator constant", () => {
    const pages = ["dashboard/page.tsx", "dashboard/projects/[id]/page.tsx"];

    for (const page of pages) {
      const source = readFileSync(join(APP_DIR, page), "utf8");
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
        .join("\n");

      // A server component receives no `Authorization` header, so it cannot
      // authenticate at all — which is why these pages stopped reading tenant
      // data rather than reading it as a constant.
      expect(/LOCAL_OPERATOR_ID[\s,)]/.test(code), `${page} uses it`).toBe(false);
    }
  });
});
