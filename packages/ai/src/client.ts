import Anthropic from "@anthropic-ai/sdk";

/**
 * Environment variable holding the Anthropic API key.
 *
 * The key is never read at module scope — see `getAnthropicClient()` — so
 * importing this module has no environment requirements. This keeps the
 * package importable during typecheck, tests, and generator runs that do not
 * touch the AI layer.
 */
const API_KEY_ENV_VAR = "ANTHROPIC_API_KEY";

let cachedClient: Anthropic | undefined;

/**
 * Returns a lazily created, process-wide `Anthropic` client.
 *
 * Throws a clear error when `ANTHROPIC_API_KEY` is missing, consistent with
 * the fail-loud validation style used across the engine.
 */
export function getAnthropicClient(): Anthropic {
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  const apiKey = process.env[API_KEY_ENV_VAR];

  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error(
      `Missing ${API_KEY_ENV_VAR}. Set it in the environment before using @staticforge/ai.`,
    );
  }

  cachedClient = new Anthropic({ apiKey });

  return cachedClient;
}
