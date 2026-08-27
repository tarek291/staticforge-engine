import { z } from "zod";

/**
 * The page content contract.
 *
 * This module defines what makes a page *structurally* valid — the invariants
 * that must hold for any page the engine will ever emit, in any locale, under
 * any template. Bounds here are universal: a route slug must be routable, a
 * title must fit a search result, no block may be blank.
 *
 * Quality policy — how long a good title is, how many sections a page needs,
 * which section kinds are allowed — is deliberately **not** here. That varies
 * between a minimal brochure site and a premium landing page, so it lives in
 * `content-profile.ts` as data rather than being frozen into the type.
 */

/** Supported content locales. */
export const LocaleSchema = z.enum(["de", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

/** Lowercase, dash-separated, no leading or trailing dash. */
export const PageSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Slug must be lowercase and dash-separated",
  );

/**
 * A usable link target.
 *
 * Accepts the forms a generated page actually needs: an in-page anchor, a
 * site-relative path, or an absolute `mailto:` / `tel:` / `http(s)` URL. A bare
 * word is rejected — it would render as a link that goes nowhere.
 */
export const LinkTargetSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      /^#[A-Za-z0-9._-]+$/.test(value) ||
      /^\/[^\s]*$/.test(value) ||
      /^(?:mailto:|tel:|https?:\/\/)[^\s]+$/.test(value),
    {
      message:
        'Must be an anchor ("#contact"), a site-relative path ("/kontakt"), or a mailto:, tel: or http(s) URL',
    },
  );

/** Hero block shown at the top of a generated page. */
export const HeroSchema = z.object({
  heading: z.string().min(1),
  subheading: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
});
export type Hero = z.infer<typeof HeroSchema>;

/**
 * What a section is *for*.
 *
 * Optional and without a default, so existing payloads are untouched and
 * generated output is unchanged. A {@link ContentProfile} decides whether a
 * kind is required and which kinds it permits.
 */
export const SectionKindSchema = z.enum([
  "overview",
  "process",
  "benefits",
  "pricing",
  "coverage",
  "trust",
  "custom",
]);
export type SectionKind = z.infer<typeof SectionKindSchema>;

/** A generic content section. */
export const SectionSchema = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
  kind: SectionKindSchema.optional(),
});
export type Section = z.infer<typeof SectionSchema>;

/** A single frequently-asked-question entry. */
export const FaqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});
export type FaqItem = z.infer<typeof FaqItemSchema>;

/** Call-to-action block. */
export const CtaSchema = z.object({
  heading: z.string().min(1),
  buttonLabel: z.string().min(1),
  href: LinkTargetSchema,
  // Optional secondary action (e.g. a tel: link). Backward compatible: absent
  // when not applicable; rendered by the views when present.
  secondary: z
    .object({
      buttonLabel: z.string().min(1),
      href: LinkTargetSchema,
    })
    .optional(),
});
export type Cta = z.infer<typeof CtaSchema>;

/**
 * Structured body content of a generated page.
 *
 * `sections` and `faq` require at least one entry: a landing page with no body
 * and no answers is not a thin page, it is an empty one. How *many* a good page
 * needs is a {@link ContentProfile} decision.
 */
export const PageContentSchema = z.object({
  hero: HeroSchema,
  sections: z.array(SectionSchema).min(1),
  faq: z.array(FaqItemSchema).min(1),
  cta: CtaSchema,
});
export type PageContent = z.infer<typeof PageContentSchema>;

/**
 * Arbitrary JSON-LD structured data object (schema.org).
 * Kept loose because the shape depends on the `@type` used.
 */
export const SchemaOrgSchema = z.record(z.string(), z.unknown());
export type SchemaOrg = z.infer<typeof SchemaOrgSchema>;

/**
 * Per-page search-engine policy.
 *
 * Only the parts a *person* decides live here. Canonical URLs, OpenGraph tags
 * and alternates are all derivable from the page and the site's base URL, so
 * storing them would be storing a computation — and a stale one the moment the
 * domain changes.
 *
 * What is not derivable is intent: whether this particular page should be
 * indexed at all. That is the operator's call, and it is what this block holds.
 */
export const PageSeoSchema = z.object({
  /** May this page appear in results? */
  index: z.boolean().default(true),
  /** May its links be followed? */
  follow: z.boolean().default(true),
  /**
   * Overrides the derived canonical URL.
   *
   * For a page that deliberately consolidates into another — a near-duplicate
   * kept for a campaign, say. Absent means "the canonical is my own URL".
   */
  canonical: z.string().min(1).optional(),
});
export type PageSeo = z.infer<typeof PageSeoSchema>;

