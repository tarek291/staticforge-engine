import { GeneratedPageSchema } from "@staticforge/schemas";
import type { z } from "zod";

/**
 * The authored slice of a generated page.
 *
 * Derived from `GeneratedPageSchema` with `.pick()` — the same derivation
 * pattern `ManifestEntrySchema` uses — so the two stay aligned automatically.
 *
 * The omitted fields are deliberately not the model's to decide: `slug` is
 * derived from service + city by the generator (and guarded against
 * collisions), `businessId` / `serviceId` / `locationId` are input-data
 * identifiers the model never sees, `locale` comes from the input, and
 * `templateId` is resolved by the service → content → "default" precedence.
 * Asking the model for them would only invite plausible-looking fabrications.
 *
 * ## Why this is its own module
 *
 * Both the service and the cache have to parse against it. The service owns the
 * gates; the cache has to re-check what it reads back off disk, because a
 * stored entry skips those gates by design. Leaving the schema in the service
 * would make the cache import the service and the service import the cache — a
 * cycle whose failure mode is a module-evaluation order bug, which is a far
 * worse thing to debug than this file is to read.
 */
export const GeneratedPageContentSchema = GeneratedPageSchema.pick({
  title: true,
  metaDescription: true,
  h1: true,
  content: true,
});

export type GeneratedPageContent = z.infer<typeof GeneratedPageContentSchema>;
