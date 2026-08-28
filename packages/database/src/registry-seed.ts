import type { Prisma, PrismaClient } from "@prisma/client";
import {
  CONTENT_PROFILES,
  TemplateDefinitionSchema,
  type TemplateDefinition,
} from "@staticforge/schemas";

import { GLOBAL_OWNER_ID } from "./registry.js";
import { withDbRetry } from "./retry.js";

/**
 * Publishing the shipped profiles and templates as global rows.
 *
 * Moving a registry into the database creates a moment that did not exist
 * before: an empty table. Every page names `contentProfileId: "default"`, and
 * on a database nobody has seeded that name resolves to nothing and every
 * build fails — for a project whose data is perfectly fine.
 *
 * So the constants do not disappear when the registry becomes dynamic. They
 * become the *seed*: the shipped definitions are written as global rows, and
 * from then on the runtime path reads rows and only rows. That is what "get rid
 * of the hardcoded registry" can actually mean without an unseeded deployment
 * being a broken one — the code stops being consulted at runtime, and stays the
 * origin of what the defaults are.
 *
 * Idempotent by construction: keyed upserts, so running it twice changes
 * nothing and running it after an upgrade republishes whatever the shipped
 * definitions now say.
 */

/**
 * The views the application registers, as template definitions.
 *
 * Kept here rather than read from the web app because a view is code and this
 * package cannot import React. The consequence is worth stating: adding a view
 * means adding it in both places, and a row naming a view the renderer does not
 * have fails loudly at render rather than silently falling back.
 */
const SHIPPED_TEMPLATES: Array<{
  key: string;
  name: string;
  definition: TemplateDefinition;
}> = [
  {
    key: "default",
    name: "Default",
    definition: {
      view: "default",
      description: "A clean, readable layout that suits any vertical.",
    },
  },
  {
    key: "luxuryLanding",
    name: "Luxury Landing",
    definition: {
      view: "luxuryLanding",
      description:
        "A dark, high-ticket landing page. Ships no client-side JavaScript.",
      options: { density: "comfortable", showFaq: true, showSecondaryCta: true },
    },
  },
];

/** What a seeding pass wrote. */
export interface RegistrySeedResult {
  profiles: string[];
  templates: string[];
}

/**
 * Write the shipped definitions as global rows.
 *
 * Global rather than owned: these are the defaults every tenant starts from,
 * and a tenant's own row with the same key overrides one without deleting it.
 *
 * @returns The keys published, so a caller can report what it did.
 */
export async function seedGlobalRegistry(
  prisma: PrismaClient,
): Promise<RegistrySeedResult> {
  const profiles: string[] = [];

  for (const [key, profile] of Object.entries(CONTENT_PROFILES)) {
    const definition = profile as unknown as Prisma.InputJsonObject;

    await withDbRetry(() =>
      prisma.contentProfile.upsert({
        where: { key_userId: { key, userId: GLOBAL_OWNER_ID } },
        create: {
          key,
          name: profile.description,
          definition,
          isGlobal: true,
          userId: GLOBAL_OWNER_ID,
        },
        update: { name: profile.description, definition, isGlobal: true },
      }),
    );

    profiles.push(key);
  }

  const templates: string[] = [];

  for (const template of SHIPPED_TEMPLATES) {
    // Parsed before it is written, not only when it is read. A seed that
    // published a malformed definition would turn the loader's fail-loud
    // behaviour into a permanently broken deployment.
    const parsed = TemplateDefinitionSchema.parse(template.definition);
    const definition = parsed as unknown as Prisma.InputJsonObject;

    await withDbRetry(() =>
      prisma.template.upsert({
        where: { key_userId: { key: template.key, userId: GLOBAL_OWNER_ID } },
        create: {
          key: template.key,
          name: template.name,
          definition,
          isGlobal: true,
          userId: GLOBAL_OWNER_ID,
        },
        update: { name: template.name, definition, isGlobal: true },
      }),
    );

    templates.push(template.key);
  }

  return { profiles, templates };
}
