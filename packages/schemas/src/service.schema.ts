import { z } from "zod";

/** Optional price range for a service. */
export const PricingSchema = z.object({
  from: z.number().nonnegative(),
  to: z.number().nonnegative(),
  currency: z.string().min(1).default("EUR"),
});
export type Pricing = z.infer<typeof PricingSchema>;

/** A service offered by a business. */
export const ServiceSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  slug: z
    .string()
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug must be lowercase and dash-separated",
    ),
  description: z.string().min(100),
  benefits: z.array(z.string().min(1)).min(3),
  pricing: PricingSchema.optional(),
  // Optional per-service template override. Absent → the generator falls back
  // to the content-level default. Empty string is rejected.
  templateId: z.string().min(1).optional(),
  // Optional per-service content-profile override, resolved by the same
  // precedence. Deliberately separate from templateId: one decides how a page
  // looks, the other what counts as good enough to publish. A tenant may want
  // a premium visual template on modest content, or the reverse.
  contentProfileId: z.string().min(1).optional(),
});
export type Service = z.infer<typeof ServiceSchema>;
