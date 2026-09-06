import { describe, expect, test } from "vitest";

import {
  ALLOWED_ORIGINS_ENV_VAR,
  checkRequestOrigin,
  readAllowedHosts,
} from "./request-origin.js";

/**
 * Refusing a mutation the browser was tricked into sending.
 *
 * The case worth reading is the sibling subdomain. `SameSite=Lax` compares
 * registrable domains, so a POST from `evil.example.com` to `app.example.com`
 * is *same-site* and carries the cookie — which is why "we set SameSite" is not
 * an answer to CSRF on any deployment where somebody else can put content on a
 * neighbouring host.
 */

describe("a sibling subdomain is not this origin", () => {
  test("a POST from a neighbouring host is refused", () => {
    const verdict = checkRequestOrigin({
      method: "POST",
      origin: "https://evil.example.com",
      host: "app.example.com",
    });

    // The whole point of the guard. `SameSite=Lax` does not stop this: both
    // hosts are `example.com`, so the browser considers the request same-site
    // and attaches the session cookie.
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("foreign-origin");
  });

  test("a host that merely ends with the same string is refused", () => {
    // `endsWith("example.com")` — the tempting shortcut — accepts this.
    const verdict = checkRequestOrigin({
      method: "POST",
      origin: "https://evil-example.com",
      host: "example.com",
    });

    expect(verdict.ok).toBe(false);
  });

  test("a different port is a different origin", () => {
    const verdict = checkRequestOrigin({
      method: "POST",
      origin: "https://app.example.com:8443",
      host: "app.example.com",
    });

    expect(verdict.ok).toBe(false);
  });

  test("the app's own origin passes", () => {
    expect(
      checkRequestOrigin({
        method: "POST",
        origin: "https://app.example.com",
        host: "app.example.com",
      }).ok,
    ).toBe(true);
  });

  test("the scheme is not compared", () => {
    // A deployment behind a proxy sees `http` internally while the browser sent
    // `https`. Comparing schemes would refuse every request on exactly the
    // deployments that need this guard most.
    expect(
      checkRequestOrigin({
        method: "POST",
        origin: "https://app.example.com",
        host: "app.example.com",
      }).ok,
    ).toBe(true);
  });

  test("case and trailing whitespace do not create a second origin", () => {
    expect(
      checkRequestOrigin({
        method: "POST",
        origin: "https://APP.Example.COM",
        host: "  app.example.com  ",
      }).ok,
    ).toBe(true);
  });
});

describe("what happens when there is nothing to compare", () => {
  test("a missing Origin on a mutation is refused, not waved through", () => {
    const verdict = checkRequestOrigin({
      method: "POST",
      origin: null,
      host: "app.example.com",
    });

    // If absent meant "allow", the attack would be to arrange for absent — and
    // a guard whose default is allow is one bug away from decorative.
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("missing-origin");
  });

  test("`Origin: null` is refused rather than parsed as ours", () => {
    // Sent by a sandboxed iframe and by some cross-origin redirects. It parses
    // as a URL with no host, which is not this server.
    const verdict = checkRequestOrigin({
      method: "POST",
      origin: "null",
      host: "app.example.com",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("malformed-origin");
  });

  test("an unparseable Origin is refused", () => {
    expect(
      checkRequestOrigin({
        method: "POST",
        origin: "not a url",
        host: "app.example.com",
      }).ok,
    ).toBe(false);
  });

  test("a server that does not know its own name refuses", () => {
    const verdict = checkRequestOrigin({
      method: "POST",
      origin: "https://app.example.com",
      host: null,
    });

    // There is nothing to compare against, and "compare against nothing" can
    // only mean allow. A guard that cannot run is not a guard that passes.
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe("unknown-host");
  });
});

describe("reads are not mutations", () => {
  test("GET, HEAD and OPTIONS pass without an Origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get", "head"]) {
      expect(
        checkRequestOrigin({ method, origin: null, host: "app.example.com" }).ok,
        method,
      ).toBe(true);
    }
  });

  test("every method that changes something is checked", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "patch"]) {
      expect(
        checkRequestOrigin({ method, origin: null, host: "app.example.com" }).ok,
        method,
      ).toBe(false);
    }
  });
});

describe("extra origins are opt-in and explicit", () => {
  test("an allowlisted host passes", () => {
    expect(
      checkRequestOrigin({
        method: "POST",
        origin: "https://dashboard.example.net",
        host: "api.example.com",
        allowedHosts: ["dashboard.example.net"],
      }).ok,
    ).toBe(true);
  });

  test("an empty allowlist changes nothing", () => {
    expect(
      checkRequestOrigin({
        method: "POST",
        origin: "https://evil.example.com",
        host: "app.example.com",
        allowedHosts: [],
      }).ok,
    ).toBe(false);
  });

  test("an operator may write a URL where a host is meant", () => {
    // Nobody should have to discover that only the bare host was accepted.
    expect(
      readAllowedHosts({
        [ALLOWED_ORIGINS_ENV_VAR]: "https://one.example.com, two.example.com",
      }),
    ).toEqual(["one.example.com", "two.example.com"]);
  });

  test("an unset variable allows nothing extra", () => {
    expect(readAllowedHosts({})).toEqual([]);
    expect(readAllowedHosts({ [ALLOWED_ORIGINS_ENV_VAR]: "   " })).toEqual([]);
  });

  test("blank entries do not become a wildcard", () => {
    // `"a.example.com,,"` splitting into an empty string that matched
    // everything is the classic way an allowlist stops being one.
    expect(
      readAllowedHosts({ [ALLOWED_ORIGINS_ENV_VAR]: "a.example.com,, ,b.example.com" }),
    ).toEqual(["a.example.com", "b.example.com"]);
  });
});
