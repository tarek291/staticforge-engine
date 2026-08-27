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
  templateId: z.string().min(1).default("default"),
  businessId: z.string(),
  serviceId: z.string(),
  locationId: z.string(),
});
export type GeneratedPage = z.infer<typeof GeneratedPageSchema>;
