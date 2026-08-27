import {
  DEFAULT_CONTENT_PROFILE,
  type ContentProfile,
  type SectionKind,
} from "@staticforge/schemas";
import { sleep } from "@staticforge/core";

import { PROMPT_VERSION } from "./prompts.js";
import type {
  AuthoredContent,
  GeneratedPageContent,
  GenerationRequest,
  RefreshRequest,
} from "./service.js";

/**
 * A stand-in for the authoring service that costs nothing.
 *
 * Built for load testing, not for output quality. Five hundred real authoring
 * calls is a four-figure bill and half an hour of pacing delay; the thing under
 * test at that scale is the architecture — memory, the link graph, slug
 * uniqueness, sitemap generation — none of which cares what the prose says.
 *
 * What it does still exercise, and deliberately: the content is generated to
 * satisfy the *actual* `ContentProfile`, so a page that would be rejected in
 * production is rejected here too, and every downstream gate runs for real.
 * Latency is simulated with jitter so the pacing and progress paths behave as
 * they would against a live provider rather than resolving instantly.
 */

/** Options for {@link createMockService}. */
export interface MockServiceOptions {
  /** Profile the generated content must satisfy. */
  profile?: ContentProfile;
  /** Mean simulated latency per call, in milliseconds. Default 2. */
  latencyMs?: number;
  /** Fraction of `latencyMs` to vary by, 0–1. Default 0.5. */
  jitter?: number;
  /** Injected so tests do not wait in real time. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injected for deterministic jitter. */
  random?: () => number;
  /** Reported as the model on every page's provenance. */
  modelVersion?: string;
}

/** Pad text to at least `min` characters without producing a wall of one letter. */
function padTo(seed: string, min: number): string {
  if (seed.length >= min) {
    return seed;
  }
  const filler = ` ${seed}`;
  let out = seed;
  while (out.length < min) {
    out += filler;
  }
  return out.slice(0, Math.max(min, seed.length));
}

/** Trim text to at most `max` characters, without cutting mid-word where possible. */
function clampTo(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
}

/** Fit text inside a profile range. */
function fit(text: string, range: { min: number; max: number }): string {
  return clampTo(padTo(text, range.min), range.max);
}

/**
 * Build dummy content that satisfies a profile.
 *
 * Every field is sized from the profile's own ranges rather than from constants,
 * so tightening the profile tightens the mock — the two cannot drift into a mock
 * that passes gates the real service would fail.
 */
export function buildMockContent(
  request: GenerationRequest,
  profile: ContentProfile = DEFAULT_CONTENT_PROFILE,
): GeneratedPageContent {
  const { serviceName, cityName, businessName } = request;
  const tag = `${serviceName} ${cityName}`;

  const kinds: SectionKind[] =
    profile.sections.allowedKinds.length > 0
      ? profile.sections.allowedKinds
      : ["overview", "process", "benefits", "pricing", "coverage", "trust"];

  const sections = Array.from(
    { length: profile.sections.count.min },
    (_unused, index) => ({
      heading: fit(`${tag} ${index + 1}`, profile.sections.heading),
      body: fit(`${tag} body ${index + 1}.`, profile.sections.body),
      ...(profile.sections.requireKind
        ? { kind: kinds[index % kinds.length] as SectionKind }
        : {}),
    }),
  );

  const faq = Array.from(
    { length: profile.faq.count.min },
    (_unused, index) => ({
      question: fit(`${tag} q${index + 1}?`, profile.faq.question),
      answer: fit(`${tag} a${index + 1}.`, profile.faq.answer),
    }),
  );

  return {
    // The h1 differs from the title, since a profile may require it.
    title: fit(`${tag} — ${businessName}`, profile.title),
    metaDescription: fit(`${tag} meta.`, profile.metaDescription),
    h1: fit(`${tag} heading`, profile.h1),
    content: {
      hero: {
        heading: fit(tag, { min: 1, max: 200 }),
        subheading: fit(`${tag} sub.`, { min: 1, max: 300 }),
      },
      sections,
      faq,
      cta: {
        heading: fit(`${tag} cta`, { min: 1, max: 200 }),
        buttonLabel: "→",
        href: "#contact",
      },
    },
  };
}

/** The subset of the service the generator actually calls. */
export interface AuthoringService {
  authorPage(request: GenerationRequest): Promise<AuthoredContent>;
  /** Revise an existing page. The mock ignores the feedback by design. */
  refreshPage(request: RefreshRequest): Promise<AuthoredContent>;
}

/**
 * A no-cost authoring service for load testing.
 *
 * The provenance it reports carries an unmistakable model version, so pages
 * produced this way can never be confused for real output in a database or a
 * dashboard.
 */
export function createMockService(
  options: MockServiceOptions = {},
): AuthoringService {
  const {
    profile = DEFAULT_CONTENT_PROFILE,
    latencyMs = 2,
    jitter = 0.5,
    sleepFn = sleep,
    random = Math.random,
    modelVersion = "mock",
  } = options;

  const author = async (request: GenerationRequest): Promise<AuthoredContent> => {
      // Jittered latency, so pacing and progress behave as they would against a
      // real provider instead of resolving in the same tick.
      const spread = latencyMs * jitter;
      await sleepFn(Math.max(0, latencyMs - spread + random() * spread * 2));

    return {
      content: buildMockContent(request, profile),
      provenance: {
        promptVersion: PROMPT_VERSION,
        modelVersion,
        profileId: profile.id,
        sourceHash: request.cacheIdentity?.sourceHash,
        cacheHit: false,
      },
    };
  };

  return {
    authorPage: author,
    // A mock cannot act on feedback, and pretending otherwise would make a
    // refresh test pass for the wrong reason. It regenerates instead, which is
    // enough to exercise every gate and every merge rule around it.
    refreshPage: (request: RefreshRequest) => author(request),
  };
}

/** Whether the run should author with the mock instead of a real provider. */
export function isMockAiEnabled(): boolean {
  return process.env.AI_MOCK === "true";
}
