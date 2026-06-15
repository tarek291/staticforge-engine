import { z } from "zod";

/** Geographic coordinates. */
export const CoordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type Coordinates = z.infer<typeof CoordinatesSchema>;

/** A geographic location a business serves. */
export const LocationSchema = z.object({
  id: z.string(),
  city: z.string().min(1),
  state: z.string().min(1),
  country: z.string().min(1).default("DE"),
  postalCode: z.string().optional(),
  coordinates: CoordinatesSchema.optional(),
});
export type Location = z.infer<typeof LocationSchema>;