/**
 * Why an internal link exists.
 *
 * A programmatic site is a grid of service × city. The two axes of that grid
 * are the only relations that are inherently justified: a reader on one page
 * either wants a different service in the same place, or the same service
 * somewhere else. A link that is neither is decoration.
 */
export const LinkRelationSchema = z.enum(["sameCity", "sameService"]);
export type LinkRelation = z.infer<typeof LinkRelationSchema>;

/**
 * A link from one generated page to another.
 *
 * Carries the target's `slug`, not a URL: routing is the web layer's business,
 * and baking a path in here would freeze the engine to one route shape.
 */
export const InternalLinkSchema = z.object({
  slug: PageSlugSchema,
  /** Visible text. Derived from the target page, so it needs no translation. */
  anchor: z.string().min(1),
  relation: LinkRelationSchema,
});
export type InternalLink = z.infer<typeof InternalLinkSchema>;

/**
 * Provenance of an authored page.
 *
 * Records *what produced this content*, so a later run can tell whether it is
 * still current without re-reading the page: which prompt wrote it, which model
 * answered, which quality policy judged it, and a fingerprint of the source
 * data it was written from. When any of those change, the page is stale.
 *
 * Absent on deterministic template pages — there is no model to attribute.
 */
export const PageGenerationSchema = z.object({
  /** Version of the prompt that produced this content. */
  promptVersion: z.string().min(1),
  /** Model that answered, e.g. "claude-opus-5". */
  modelVersion: z.string().min(1),
  /** Content profile the output was judged against. */
  profileId: z.string().min(1),
  /** Fingerprint of the business, service, location and content template. */
  sourceHash: z.string().min(1),
  /**
   * Fingerprint of the authored content itself.
   *
   * Distinct from sourceHash, which fingerprints the *inputs*. This one answers
   * a different question: did a rewrite actually change anything? A refresh
   * that returns identical prose is a wasted call, and without this the two
   * cases are indistinguishable.
   */
  contentHash: z.string().min(1).optional(),
  /** The feedback that produced this revision, when it came from a refresh. */
  refreshedFrom: z.string().min(1).optional(),
  /** ISO timestamp of the authoring run. */
  generatedAt: z.string().min(1).optional(),
});
export type PageGeneration = z.infer<typeof PageGenerationSchema>;

/** A fully resolved page ready to be rendered to static HTML. */
export const GeneratedPageSchema = z.object({
  // Routable by construction: the slug becomes a URL segment.
  slug: PageSlugSchema,
  locale: LocaleSchema,
  // Ceilings are what search engines truncate at, so they are structural.
  // Floors are quality policy and live in ContentProfile.
  title: z.string().min(1).max(70),
  metaDescription: z.string().min(1).max(160),
  h1: z.string().min(1).max(200),
  content: PageContentSchema,
  schemaOrg: SchemaOrgSchema,
  // Identifies which template renders this page. Defaults to "default" so
  // existing payloads without the field remain valid (backward compatible).
  //
  // Purely a *rendering* choice. It selects a view and nothing else — it does
  // not decide what the page must contain, how long its copy may be, or which
  // claims it may make.
  templateId: z.string().min(1).default("default"),
  // Identifies which content profile judged this page.
  //
  // Purely a *quality* choice, and deliberately independent of templateId: a
  // tenant may want a premium visual template over modest content, or a plain
  // template over content held to the strictest bar. Coupling the two would
  // make one of those combinations unreachable for no reason.
  contentProfileId: z.string().min(1).default("default"),
  businessId: z.string(),
  serviceId: z.string(),
  locationId: z.string(),
  // Present only on AI-authored pages. Optional and without a default, so
  // template output and every existing payload are unchanged.
  generation: PageGenerationSchema.optional(),
  // Contextual links to sibling pages. Defaults to empty rather than being
  // optional, so consumers never have to distinguish "no links" from "not yet
  // computed" — a distinction that has no meaning once a page is written.
  links: z.array(InternalLinkSchema).default([]),
  // Indexing policy. Optional and without a default, so every existing payload
  // is unchanged; absent means the site-wide default applies.
  seo: PageSeoSchema.optional(),
});
export type GeneratedPage = z.infer<typeof GeneratedPageSchema>;
