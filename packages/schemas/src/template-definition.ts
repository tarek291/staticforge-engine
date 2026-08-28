import { z } from "zod";

/**
 * What a stored template is allowed to say.
 *
 * ## The line this schema exists to hold
 *
 * A template row makes presentation configurable without a deploy. It does not,
 * and must not, make presentation *programmable* from the database. A
 * definition names a view that already exists in code and configures it; it
 * cannot introduce a new one.
 *
 * That boundary is the whole security story of the feature. A "template" that
 * carried markup, expressions or component code from a row into a React tree
 * would be remote code execution with a marketplace's branding on it, and no
 * amount of validating the JSON around such a field would recover the
 * situation — the dangerous part would be the field itself.
 *
 * So the trade is stated plainly: selling a template means selling a
 * configuration, and a genuinely new *look* remains a code change. That is a
 * smaller product than "upload your own template", and it is the version that
 * can be handed to strangers.
 *
 * ## Why `.strict()`
 *
 * An unknown key in a definition is not a harmless extra. It is either a typo,
 * in which case the tenant's intent is silently dropped, or an attempt to reach
 * a capability this schema declines to offer. Both deserve an error rather than
 * a shrug.
 */

/** A CSS colour, loose enough to be useful and tight enough to be a colour. */
const ColorSchema = z
  .string()
  .regex(
    /^(#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|[a-zA-Z]+)$/,
    "Must be a hex colour, an rgb() value, or a CSS colour keyword",
  );

/**
 * Presentation options a view may honour.
 *
 * Every field is optional and every one is a *value*, never a fragment of
 * markup or a class list: a view decides what a colour or a density means, and
 * a definition cannot smuggle styling instructions past it.
 */
export const TemplateOptionsSchema = z
  .object({
    /** Accent colour the view applies to links, buttons and rules. */
    accentColor: ColorSchema.optional(),
    /** How tightly the view packs its sections. */
    density: z.enum(["comfortable", "compact"]).optional(),
    /** Whether the view renders the FAQ block at all. */
    showFaq: z.boolean().optional(),
    /** Whether the view renders the secondary call to action. */
    showSecondaryCta: z.boolean().optional(),
    /**
     * Order the view lays its sections out in.
     *
     * Names of blocks, not markup. A view that does not know a name ignores it
     * rather than rendering it.
     */
    sectionOrder: z
      .array(z.enum(["hero", "sections", "faq", "cta"]))
      .max(4)
      .optional(),
  })
  .strict();
export type TemplateOptions = z.infer<typeof TemplateOptionsSchema>;

/**
 * A stored template's definition.
 *
 * `view` is the join back to code. It names a component the application has
 * registered; a row naming anything else resolves to nothing and the build
 * fails loudly, which is the same guarantee the hardcoded registry gave.
 */
export const TemplateDefinitionSchema = z
  .object({
    /**
     * Which registered view renders this template.
     *
     * Constrained to an identifier shape rather than any string: this value is
     * looked up in a registry, and a value that cannot be an identifier is a
     * mistake worth catching here rather than at render.
     */
    view: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z][A-Za-z0-9]*$/,
        "A view name is a plain identifier, e.g. \"default\" or \"luxuryLanding\"",
      ),
    /** One line, shown wherever a tenant picks a template. */
    description: z.string().min(1).max(280).optional(),
    options: TemplateOptionsSchema.optional(),
  })
  .strict();
export type TemplateDefinition = z.infer<typeof TemplateDefinitionSchema>;

/**
 * A stored row, as a lookup returns it.
 *
 * Kept separate from the definition because the two are validated for different
 * reasons: the row's shape is the database's business, and the definition's is
 * the engine's.
 */
export const StoredTemplateSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  definition: TemplateDefinitionSchema,
});
export type StoredTemplate = z.infer<typeof StoredTemplateSchema>;
