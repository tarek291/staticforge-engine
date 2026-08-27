import { z } from "zod";
import {
  GeneratedPageSchema,
  SectionKindSchema,
  type GeneratedPage,
  type SectionKind,
} from "./page.schema.js";

/**
 * Content quality policy, expressed as data.
 *
 * `GeneratedPageSchema` says what a page *is*. A profile says what a *good*
 * page is for a particular site: how long a title should be, how many sections
 * carry an argument, which section kinds belong on the page, which blocks may
 * not be skipped.
 *
 * The split matters because the two change for different reasons. Structural
 * rules are the engine's; quality rules belong to whoever owns the site, and a
 * SaaS tenant will eventually tune them from a dashboard. Freezing them into
 * the schema would make that a code change.
 *
 * A profile is checked *after* the page already satisfies the structural
 * contract, so profile issues are always about degree, never about shape.
 */

/** An inclusive numeric range. */
export const RangeSchema = z
  .object({
    min: z.number().int().nonnegative(),
    max: z.number().int().positive(),
  })
  .refine((range) => range.min <= range.max, {
    message: "min must not exceed max",
  });
export type Range = z.infer<typeof RangeSchema>;

/** Blocks a profile may require a page to carry. */
export const ContentBlockSchema = z.enum([
  "hero",
  "heroSubheading",
  "sections",
  "faq",
  "cta",
  "ctaSecondary",
  "schemaOrg",
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/** Rules applied to the `sections` array. */
export const SectionRulesSchema = z.object({
  /** How many sections a page must carry. */
  count: RangeSchema,
  heading: RangeSchema,
  body: RangeSchema,
  /** Section kinds this profile permits. Empty means every kind is allowed. */
  allowedKinds: z.array(SectionKindSchema).default([]),
  /** When true, every section must declare a `kind`. */
  requireKind: z.boolean().default(false),
  /** When true, two sections may not share a heading. */
  uniqueHeadings: z.boolean().default(true),
});
export type SectionRules = z.infer<typeof SectionRulesSchema>;

/** Rules applied to the `faq` array. */
export const FaqRulesSchema = z.object({
  count: RangeSchema,
  question: RangeSchema,
  answer: RangeSchema,
  /** When true, two entries may not ask the same question. */
  uniqueQuestions: z.boolean().default(true),
});
export type FaqRules = z.infer<typeof FaqRulesSchema>;

/** A complete content policy. */
export const ContentProfileSchema = z.object({
  /** Identifier a project references. */
  id: z.string().min(1),
  description: z.string().min(1),

  title: RangeSchema,
  metaDescription: RangeSchema,
  h1: RangeSchema,

  sections: SectionRulesSchema,
  faq: FaqRulesSchema,

  /** Blocks that must be present and non-empty. */
  requiredBlocks: z.array(ContentBlockSchema).default([]),

  /**
   * When true, `h1` must differ from `title`. They serve different readers —
   * the title is written for a search result, the h1 for the person who
   * arrived — so identical values usually mean one was never written.
   */
  requireDistinctH1: z.boolean().default(false),
});
export type ContentProfile = z.infer<typeof ContentProfileSchema>;

/**
 * What the deterministic template pipeline produces today.
 *
 * Loose on purpose: template assembly emits a single section built from the
 * service description, so this profile describes reality rather than an
 * aspiration. It is the floor, not the goal.
 */
export const DEFAULT_CONTENT_PROFILE: ContentProfile =
  ContentProfileSchema.parse({
    id: "default",
    description:
      "Baseline policy matching deterministic template output. Structural sanity only.",
    title: { min: 10, max: 70 },
    metaDescription: { min: 50, max: 160 },
    h1: { min: 10, max: 120 },
    sections: {
      count: { min: 1, max: 8 },
      heading: { min: 3, max: 120 },
      body: { min: 40, max: 4000 },
    },
    faq: {
      count: { min: 3, max: 12 },
      question: { min: 8, max: 200 },
      answer: { min: 20, max: 2000 },
    },
    requiredBlocks: ["hero", "sections", "faq", "cta", "schemaOrg"],
  });

/**
 * The bar an authored page is expected to clear.
 *
 * Tighter on every axis, and it demands the things that separate a page worth
 * ranking from a filled-in template: several sections that each make a distinct
 * argument, a declared purpose per section, a real answer set, and an h1 that
 * was written for the reader rather than copied from the title.
 */
export const STRICT_SEO_PROFILE: ContentProfile = ContentProfileSchema.parse({
  id: "strictSeo",
  description:
    "Quality bar for authored pages: multiple purposeful sections, substantive answers, distinct h1.",
  title: { min: 30, max: 65 },
  metaDescription: { min: 110, max: 158 },
  h1: { min: 20, max: 90 },
  sections: {
    count: { min: 3, max: 5 },
    heading: { min: 10, max: 90 },
    body: { min: 200, max: 2500 },
    allowedKinds: ["overview", "process", "benefits", "pricing", "coverage", "trust"],
    requireKind: true,
    uniqueHeadings: true,
  },
  faq: {
    count: { min: 4, max: 6 },
    question: { min: 15, max: 160 },
    answer: { min: 60, max: 1200 },
    uniqueQuestions: true,
  },
  requiredBlocks: [
    "hero",
    "heroSubheading",
    "sections",
    "faq",
    "cta",
    "schemaOrg",
  ],
  requireDistinctH1: true,
});

/** Every profile shipped with the engine, by id. */
export const CONTENT_PROFILES: Record<string, ContentProfile> = {
  [DEFAULT_CONTENT_PROFILE.id]: DEFAULT_CONTENT_PROFILE,
  [STRICT_SEO_PROFILE.id]: STRICT_SEO_PROFILE,
};

/** A single content-contract violation, addressed by field path. */
export interface ContentIssue {
  path: string;
  message: string;
}

/** Thrown when a page violates the contract. Carries every issue at once. */
export class ContentContractError extends Error {
  override readonly name = "ContentContractError";

  constructor(
    readonly profileId: string,
    readonly issues: ContentIssue[],
  ) {
    super(
      `Content contract "${profileId}" violated: ${issues.length} issue(s)`,
    );
  }
}

/** Record an issue when a string's length falls outside a range. */
function checkLength(
  value: string,
  range: Range,
  path: string,
  issues: ContentIssue[],
): void {
  if (value.length < range.min) {
    issues.push({
      path,
      message: `Too short: ${value.length} characters, minimum ${range.min}.`,
    });
  } else if (value.length > range.max) {
    issues.push({
      path,
      message: `Too long: ${value.length} characters, maximum ${range.max}.`,
    });
  }
}

/** Record an issue when a collection's size falls outside a range. */
function checkCount(
  size: number,
  range: Range,
  path: string,
  label: string,
  issues: ContentIssue[],
): void {
  if (size < range.min) {
    issues.push({
      path,
      message: `Too few ${label}: ${size}, minimum ${range.min}.`,
    });
  } else if (size > range.max) {
    issues.push({
      path,
      message: `Too many ${label}: ${size}, maximum ${range.max}.`,
    });
  }
}

/** Record an issue for each value that appears more than once. */
function checkUnique(
  values: string[],
  path: string,
  label: string,
  issues: ContentIssue[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = value.trim().toLowerCase();
    if (seen.has(key)) {
      issues.push({
        path: `${path}[${index}]`,
        message: `Duplicate ${label}: "${value}".`,
      });
    }
    seen.add(key);
  });
}

/** Whether a required block is present and carries something. */
function hasBlock(page: GeneratedPage, block: ContentBlock): boolean {
  switch (block) {
    case "hero":
      return page.content.hero.heading.trim().length > 0;
    case "heroSubheading":
      return (page.content.hero.subheading ?? "").trim().length > 0;
    case "sections":
      return page.content.sections.length > 0;
    case "faq":
      return page.content.faq.length > 0;
    case "cta":
      return page.content.cta.buttonLabel.trim().length > 0;
    case "ctaSecondary":
      return page.content.cta.secondary !== undefined;
    case "schemaOrg":
      return Object.keys(page.schemaOrg).length > 0;
  }
}

/** Collect the section-level issues for one page. */
function collectSectionIssues(
  page: GeneratedPage,
  rules: ContentProfile["sections"],
  issues: ContentIssue[],
): void {
  const { sections } = page.content;

  checkCount(sections.length, rules.count, "content.sections", "sections", issues);

  const allowed = new Set<SectionKind>(rules.allowedKinds);

  sections.forEach((section, index) => {
    const at = `content.sections[${index}]`;

    checkLength(section.heading, rules.heading, `${at}.heading`, issues);
    checkLength(section.body, rules.body, `${at}.body`, issues);

    if (rules.requireKind && section.kind === undefined) {
      issues.push({
        path: `${at}.kind`,
        message: `Missing section kind. Allowed: ${[...allowed].join(", ")}.`,
      });
    }

    if (
      section.kind !== undefined &&
      allowed.size > 0 &&
      !allowed.has(section.kind)
    ) {
      issues.push({
        path: `${at}.kind`,
        message: `Section kind "${section.kind}" is not allowed by this profile. Allowed: ${[...allowed].join(", ")}.`,
      });
    }
  });

  if (rules.uniqueHeadings) {
    checkUnique(
      sections.map((section) => section.heading),
      "content.sections",
      "section heading",
      issues,
    );
  }
}

/** Collect the FAQ-level issues for one page. */
function collectFaqIssues(
  page: GeneratedPage,
  rules: ContentProfile["faq"],
  issues: ContentIssue[],
): void {
  const { faq } = page.content;

  checkCount(faq.length, rules.count, "content.faq", "FAQ entries", issues);

  faq.forEach((item, index) => {
    const at = `content.faq[${index}]`;
    checkLength(item.question, rules.question, `${at}.question`, issues);
    checkLength(item.answer, rules.answer, `${at}.answer`, issues);
  });

  if (rules.uniqueQuestions) {
    checkUnique(
      faq.map((item) => item.question),
      "content.faq",
      "question",
      issues,
    );
  }
}

/**
 * Check a page against a profile, collecting every violation.
 *
 * Returns rather than throws, so several pages can be checked before anything
 * fails — the same collect-then-throw split the generator's input validation
 * uses.
 *
 * Assumes `page` already satisfies `GeneratedPageSchema`; use
 * {@link validatePageContent} when the input is untrusted.
 *
 * @param page - A structurally valid page.
 * @param profile - The policy to apply.
 * @returns Every issue found, in document order. Empty means the page passes.
 */
export function collectContentIssues(
  page: GeneratedPage,
  profile: ContentProfile,
): ContentIssue[] {
  const issues: ContentIssue[] = [];

  checkLength(page.title, profile.title, "title", issues);
  checkLength(page.metaDescription, profile.metaDescription, "metaDescription", issues);
  checkLength(page.h1, profile.h1, "h1", issues);

  if (profile.requireDistinctH1 && page.h1.trim() === page.title.trim()) {
    issues.push({
      path: "h1",
      message:
        "h1 duplicates the title. The title is written for a search result, the h1 for the reader who arrived.",
    });
  }

  collectSectionIssues(page, profile.sections, issues);
  collectFaqIssues(page, profile.faq, issues);

  for (const block of profile.requiredBlocks) {
    if (!hasBlock(page, block)) {
      issues.push({
        path: `content.${block}`,
        message: `Required block "${block}" is missing or empty under profile "${profile.id}".`,
      });
    }
  }

  return issues;
}

/**
 * Validate untrusted input against both the structural contract and a profile.
 *
 * Structure is checked first: a payload that is not a page cannot meaningfully
 * be judged for quality, so profile checks are skipped when the shape fails and
 * the schema's own issues are reported instead.
 *
 * @param input - Unknown data claiming to be a generated page.
 * @param profile - The policy to apply. Defaults to {@link DEFAULT_CONTENT_PROFILE}.
 * @returns The parsed page on success, or every issue found.
 */
export function validatePageContent(
  input: unknown,
  profile: ContentProfile = DEFAULT_CONTENT_PROFILE,
):
  | { ok: true; page: GeneratedPage }
  | { ok: false; issues: ContentIssue[] } {
  const parsed = GeneratedPageSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    };
  }

  const issues = collectContentIssues(parsed.data, profile);

  return issues.length === 0
    ? { ok: true, page: parsed.data }
    : { ok: false, issues };
}

/**
 * Validate untrusted input, throwing on any violation.
 *
 * @throws {ContentContractError} With every issue found.
 */
export function assertValidPageContent(
  input: unknown,
  profile: ContentProfile = DEFAULT_CONTENT_PROFILE,
): GeneratedPage {
  const result = validatePageContent(input, profile);

  if (!result.ok) {
    throw new ContentContractError(profile.id, result.issues);
  }

  return result.page;
}
