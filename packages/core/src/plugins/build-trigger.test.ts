import { describe, expect, test, vi } from "vitest";

import {
  DEPLOY_WEBHOOK_URL_ENV_VAR,
  createBuildTriggerFromEnv,
  createStaticBuildTriggerPlugin,
  resolveDeployWebhookUrl,
} from "./build-trigger.js";
import type { QueueDrainedEvent } from "./hooks.js";
import { registerPlugins } from "./plugin.js";

/**
 * The last link in continuous publishing, and the one with a bill attached.
 *
 * Two things are easy to get wrong here and neither announces itself. Deploying
 * too often costs build minutes and looks like nothing; deploying when nothing
 * succeeded publishes a failure as though it were a release. Most of these
 * tests are about *not* firing.
 */

const HOOK = "https://api.vercel.com/v1/integrations/deploy/prj_x/SECRET";

/** A drain, as the worker reports one. */
function drain(over: Partial<QueueDrainedEvent> = {}): QueueDrainedEvent {
  return {
    instanceId: "w1",
    succeeded: 2,
    failed: 0,
    projectIds: ["prj_1"],
    reason: "queue-empty",
    drainedAt: "2026-08-28T00:00:00.000Z",
    ...over,
  };
}

/** A fetch that always answers 200. */
function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
}

/** Install the plugin on a real bus and hand back the pieces. */
function install(options: {
  fetchFn: ReturnType<typeof vi.fn>;
  log?: (message: string) => void;
}) {
  const failures: string[] = [];
  const { hooks } = registerPlugins(
    [
      createStaticBuildTriggerPlugin({
        url: HOOK,
        fetchFn: options.fetchFn as unknown as typeof fetch,
        log: options.log ?? (() => {}),
      }),
    ],
    {
      onFailure: (failure) => {
        failures.push(
          failure.error instanceof Error ? failure.error.message : String(failure.error),
        );
      },
    },
  );

  return { hooks, failures };
}

