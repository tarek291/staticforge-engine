import {
  CONTENT_PROFILES,
  DEFAULT_CONTENT_PROFILE,
  type ContentProfile,
} from "@staticforge/schemas";

import type { AuthoringService } from "./mock.js";
import type { AuthoredContent, GenerationRequest } from "./service.js";

/**
 * Routes each page to the service that holds it to the right content profile.
 *
 * A service is built around one profile: its system prompt is rendered from
 * that profile once, at construction, which is what keeps the rules the model
 * is given and the rules it is judged by from drifting apart. That design is
 * worth keeping, so supporting several profiles in one run is a matter of
 * having several services — not of making one service switch on every call.
 *
 * The router is where the two decisions a page carries finally separate for
 * good: `templateId` never reaches this code at all, because how a page looks
 * has no bearing on how it is written.
 */

/** Builds the service for one profile. Called at most once per profile. */
export type AuthoringServiceFactory = (
  profile: ContentProfile,
) => AuthoringService;

/** Thrown when a page names a profile that does not exist. */
export class UnknownContentProfileError extends Error {
  override readonly name = "UnknownContentProfileError";

  constructor(readonly profileId: string) {
    super(
      `Unknown contentProfileId "${profileId}". Registered profiles: ${Object.keys(
        CONTENT_PROFILES,
      ).join(", ")}.`,
    );
  }
}

/** A router, plus a view of which profiles it actually used. */
export interface AuthoringRouter {
  authorPage(request: GenerationRequest): Promise<AuthoredContent>;
  /** Profile ids a service was built for, in first-use order. */
  readonly profilesUsed: string[];
}

/**
 * Create a router over a set of per-profile services.
 *
 * Services are built lazily and memoized: a run that only ever sees one profile
 * pays for one service and renders one prompt, which is the common case and
 * must not be made more expensive by supporting the uncommon one.
 *
 * @param factory - Builds a service for a profile.
 * @param profiles - The registry to resolve ids against. Defaults to the
 * shipped profiles; injected in tests to prove resolution rather than assume it.
 * @throws {UnknownContentProfileError} When a request names an unregistered
 * profile — silently falling back would mean applying rules nobody chose.
 */
export function createAuthoringRouter(
  factory: AuthoringServiceFactory,
  profiles: Record<string, ContentProfile> = CONTENT_PROFILES,
): AuthoringRouter {
  const services = new Map<string, AuthoringService>();
  const used: string[] = [];

  return {
    profilesUsed: used,

    authorPage(request: GenerationRequest): Promise<AuthoredContent> {
      const profileId = request.contentProfileId ?? DEFAULT_CONTENT_PROFILE.id;
      const profile = profiles[profileId];

      if (profile === undefined) {
        return Promise.reject(new UnknownContentProfileError(profileId));
      }

      let service = services.get(profileId);

      if (service === undefined) {
        service = factory(profile);
        services.set(profileId, service);
        used.push(profileId);
      }

      return service.authorPage(request);
    },
  };
}
