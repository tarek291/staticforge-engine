/**
 * Lifecycle events, and the plugins that listen to them.
 *
 * The engine needs to be extensible without becoming editable. Those are
 * different things, and the difference decides most of this file.
 *
 * ## Why listeners observe rather than transform
 *
 * The obvious design gives a hook the value and lets it return a changed one —
 * a `beforePageRender` that rewrites the page. That would be a hole straight
 * through everything this engine is: page content passes three gates before it
 * is published, and a plugin that could alter content after those gates would
 * publish whatever it liked. A grounding guard that a plugin can edit around is
 * not a guard.
 *
 * So a listener is told what happened and cannot change it. Payloads are flat,
 * already-serialisable summaries — ids, counts, slugs — never live engine
 * objects, so a listener has nothing to hold a reference to and nothing to
 * mutate. Transformation is not "not built yet"; it is the thing that would
 * need its own gates before it could exist.
 *
 * ## Why a failing plugin cannot fail a run
 *
 * A plugin is third-party code running inside a paid, hour-long build. If it
 * can abort that build, installing one is a risk nobody should take. Each
 * listener is therefore isolated: its failure is caught, reported, and the next
 * listener still runs. A *rejection* is caught the same way as a throw, and so
 * is a listener that simply never finishes — a hang stops the engine exactly as
 * effectively as an exception, and more quietly, so listeners run under a
 * deadline.
 */

/** Summary of a finished queue job. */
export interface JobCompletedEvent {
  jobId: string;
  projectId: string;
  userId: string;
  kind: string;
  ok: boolean;
  exitCode: number;
  /** Whether this run picked up an interrupted attempt. */
  resumed: boolean;
  durationMs: number;
  completedAt: string;
}

/** Summary of a completed data sync. */
export interface ProjectSyncEvent {
  projectId: string;
  userId: string;
  /** Whether the incoming data differed from what the project held. */
  changed: boolean;
  /** The run queued because of it, if any. */
  jobId: string | null;
  servicesAdded: number;
  servicesUpdated: number;
  servicesRemoved: number;
  locationsAdded: number;
  locationsUpdated: number;
  locationsRemoved: number;
  syncedAt: string;
}

/** Summary of a page set about to be written to disk. */
export interface PagesWritingEvent {
  projectId: string | null;
  outputDir: string;
  locale: string;
  pageCount: number;
  slugs: string[];
}

/** Summary of a page set that has been written. */
export interface PagesWrittenEvent extends PagesWritingEvent {
  writtenAt: string;
}

/**
 * Every event the engine emits, by name.
 *
 * Adding an event here is what makes it addressable; a listener for a name that
 * is not in this map is a compile error rather than a silent no-op.
 */
export interface HookEvents {
  /** A queue job finished, either way. */
  afterJobCompleted: JobCompletedEvent;
  /** A sync finished, whether or not it changed anything. */
  afterProjectSync: ProjectSyncEvent;
  /** Pages are about to be written. Observational: nothing here can stop it. */
  beforePagesWritten: PagesWritingEvent;
  /** Pages have been written and are on disk. */
  afterPagesWritten: PagesWrittenEvent;
}

/** A name the engine emits. */
export type HookName = keyof HookEvents;

/** What a listener is handed. */
export type HookListener<K extends HookName> = (
  payload: Readonly<HookEvents[K]>,
) => void | Promise<void>;

/** A listener failure, as the bus reports it. */
export interface HookFailure {
  hook: HookName;
  /** Which plugin registered the listener, when it said. */
  plugin: string;
  reason: "threw" | "timed-out";
  error: unknown;
}

/** What one emission did. */
export interface HookEmitResult {
  hook: HookName;
  /** Listeners that ran to completion. */
  delivered: number;
  /** Listeners that threw, rejected, or ran past the deadline. */
  failures: HookFailure[];
}

/** Options for {@link createHookBus}. */
export interface HookBusOptions {
  /**
   * Longest a single listener may take.
   *
   * A hang stops the engine as effectively as an exception and much more
   * quietly, so there is a deadline. The listener is not cancelled — nothing
   * here can cancel arbitrary code — it is abandoned, and the engine moves on.
   */
  listenerTimeoutMs?: number;
  /**
   * Where listener failures are reported.
   *
   * Wired to the job log by the worker, so a plugin misbehaving inside a run
   * shows up where an operator is already looking.
   */
  onFailure?: (failure: HookFailure) => void;
}

