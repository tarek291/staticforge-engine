/**
 * Keeping a worker alive through a promise nobody awaited.
 *
 * ## The failure this exists for
 *
 * Since Node 15, an unhandled rejection terminates the process. That default is
 * right for a script and wrong for a long-running worker, and the difference is
 * where the rejection comes from.
 *
 * The plugin bus deliberately does not await everything a plugin starts. It
 * races each listener against a deadline, so a listener that overruns is
 * abandoned rather than allowed to hold up a finished run — and a plugin that
 * fires a request without awaiting it (`void fetch(...)`) leaves a promise the
 * bus never sees. When that promise rejects, nothing is listening, and the
 * process exits.
 *
 * The consequence is out of all proportion to the cause: one deploy webhook
 * failing takes down a worker that was half way through a paid hour-long build.
 * The lease lapses, another worker reclaims the job, and — because every worker
 * is running the same plugin — that one dies too. A misconfigured webhook URL
 * becomes a fleet-wide outage with nothing in any log explaining it.
 *
 * ## Why surviving is correct here, and not in general
 *
 * "Swallow unhandled rejections" is bad advice for most programs, because the
 * rejection usually means a result something downstream is about to use is
 * missing. That reasoning does not apply to a *detached* promise: nothing is
 * awaiting it, so nothing downstream depends on it. Every promise the job loop
 * itself depends on is awaited, and a failure there is already handled.
 *
 * So this absorbs what nobody was waiting for, and does not touch what anybody
 * was.
 *
 * ## Why it still gives up eventually
 *
 * Absorbing without limit turns a crash into an invisible haemorrhage. A worker
 * whose every job leaks a rejection would run forever, look healthy, and be
 * broken — which is worse than the crash, because the crash at least gets
 * noticed.
 *
 * So there is a threshold. A blip is survived; a pathology exits, loudly, with
 * a message that names what has been happening. The whole point is to convert a
 * process-ending accident into a process-ending *decision*.
 *
 * ## What it deliberately does not catch
 *
 * `uncaughtException`. A rejected promise is a value; an escaped throw means a
 * synchronous stack unwound through code that was not expecting it, and the
 * process state after one is genuinely unknown. Surviving that would be
 * guessing.
 */

/**
 * Render a rejection reason as text that cannot itself throw.
 *
 * `String(value)` is not total. `String(Object.create(null))` throws, because
 * the object has no prototype and therefore no `toString`; so does anything
 * whose `toString` or `Symbol.toPrimitive` throws, and reading `.message` off a
 * getter that throws does the same.
 *
 * Ordinarily that would be a cosmetic bug in a log line. Here it is not: this
 * runs *inside* the `unhandledRejection` handler, and a throw from inside that
 * handler is an uncaught exception — which terminates the process. The guard
 * installed to stop a worker dying on a rejected promise would be the thing
 * that killed it, on exactly the malformed rejection it was there to absorb.
 *
 * So the formatting is wrapped, and the fallback is a fixed string with nothing
 * derived from the value in it. Anything derived could throw for the same
 * reason the first attempt did.
 */
function describe(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      // Both fields, separately: `name` and `message` are ordinary properties
      // and either can be a getter, so one throwing must not lose the other.
      const name = safely(() => String(reason.name)) ?? "Error";
      const message = safely(() => String(reason.message)) ?? "(unreadable message)";

      return `${name}: ${message}`;
    }

    return String(reason);
  } catch {
    return "(a rejection value that cannot be converted to text)";
  }
}

/** Run a formatter, or give up on it. */
function safely(render: () => string): string | undefined {
  try {
    return render();
  } catch {
    return undefined;
  }
}

/** How many detached rejections are absorbed before the worker gives up. */
export const REJECTION_BUDGET = 20;

/** The window the budget is counted over. */
export const REJECTION_WINDOW_MS = 60_000;

/** What a guard needs from the process it protects. */
export interface CrashGuardHost {
  on: (event: "unhandledRejection", listener: (reason: unknown) => void) => unknown;
  off?: (event: "unhandledRejection", listener: (reason: unknown) => void) => unknown;
  exit: (code: number) => never;
}

/** Options for {@link installCrashGuard}. */
export interface CrashGuardOptions {
  /** Where absorbed failures are reported. */
  log: (message: string) => void;
  /** The process to attach to. Injected so this is testable without one. */
  host?: CrashGuardHost;
  /** Rejections tolerated per window. */
  budget?: number;
  /** The window, in milliseconds. */
  windowMs?: number;
  /** Clock, injected so the window can be tested without waiting for it. */
  now?: () => number;
}

/** A guard that can be taken back off. */
export interface CrashGuard {
  /** Stop absorbing. */
  uninstall: () => void;
  /** How many rejections have been absorbed in the current window. */
  absorbed: () => number;
}

/**
 * Absorb detached promise rejections instead of dying on them.
 *
 * @returns A handle that removes the listener, so a test — or a caller shutting
 * down cleanly — does not leave one attached to a shared process object.
 */
export function installCrashGuard(options: CrashGuardOptions): CrashGuard {
  const {
    log,
    host = process as unknown as CrashGuardHost,
    budget = REJECTION_BUDGET,
    windowMs = REJECTION_WINDOW_MS,
    now = () => Date.now(),
  } = options;

  let windowStartedAt = now();
  let absorbed = 0;

  const listener = (reason: unknown): void => {
    const at = now();

    if (at - windowStartedAt >= windowMs) {
      // A fresh window. Counted from the first rejection of a burst rather than
      // on a fixed schedule, so twenty failures spread over an hour are treated
      // as twenty blips and not as a pathology.
      windowStartedAt = at;
      absorbed = 0;
    }

    absorbed += 1;

    const described = describe(reason);

    log(
      `  ! unhandled rejection absorbed (${absorbed}/${budget} this minute): ${described}`,
    );

    if (absorbed >= budget) {
      // Loud, and final. Something is failing on every job, and a worker that
      // kept going would be a worker nobody knows is broken.
      log(
        `  ! ${absorbed} unhandled rejections in ${Math.round(windowMs / 1000)}s ` +
          `— this is not a blip. Stopping so it is noticed. Any claimed job is ` +
          `resumable and another worker will reclaim it when the lease lapses.`,
      );

      host.exit(1);
    }
  };

  host.on("unhandledRejection", listener);

  return {
    uninstall: () => {
      host.off?.("unhandledRejection", listener);
    },
    absorbed: () => absorbed,
  };
}
