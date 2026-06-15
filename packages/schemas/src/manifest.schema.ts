import { z } from "zod";
import { GeneratedPageSchema } from "./page.schema.js";

/**
 * A single manifest entry — a summary slice of a generated page. Derived from
 * {@link GeneratedPageSchema} so the field shapes (incl. locale) stay aligned.
 */
export const ManifestEntrySchema = GeneratedPageSchema.pick({
  slug: true,
  locale: true,
  title: true,
  metaDescription: true,
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

/**
 * Shape of `data/output/manifest.json`: a count and the entry list. `count`
 * must be a non-negative integer and must equal `pages.length`.
 */
export const ManifestSchema = z
  .object({
    count: z.number().int().nonnegative(),
    pages: z.array(ManifestEntrySchema),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.count !== manifest.pages.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["count"],
        message: `count (${manifest.count}) does not match pages.length (${manifest.pages.length})`,
      });
    }
  });
export type Manifest = z.infer<typeof ManifestSchema>;
