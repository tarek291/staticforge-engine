import type Anthropic from "@anthropic-ai/sdk";
import { GeneratedPageSchema } from "@staticforge/schemas";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { getAnthropicClient } from "./client.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";
import type { PagePromptDetails } from "./prompts.js";

/**
 * The authored slice of a generated page.
 *
 * Derived from `GeneratedPageSchema` with `.pick()` — the same derivation
 * pattern `ManifestEntrySchema` uses — so the two stay aligned automatically:
 * a change to `title`, `metaDescription`, `h1`, or `content` upstream applies
 * here without edits.
 *
 * The omitted fields are deliberately not the model's to decide:
 * `slug` is derived from service + city by the generator (and guarded against
 * collisions), `businessId` / `serviceId` / `locationId` are input-data
 * identifiers the model never sees, `locale` comes from the input, and
 * `templateId` is resolved by the service → content → "default" precedence.
 * Asking the model for them would only invite plausible-looking fabrications.
 */
export const GeneratedPageContentSchema = GeneratedPageSchema.pick({
  title: true,
  metaDescription: true,
  h1: true,
  content: true,
});
export type GeneratedPageContent = z.infer<typeof GeneratedPageContentSchema>;

/** Model used for content generation. */
const MODEL = "claude-opus-5";

/** Name of the tool the model must call to return its answer. */
const TOOL_NAME = "emit_page_content";

/**
 * The Zod contract, expressed as JSON Schema for the Anthropic tool.
 *
 * `$refStrategy: "none"` inlines every sub-schema, because the API expects one
 * self-contained schema object rather than a `$ref` / `definitions` graph.
 * The generated `$schema` key is dropped for the same reason.
 *
 * Note that `strict: true` is intentionally not set on the tool: strict mode
 * requires every property to appear in `required`, which the optional fields
 * in `content` (`hero.subheading`, `hero.image`, `cta.secondary`) cannot
 * satisfy. The JSON Schema steers the model; `GeneratedPageContentSchema.parse`
 * below is what actually guarantees the shape.
 */
const TOOL_INPUT_SCHEMA = ((): Anthropic.Tool["input_schema"] => {
  const { $schema, ...schema } = zodToJsonSchema(GeneratedPageContentSchema, {
    $refStrategy: "none",
  }) as Record<string, unknown> & { $schema?: string };

  void $schema;

  return schema as Anthropic.Tool["input_schema"];
})();

/**
 * Generates validated page content for one service-in-city combination.
 *
 * Fails loudly — consistent with the rest of the engine — when the model
 * returns no tool call, or when its arguments do not satisfy the schema.
 *
 * @throws when `ANTHROPIC_API_KEY` is unset, when the model returns no tool
 * call, or when the returned arguments fail Zod validation.
 */
export async function generatePageContent(
  details: PagePromptDetails,
): Promise<GeneratedPageContent> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Return the authored landing page content. This is the only way to deliver an answer.",
        input_schema: TOOL_INPUT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME, disable_parallel_tool_use: true },
    messages: [{ role: "user", content: buildUserPrompt(details) }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === "tool_use" && block.name === TOOL_NAME,
  );

  if (toolUse === undefined) {
    throw new Error(
      `Model did not call "${TOOL_NAME}" (stop_reason: ${String(response.stop_reason)}).`,
    );
  }

  return GeneratedPageContentSchema.parse(toolUse.input);
}
