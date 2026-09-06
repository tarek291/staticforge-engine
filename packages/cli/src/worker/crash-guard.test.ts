import { describe, expect, test, vi } from "vitest";

import {
  REJECTION_BUDGET,
  installCrashGuard,
  type CrashGuardHost,
} from "./crash-guard.js";

/**
 * The worker outliving a promise nobody awaited.
 *
 * These tests drive a fake process rather than the real one, for the obvious
 * reason: a test that installed a handler on the real `process` and then made
 * it call `process.exit` would take the test runner with it.
 */

/** A process stand-in that records what the guard did to it. */
function fakeHost(): CrashGuardHost & {
  fire: (reason: unknown) => void;
  exits: number[];
  listeners: number;
} {
  const listeners: Array<(reason: unknown) => void> = [];
  const exits: number[] = [];

  return {
    on(_event, listener) {
      listeners.push(listener);
      return this;
    },
    off(_event, listener) {
      const at = listeners.indexOf(listener);

      if (at >= 0) {
        listeners.splice(at, 1);
      }

      return this;
    },
    exit(code: number): never {
      exits.push(code);
      // Not a real exit: the guard's contract is "this call does not return",
      // and throwing is how a test observes that without ending the run.
      throw new Error(`exit(${String(code)})`);
    },
    fire(reason: unknown) {
      for (const listener of [...listeners]) {
        listener(reason);
      }
    },
    exits,
    get listeners() {
      return listeners.length;
    },
  };
}

describe("a detached rejection does not end the worker", () => {
  test("the process is not exited", () => {
    const host = fakeHost();
    const logged: string[] = [];

    installCrashGuard({
      log: (message) => logged.push(message),
      host,
    });

    host.fire(new Error("deploy webhook refused the connection"));

    // The whole point. Node's default since v15 is to terminate here, which
    // would take down a worker half way through a paid build because one
    // plugin fired a request it did not await.
    expect(host.exits).toEqual([]);
  });

  test("the failure is reported rather than swallowed", () => {
    const host = fakeHost();
    const logged: string[] = [];

    installCrashGuard({ log: (message) => logged.push(message), host });

    host.fire(new Error("deploy webhook refused the connection"));

    // Absorbing silently would be the worse half of the trade: a worker that
    // looks healthy while something fails on every job.
    expect(logged[0]).toContain("deploy webhook refused the connection");
    expect(logged[0]).toContain("unhandled rejection absorbed");
  });

  test("a rejection that is not an Error is still survived and still described", () => {
    const host = fakeHost();
    const logged: string[] = [];

    installCrashGuard({ log: (message) => logged.push(message), host });

    // `Promise.reject("nope")` is legal and common in code nobody audited.
    // Reading `.message` off it would throw inside the handler, which is a
    // crash in the thing installed to prevent crashes.
    host.fire("nope");
    host.fire(undefined);

    expect(host.exits).toEqual([]);
    expect(logged[0]).toContain("nope");
    expect(logged[1]).toContain("undefined");
  });

  test("many jobs in a row each leaking one rejection keeps working", () => {
    const host = fakeHost();
    const clock = { at: 0 };

    installCrashGuard({
      log: () => {},
      host,
      now: () => clock.at,
    });

    // One failure a minute, for two hours. A blip that recurs slowly is still
    // a blip, and the window is counted from the first failure of a burst so
    // this never accumulates into a false pathology.
    for (let minute = 0; minute < 120; minute += 1) {
      clock.at = minute * 60_000;
      host.fire(new Error("transient"));
    }

    expect(host.exits).toEqual([]);
  });
});

