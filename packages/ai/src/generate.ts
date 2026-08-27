import { DEFAULT_CONTENT_PROFILE, type ContentProfile } from "@staticforge/schemas";

import { getAnthropicClient } from "./client.js";
import type { ContentCache } from "./cache.js";
import type { PagePromptDetails } from "./prompts.js";
import {
  AIGenerationService,
  type AuthoredContent,
  type GeneratedPageContent,
  type GenerationRequest,
} from "./service.js";

/**
 * Module-level convenience wrapper over {@link AIGenerationService}.
 *
 * Callers that want to choose a profile, inject a client, or tune the retry
 * policy should construct the service directly. This function exists for the
 * common case — one process, one profile, the ambient credential — and for the
 * generator, which has used this signature since before the service existed.
 */

let cachedService: AIGenerationService | undefined;
let cachedProfileId: string | undefined;

/**
 * The process-wide service, created on first use.
 *
 * Lazy for the same reason the client is: importing this module must not
 * require an API key, so a run that never authors content pays nothing.
 */
function getService(profile: ContentProfile): AIGenerationService {
  if (cachedService !== undefined && cachedProfileId === profile.id) {
    return cachedService;
  }

  cachedService = new AIGenerationService({
    client: getAnthropicClient(),
    profile,
  });
  cachedProfileId = profile.id;

  return cachedService;
}

/**
 * Generate validated page content for one service-in-city combination.
 *
 * @param details - Business, service and city names.
 * @param profile - Quality policy. Defaults to the baseline profile.
 * @throws When `ANTHROPIC_API_KEY` is unset, when the provider stays
 * unreachable, when the model returns no tool call, or when the content
 * violates the contract.
 */
export async function generatePageContent(
  details: PagePromptDetails,
  profile: ContentProfile = DEFAULT_CONTENT_PROFILE,
): Promise<GeneratedPageContent> {
  return getService(profile).generatePageContent(details);
}

/**
 * Build a service wired to the ambient credential.
 *
 * The caller owns the cache, because only it knows where cached content should
 * live — a repository directory, a temp dir in a test, or nowhere at all.
 */
export function createAnthropicService(options: {
  profile?: ContentProfile;
  cache?: ContentCache;
  requireFacts?: boolean;
}): AIGenerationService {
  return new AIGenerationService({
    client: getAnthropicClient(),
    profile: options.profile ?? DEFAULT_CONTENT_PROFILE,
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.requireFacts !== undefined
      ? { requireFacts: options.requireFacts }
      : {}),
  });
}

export type { AuthoredContent, GeneratedPageContent, GenerationRequest };
