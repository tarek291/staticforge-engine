import { z } from "zod";

/** Supported content locales. */
export const LocaleSchema = z.enum(["de", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

/** Hero block shown at the top of a generated page. */
export const HeroSchema = z.object({
  heading: z.string().min(1),
  subheading: z.string().optional(),
  image: z.string().optional(),
});
export type Hero = z.infer<typeof HeroSchema>;

/** A generic content section. */
export const SectionSchema = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
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
  href: z.string().min(1),
  // Optional secondary action (e.g. a tel: link). Backward compatible: absent
  // when not applicable. Not rendered by the views yet.
  secondary: z
    .object({
      buttonLabel: z.string().min(1),
      href: z.string().min(1),
    })
    .optional(),
});
export type Cta = z.infer<typeof CtaSchema>;

/** Structured body content of a generated page. */
export const PageContentSchema = z.object({
  hero: HeroSchema,
  sections: z.array(SectionSchema),
  faq: z.array(FaqItemSchema),
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
  slug: z.string(),
  locale: LocaleSchema,
  title: z.string().max(70),
  metaDescription: z.string().max(160),
  h1: z.string().min(1),
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
