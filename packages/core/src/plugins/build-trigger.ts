import { checkOutboundUrl, redactUrl } from "../net/outbound-url.js";
import type { StaticForgePlugin } from "./plugin.js";

/**
 * Telling a static host that the content it serves has changed.
 *
 * The last link in continuous publishing. The engine writes pages to a database
 * and to disk; a static host builds a site from them at a moment of its own
 * choosing. Between those two facts is a gap in which a customer's site shows
 * yesterday's content and nothing anywhere is wrong.
 *
 * This closes it by posting to a deploy hook when the queue drains. Vercel,
 * Netlify, Cloudflare Pages and GitHub all expose the same primitive — a URL
 * that starts a build when something POSTs to it — so this plugin is not
 * Vercel-specific and is deliberately not named for one host. The only thing it
 * needs to know is the URL, and the only thing it does is ask.
 *
 * ## Why it triggers on the queue draining, not on a job finishing
 *
 * A sync that changes ten services queues work that lands as a sequence of
 * jobs. Deploying after each one would start ten builds to publish one change,
 * and a static build of a few hundred pages is not free — for a host that bills
 * by build minute it is the most expensive thing in this system.
 *
 * Draining is the earliest moment at which the engine can say the content is
 * settled. It fires once, after the last job, which is exactly one deploy for
 * any amount of work that arrived together.
 *
 * ## Why it holds no engine state
 *
 * It is handed a summary and a URL and has neither a database client nor a way
 * back into the run. That is the plugin contract, and it is what makes this
 * safe to install: the worst a broken deploy hook can do is fail to deploy.
 */

/** Environment variable carrying the deploy hook. */
export const DEPLOY_WEBHOOK_URL_ENV_VAR = "DEPLOY_WEBHOOK_URL";

/** How long the hook has to answer before the attempt is abandoned. */
export const DEPLOY_REQUEST_TIMEOUT_MS = 10_000;

/** What the plugin sends, and what it does with the answer. */
export interface BuildTriggerOptions {
  /** The deploy hook to post to. */
  url: string;
  /** Injected so the plugin is testable without a network. */
  fetchFn?: typeof fetch;
  /**
   * Where this plugin's own notices go.
   *
   * Separate from the hook bus's failure channel: a deploy that was *skipped*
   * is not a failure, and reporting it as one would train an operator to ignore
   * the channel that also carries real ones.
   */
  log?: (message: string) => void;
  /** Longest to wait for the hook. Defaults to {@link DEPLOY_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Read the deploy hook from the environment.
 *
 * @returns The URL, or `undefined` when it is unset or blank. Blank counts as
 * unset: a variable declared empty in a deployment template is a variable
 * nobody filled in, and treating it as a URL produces a confusing failure at
 * the worst moment rather than a clear absence at boot.
 */
export function resolveDeployWebhookUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[DEPLOY_WEBHOOK_URL_ENV_VAR]?.trim();

  return value === undefined || value === "" ? undefined : value;
}

/**
 * Build the trigger.
 *
 * The URL is checked at construction rather than at the first deploy, so a
 * typo is a line at boot instead of a silent non-deploy discovered by a
 * customer. A bad URL throws, which the plugin registrar catches: the worker
 * starts, reports that this plugin was skipped, and does the jobs. A worker
 * that refused to run because a deploy hook was malformed would turn a
 * publishing problem into an outage.
 *
 * @throws {Error} If the URL is unusable or points somewhere this engine will
 * not connect.
 */
export function createStaticBuildTriggerPlugin(
  options: BuildTriggerOptions,
): StaticForgePlugin {
  const checked = checkOutboundUrl(options.url, DEPLOY_WEBHOOK_URL_ENV_VAR);

  if (!checked.ok) {
    throw new Error(checked.message);
  }

  const target = checked.url;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEPLOY_REQUEST_TIMEOUT_MS;
  const log =
    options.log ??
    ((message: string) => {
      // eslint-disable-next-line no-console
      console.log(message);
    });

  return {
    name: "static-build-trigger",
    description: `Posts to a deploy hook at ${redactUrl(target)} when the queue drains.`,

    setup(hooks) {
      hooks.on("afterQueueDrained", async (payload) => {
        if (payload.succeeded === 0) {
          // Nothing was published, so there is nothing to publish. A drain that
          // follows only failures means the content on disk is what the host
          // already serves; deploying would spend a build to change nothing and
          // would make a failing queue look like a working one.
          log(
            `  · deploy skipped: ${payload.failed} job(s) failed and none succeeded`,
          );
          return;
        }

        // The plugin's own deadline, inside the bus's. The bus abandons a
        // listener that overruns but cannot cancel it, so a fetch left without
        // one would keep a socket open for as long as the host felt like
        // holding it, on a process that is otherwise idle.
        const response = await fetchFn(target, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source: "staticforge",
            instanceId: payload.instanceId,
            succeeded: payload.succeeded,
            failed: payload.failed,
            projectIds: payload.projectIds,
            drainedAt: payload.drainedAt,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          // Thrown rather than logged, so it reaches the bus's failure channel
          // and the job log an operator is already reading. A deploy hook that
          // answers 401 for a week is the kind of thing that is only ever
          // noticed by the person asking why the site is stale.
          throw new Error(
            `Deploy hook at ${redactUrl(target)} answered ` +
              `${response.status} ${response.statusText}.`,
          );
        }

        log(
          `  ✓ deploy triggered at ${redactUrl(target)} ` +
            `(${payload.succeeded} job(s) published)`,
        );
      });
    },
  };
}

/**
 * Build the trigger from the environment, or nothing.
 *
 * Absence is the ordinary case and not a warning: a local worker, a CI run and
 * a developer's machine all legitimately have no deploy hook, and a line of
 * output every time one starts is a line that gets filtered and then missed
 * when it matters.
 *
 * A *present but broken* hook is the opposite — it is a deployment somebody
 * configured and got wrong — so the failure is returned rather than swallowed.
 *
 * @returns The plugin, or `undefined` when no hook is configured.
 * @throws {Error} If a hook is configured and unusable.
 */
export function createBuildTriggerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<BuildTriggerOptions, "url"> = {},
): StaticForgePlugin | undefined {
  const url = resolveDeployWebhookUrl(env);

  return url === undefined
    ? undefined
    : createStaticBuildTriggerPlugin({ ...options, url });
}
