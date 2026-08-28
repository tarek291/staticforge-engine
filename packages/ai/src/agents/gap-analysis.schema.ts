import { z } from "zod";

/**
 * What the gap analyst is allowed to answer.
 *
 * The engine has held one line since the first authoring pass: the model
 * produces data and has no authority to accept it. An analyst is the first
 * place that line gets *harder*, because advice looks harmless. A recommended
 * page is not published, so a bad one seems to cost nothing — until an operator
 * acts on it, or a dashboard queues from it, and the recommendation turns out
 * to name a service that does not exist.
 *
 * So the same contract applies. The shape is pinned here; whether the
 * identifiers inside it are *real* is checked separately, because a schema
 * cannot tell an invented cuid from a genuine one.
 *
 * ## Why everything is bounded
 *
 * A model asked to list gaps will happily list five hundred. Every ceiling here
 * is a refusal to accept an answer nobody can act on: an operator reads a
 * shortlist, and an "analysis" that returns the entire cross-product has
 * analysed nothing.
 */

/** How strongly the analyst rates a recommendation. */
export const GapPrioritySchema = z.enum(["high", "medium", "low"]);
export type GapPriority = z.infer<typeof GapPrioritySchema>;

/**
 * One page the analyst thinks is worth creating.
 *
 * `serviceId` and `locationId` reference the project's own catalogue. They are
 * checked against it after parsing — a well-formed identifier that names
 * nothing is exactly what a hallucination looks like, and it passes every
 * shape check ever written.
 */
export const RecommendedPageSchema = z
  .object({
    serviceId: z.string().min(1),
    locationId: z.string().min(1),
    /**
     * Why this page is worth making.
     *
     * Required, and with a floor: a recommendation an operator cannot evaluate
     * is not a recommendation, it is a row. The floor is what stops "good
     * opportunity" being an acceptable answer.
     */
    rationale: z.string().min(40).max(600),
    priority: GapPrioritySchema,
  })
  .strict();
export type RecommendedPage = z.infer<typeof RecommendedPageSchema>;

/**
 * A service the business does not offer but perhaps should.
 *
 * Deliberately carries no id. These do not exist, so the model has nothing to
 * reference and cannot be asked to — which removes the only way it could
 * fabricate one here.
 */
export const SuggestedServiceSchema = z
  .object({
    name: z.string().min(2).max(80),
    /** What the service covers, in the operator's own market. */
    rationale: z.string().min(40).max(600),
    priority: GapPrioritySchema,
  })
  .strict();
export type SuggestedService = z.infer<typeof SuggestedServiceSchema>;

/**
 * The analyst's whole answer.
 *
 * `.strict()` throughout: an unknown key is either the model drifting from the
 * contract or an attempt to say something this schema declines to carry, and
 * both are worth an error rather than a shrug.
 */
export const GapAnalysisResponseSchema = z
  .object({
    /**
     * A short read on where the site stands.
     *
     * Bounded hard. This is the one free-text field, and without a ceiling it
     * is where a model puts the essay it was not asked for.
     */
    summary: z.string().min(40).max(1200),
    /** Pages worth creating, most valuable first. */
    recommendedPages: z.array(RecommendedPageSchema).max(50),
    /** Services worth adding to the catalogue. */
    suggestedNewServices: z.array(SuggestedServiceSchema).max(15),
  })
  .strict();
export type GapAnalysisResponse = z.infer<typeof GapAnalysisResponseSchema>;