describe("a pathology is not absorbed for ever", () => {
  test("crossing the budget inside the window exits, loudly", () => {
    const host = fakeHost();
    const logged: string[] = [];

    installCrashGuard({
      log: (message) => logged.push(message),
      host,
      now: () => 0,
    });

    let thrown: unknown;

    try {
      for (let i = 0; i < REJECTION_BUDGET; i += 1) {
        host.fire(new Error("every single job"));
      }
    } catch (error: unknown) {
      thrown = error;
    }

    // A worker that absorbed without limit would run for ever, look healthy,
    // and be broken — which is worse than the crash, because the crash gets
    // noticed. The exit converts a process-ending accident into a decision.
    expect(host.exits).toEqual([1]);
    expect(String(thrown)).toContain("exit(1)");
    expect(logged.at(-1)).toContain("this is not a blip");
  });

  test("it says the job is not lost, because it is not", () => {
    const host = fakeHost();
    const logged: string[] = [];

    installCrashGuard({ log: (message) => logged.push(message), host, now: () => 0 });

    try {
      for (let i = 0; i < REJECTION_BUDGET; i += 1) {
        host.fire(new Error("boom"));
      }
    } catch {
      // Expected.
    }

    // An operator reading this at 3am needs to know whether stopping cost them
    // the run. It did not: the lease lapses and another worker reclaims it.
    expect(logged.at(-1)).toContain("resumable");
  });

  test("the budget is per window, not for the lifetime of the process", () => {
    const host = fakeHost();
    const clock = { at: 0 };

    installCrashGuard({ log: () => {}, host, now: () => clock.at, budget: 3 });

    host.fire(new Error("one"));
    host.fire(new Error("two"));

    // A new window. The two before it are forgotten, so a worker that has been
    // up for a month is not one failure away from exiting on its history.
    clock.at = 61_000;

    host.fire(new Error("three"));
    host.fire(new Error("four"));

    expect(host.exits).toEqual([]);
  });
});

describe("the guard can be taken back off", () => {
  test("uninstalling removes the listener", () => {
    const host = fakeHost();

    const guard = installCrashGuard({ log: () => {}, host });

    expect(host.listeners).toBe(1);

    guard.uninstall();

    expect(host.listeners).toBe(0);
  });

  test("a host without `off` does not break uninstalling", () => {
    const bare: CrashGuardHost = {
      on: vi.fn(),
      exit: (() => {
        throw new Error("exit");
      }) as never,
    };

    const guard = installCrashGuard({ log: () => {}, host: bare });

    // Optional on the interface, so a caller passing something minimal — a
    // test double, an older host — is not met with a TypeError from the
    // cleanup path.
    expect(() => guard.uninstall()).not.toThrow();
  });
});

describe("the guard against crashes does not crash", () => {
  /** Values that throw when JavaScript tries to make them text. */
  const unprintable: ReadonlyArray<[string, () => unknown]> = [
    // No prototype, so no `toString`. `String()` on one throws outright.
    ["a null-prototype object", () => Object.create(null)],
    [
      "an object whose toString throws",
      () => ({
        toString() {
          throw new Error("nope");
        },
      }),
    ],
    [
      "an object whose Symbol.toPrimitive throws",
      () => ({
        [Symbol.toPrimitive]() {
          throw new Error("nope");
        },
      }),
    ],
    [
      "an Error whose message getter throws",
      () => {
        const error = new Error("x");

        Object.defineProperty(error, "message", {
          get() {
            throw new Error("nope");
          },
        });

        return error;
      },
    ],
  ];

  for (const [label, make] of unprintable) {
    test(`${label} is absorbed rather than fatal`, () => {
      const host = fakeHost();
      const logged: string[] = [];

      installCrashGuard({ log: (message) => logged.push(message), host });

      // This runs *inside* the `unhandledRejection` handler, so a throw here is
      // an uncaught exception — which terminates the process. The guard
      // installed to stop a worker dying on a rejected promise would be the
      // thing that killed it, on exactly the malformed rejection it exists to
      // absorb.
      expect(() => host.fire(make())).not.toThrow();
      expect(host.exits).toEqual([]);
      expect(logged).toHaveLength(1);
    });
  }

  test("an Error whose name throws still reports its message", () => {
    const host = fakeHost();
    const logged: string[] = [];
    const error = new Error("connection refused");

    Object.defineProperty(error, "name", {
      get() {
        throw new Error("nope");
      },
    });

    installCrashGuard({ log: (message) => logged.push(message), host });
    host.fire(error);

    // Rendered field by field, so one unreadable half does not lose the other.
    // The message is the part an operator needs.
    expect(logged[0]).toContain("connection refused");
  });

  test("the fallback text derives nothing from the value", () => {
    const host = fakeHost();
    const logged: string[] = [];

    installCrashGuard({ log: (message) => logged.push(message), host });
    host.fire(Object.create(null));

    // Anything derived could throw for the same reason the first attempt did.
    expect(logged[0]).toContain("cannot be converted to text");
  });

  test("the budget still counts an unprintable rejection", () => {
    const host = fakeHost();

    installCrashGuard({ log: () => {}, host, now: () => 0, budget: 3 });

    try {
      host.fire(Object.create(null));
      host.fire(Object.create(null));
      host.fire(Object.create(null));
    } catch {
      // The exit.
    }

    // A rejection nobody can read is still a rejection. Not counting it would
    // let a worker failing on every job look healthy for ever.
    expect(host.exits).toEqual([1]);
  });
});
