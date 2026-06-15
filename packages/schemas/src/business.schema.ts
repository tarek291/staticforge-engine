import { z } from "zod";

/** Allowed business verticals supported by the engine. */
export const NicheSchema = z.enum([
  "cleaning",
  "moving",
  "handyman",
  "coaching",
  "security",
]);
export type Niche = z.infer<typeof NicheSchema>;

/** Physical address of a business. */
export const AddressSchema = z.object({
  street: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().min(1).default("DE"),
});
export type Address = z.infer<typeof AddressSchema>;

/** A slug: lowercase letters, digits and dashes only (no leading/trailing dash). */
const slugString = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Slug must be lowercase and dash-separated",
  );

/** Top-level business entity that owns services and locations. */
export const BusinessSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(2).max(100),
  slug: slugString,
  niche: NicheSchema,
  description: z.string().min(50).max(500),
  foundedYear: z.number().int().optional(),
  contactEmail: z.string().email(),
  contactPhone: z.string().min(1),
  address: AddressSchema,
});
export type Business = z.infer<typeof BusinessSchema>;