/** Default deadline for one listener. Generous: most do I/O. */
export const DEFAULT_LISTENER_TIMEOUT_MS = 10_000;

/** Registration and emission. */
export interface HookBus {
  on<K extends HookName>(
    hook: K,
    listener: HookListener<K>,
    /** Plugin name, for reporting. */
    plugin?: string,
  ): void;
  emit<K extends HookName>(
    hook: K,
    payload: HookEvents[K],
  ): Promise<HookEmitResult>;
  /** How many listeners are registered for a hook. */
  count(hook: HookName): number;
}

/** A registered listener and who registered it. */
interface Registration {
  listener: HookListener<HookName>;
  plugin: string;
}

/**
 * Run one listener under a deadline, converting every failure into a value.
 *
 * `Promise.race` rather than an abort signal, because a listener is arbitrary
 * code and cannot be made cancellable. The timer is unref'd so an abandoned
 * listener cannot hold the process open, and the outcome is reported either
 * way — a plugin that times out is a plugin that failed, not one that passed.
 */
async function runListener(
  registration: Registration,
  payload: unknown,
  timeoutMs: number,
): Promise<{ reason: HookFailure["reason"]; error: unknown } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => {
      resolve("timed-out");
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([
      // Wrapped in `Promise.resolve().then` so a listener that throws
      // *synchronously* is caught here rather than escaping the race.
      Promise.resolve()
        .then(() => registration.listener(payload as never))
        .then(() => "ok" as const),
      deadline,
    ]);

    return outcome === "ok"
      ? undefined
      : {
          reason: "timed-out",
          error: new Error(`Listener exceeded ${timeoutMs}ms and was abandoned.`),
        };
  } catch (error: unknown) {
    // The thrown value is carried out rather than discarded: "a plugin failed"
    // is not an actionable report, and the operator reading the job log is the
    // only person who can do anything about it.
    return { reason: "threw", error };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Freeze a payload so a listener cannot alter what a later one sees.
 *
 * Shallow, and that is enough: payloads are flat summaries by construction, and
 * a deep freeze over a large structure would cost more than the guarantee is
 * worth here. Arrays are frozen too, since a slug list is the one nested value
 * a payload carries.
 */
function freeze<T extends Record<string, unknown>>(payload: T): Readonly<T> {
  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) {
      Object.freeze(value);
    }
  }

  return Object.freeze(payload);
}

/**
 * Create a bus.
 *
 * @param options - Listener deadline and failure reporting.
 */
export function createHookBus(options: HookBusOptions = {}): HookBus {
  const timeoutMs = options.listenerTimeoutMs ?? DEFAULT_LISTENER_TIMEOUT_MS;
  const registry = new Map<HookName, Registration[]>();

  return {
    on(hook, listener, plugin = "(anonymous)") {
      const existing = registry.get(hook) ?? [];
      existing.push({ listener: listener as HookListener<HookName>, plugin });
      registry.set(hook, existing);
    },

    count(hook) {
      return registry.get(hook)?.length ?? 0;
    },

    async emit(hook, payload) {
      const listeners = registry.get(hook) ?? [];
      const failures: HookFailure[] = [];
      let delivered = 0;

      const frozen = freeze(payload as unknown as Record<string, unknown>);

      // Sequential on purpose. Listeners are third-party code doing I/O, and
      // running them in parallel would make one slow plugin's cost depend on
      // what else happens to be installed — plus their log output would
      // interleave into something nobody can read.
      for (const registration of listeners) {
        const outcome = await runListener(registration, frozen, timeoutMs);

        if (outcome === undefined) {
          delivered += 1;
          continue;
        }

        const failure: HookFailure = {
          hook,
          plugin: registration.plugin,
          reason: outcome.reason,
          error: outcome.error,
        };

        failures.push(failure);

        // Reporting is itself third-party-adjacent: a reporter that throws must
        // not become the failure that stops the run it was reporting on.
        try {
          options.onFailure?.(failure);
        } catch {
          // Nothing left to report to.
        }
      }

      return { hook, delivered, failures };
    },
  };
}