describe("a drained queue triggers exactly one deploy", () => {
  test("it posts to the hook when work succeeded", async () => {
    const fetchFn = okFetch();
    const { hooks, failures } = install({ fetchFn });

    await hooks.emit("afterQueueDrained", drain());

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);

    const [url, init] = fetchFn.mock.calls[0] as [URL, RequestInit];

    expect(url.toString()).toBe(HOOK);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      source: "staticforge",
      instanceId: "w1",
      succeeded: 2,
      projectIds: ["prj_1"],
    });
  });

  test("one drain is one deploy, however many jobs it covered", async () => {
    const fetchFn = okFetch();
    const { hooks } = install({ fetchFn });

    await hooks.emit("afterQueueDrained", drain({ succeeded: 40 }));

    // Forty jobs, one build. Deploying per job would start forty builds to
    // publish one sync, and a static build of a few hundred pages is the most
    // expensive thing in this system.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("a shutdown drain deploys too, so finished work is not left unpublished", async () => {
    const fetchFn = okFetch();
    const { hooks } = install({ fetchFn });

    await hooks.emit("afterQueueDrained", drain({ reason: "worker-stopping" }));

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("it declines to publish a failure", () => {
  test("nothing is posted when no job succeeded", async () => {
    const fetchFn = okFetch();
    const logged: string[] = [];
    const { hooks } = install({ fetchFn, log: (line) => logged.push(line) });

    await hooks.emit("afterQueueDrained", drain({ succeeded: 0, failed: 3 }));

    // The content on disk is what the host already serves, so a build would
    // spend money to change nothing — and would make a failing queue look like
    // a working one.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(logged.join("\n")).toMatch(/skipped/i);
  });

  test("a partial success still deploys", async () => {
    const fetchFn = okFetch();
    const { hooks } = install({ fetchFn });

    await hooks.emit("afterQueueDrained", drain({ succeeded: 1, failed: 5 }));

    // One page that built is one page worth publishing. Waiting for a clean
    // sweep would mean a single poisoned job freezing the whole site.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("a broken hook is reported, not swallowed and not fatal", () => {
  test("a non-2xx answer reaches the failure channel", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const { hooks, failures } = install({ fetchFn });

    const result = await hooks.emit("afterQueueDrained", drain());

    // A deploy hook that answers 401 for a week is otherwise only ever noticed
    // by the person asking why the site is stale.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/401/);
    expect(result.failures[0]?.plugin).toBe("static-build-trigger");
  });

  test("a network failure does not reject the emission", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { hooks } = install({ fetchFn });

    // The jobs are done and the rows are written. A host that cannot be reached
    // must not turn a finished stretch of work into a crashed worker.
    await expect(hooks.emit("afterQueueDrained", drain())).resolves.toMatchObject({
      delivered: 0,
    });
  });
});

describe("the hook URL is treated as a credential and as an address", () => {
  test("the secret path never appears in the plugin's description", () => {
    const plugin = createStaticBuildTriggerPlugin({ url: HOOK, fetchFn: okFetch() as never });

    // A deploy hook is a capability URL: anyone holding one can trigger a
    // production deploy. The description is printed at boot and pasted into
    // support threads.
    expect(plugin.description).toContain("https://api.vercel.com");
    expect(plugin.description).not.toContain("SECRET");
  });

  test("the secret path never appears in a success line", async () => {
    const logged: string[] = [];
    const { hooks } = install({ fetchFn: okFetch(), log: (line) => logged.push(line) });

    await hooks.emit("afterQueueDrained", drain());

    expect(logged.join("\n")).not.toContain("SECRET");
  });

  test("a loopback hook is refused at construction", () => {
    expect(() =>
      createStaticBuildTriggerPlugin({ url: "http://localhost:3000/deploy" }),
    ).toThrow(/loopback or private/i);
  });

  test("a private range is refused at construction", () => {
    expect(() =>
      createStaticBuildTriggerPlugin({ url: "http://169.254.169.254/latest/meta-data" }),
    ).toThrow(/loopback or private/i);
  });

  test("a non-http scheme is refused", () => {
    expect(() => createStaticBuildTriggerPlugin({ url: "file:///etc/passwd" })).toThrow(
      /only http and https/i,
    );
  });

  test("refusal happens at construction, not at the first deploy", () => {
    // A typo must be a line at boot rather than a silent non-deploy discovered
    // by a customer.
    expect(() => createStaticBuildTriggerPlugin({ url: "not a url" })).toThrow();
  });

  test("a plugin that cannot be built does not stop the others installing", () => {
    const { installed, failed } = registerPlugins([
      {
        name: "explodes",
        setup() {
          throw new Error("bad config");
        },
      },
      createStaticBuildTriggerPlugin({ url: HOOK, fetchFn: okFetch() as never }),
    ]);

    expect(installed).toEqual(["static-build-trigger"]);
    expect(failed.map((f) => f.plugin)).toEqual(["explodes"]);
  });
});

describe("configuration by presence", () => {
  test("no variable means no plugin", () => {
    expect(resolveDeployWebhookUrl({})).toBeUndefined();
    expect(createBuildTriggerFromEnv({})).toBeUndefined();
  });

  test("a blank variable counts as unset", () => {
    // A variable declared empty in a deployment template is a variable nobody
    // filled in. Treating it as a URL produces a confusing failure at the worst
    // moment rather than a clear absence at boot.
    expect(resolveDeployWebhookUrl({ [DEPLOY_WEBHOOK_URL_ENV_VAR]: "   " })).toBeUndefined();
    expect(createBuildTriggerFromEnv({ [DEPLOY_WEBHOOK_URL_ENV_VAR]: "" })).toBeUndefined();
  });

  test("a configured hook builds the plugin", () => {
    const plugin = createBuildTriggerFromEnv(
      { [DEPLOY_WEBHOOK_URL_ENV_VAR]: HOOK },
      { fetchFn: okFetch() as never },
    );

    expect(plugin?.name).toBe("static-build-trigger");
  });

  test("a configured but unusable hook throws rather than being ignored", () => {
    // Absence is ordinary. Present-and-wrong is a deployment somebody
    // configured and got wrong, which is the opposite of ordinary.
    expect(() =>
      createBuildTriggerFromEnv({ [DEPLOY_WEBHOOK_URL_ENV_VAR]: "http://127.0.0.1/x" }),
    ).toThrow(/loopback or private/i);
  });
});
