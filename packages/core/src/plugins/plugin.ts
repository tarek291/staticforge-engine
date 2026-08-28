import { createHookBus, type HookBus, type HookBusOptions } from "./hooks.js";

/**
 * The contract a plugin satisfies.
 *
 * Deliberately small. A plugin says who it is and registers its listeners; it
 * receives no client, no database handle and no way to reach back into the
 * engine. Anything it needs from the outside — an HTTP client, a file path, a
 * credential — it closes over at construction, where the person installing it
 * can see what they are handing over.
 */
export interface StaticForgePlugin {
  /**
   * Stable name, reported on every failure this plugin causes.
   *
   * The only reason a failure report is useful: "a listener threw" during an
   * hour-long build tells an operator nothing they can act on.
   */
  readonly name: string;
  /** One line, for a listing. */
  readonly description?: string;
  /**
   * Register listeners.
   *
   * Called once, at startup. Throwing here is a *setup* failure and is treated
   * differently from a listener failure: a plugin that cannot install is
   * skipped and reported, because half-registered listeners are worse than
   * none — the plugin would fire for some events and not others, and nothing
   * would say which.
   */
  setup(hooks: HookBus): void;
}

/** A plugin that could not be installed. */
export interface PluginSetupFailure {
  plugin: string;
  error: unknown;
}

/** What a registration pass did. */
export interface PluginRegistration {
  hooks: HookBus;
  /** Plugins whose `setup` completed. */
  installed: string[];
  /** Plugins whose `setup` threw. Their listeners are not registered. */
  failed: PluginSetupFailure[];
}

/**
 * Build a bus and install a set of plugins on it.
 *
 * The composition root's whole job. Setup failures are collected rather than
 * thrown for the same reason listener failures are caught: a broken plugin must
 * not prevent an engine from starting. A worker that refused to boot because
 * one audit logger had a typo would be a worse outcome than running without it.
 *
 * Each plugin's listeners are tagged with its name automatically, so a plugin
 * cannot register anonymously and then be unattributable when it misbehaves.
 *
 * @param plugins - Plugins to install, in order.
 * @param options - Listener deadline and failure reporting.
 */
export function registerPlugins(
  plugins: readonly StaticForgePlugin[],
  options: HookBusOptions = {},
): PluginRegistration {
  const bus = createHookBus(options);
  const installed: string[] = [];
  const failed: PluginSetupFailure[] = [];

  for (const plugin of plugins) {
    // A view of the bus that stamps this plugin's name onto every listener it
    // registers. A plugin cannot opt out of being identified.
    const scoped: HookBus = {
      on: (hook, listener) => {
        bus.on(hook, listener, plugin.name);
      },
      emit: (hook, payload) => bus.emit(hook, payload),
      count: (hook) => bus.count(hook),
    };

    try {
      plugin.setup(scoped);
      installed.push(plugin.name);
    } catch (error: unknown) {
      failed.push({ plugin: plugin.name, error });
    }
  }

  return { hooks: bus, installed, failed };
}

/**
 * A bus with nothing installed.
 *
 * What a caller with no plugins uses, so emission sites never branch on whether
 * a bus exists. An emit with no listeners is a few object allocations, which is
 * cheaper than the `if` it replaces is to get wrong.
 */
export function noopHookBus(): HookBus {
  return createHookBus();
}
