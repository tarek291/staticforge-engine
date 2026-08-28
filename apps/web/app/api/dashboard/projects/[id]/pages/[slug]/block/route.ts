import { ProjectIdSchema } from "@staticforge/core";
import {
  LOCAL_OPERATOR_ID,
  getPageForUser,
  getProjectPayload,
  prisma,
  saveRefreshedPage,
} from "@staticforge/database";
import { patchPageContent, validateInputData } from "@staticforge/generator";
import { GeneratedPageSchema, PageSlugSchema } from "@staticforge/schemas";

import {
  dashboardDisabledResponse,
  isDashboardEnabled,
} from "@/lib/dashboard/guard";

/**
 * Replace one block of a published page.
 *
 * The endpoint a visual editor talks to. It does almost nothing itself, which
 * is the point: the decision about whether an edit may be published lives in
 * `patchPageContent`, where it can be tested without a request, and this route
 * loads, calls, and persists on success.
 *
 * ## Why a fragment is checked as hard as a whole page
 *
 * A patch arrives small and *looks* too small to be dangerous. It is not: an
 * editor that clears a required heading sends a perfectly well-formed request,
 * and a person typing a phone number into a text box is exactly as unverified
 * as a model inventing one. So the merged page goes through the structural
 * contract, the quality profile and the verified record, and a failure at any
 * of them discards the patch whole. Nothing is written on a rejection — the
 * page the editor was looking at is the page that stays published.
 */
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; slug: string }>;
}

export async function PATCH(
  request: Request,
  context: Context,
): Promise<Response> {
  if (!isDashboardEnabled()) {
    return dashboardDisabledResponse();
  }

  const { id, slug } = await context.params;

  const parsedProjectId = ProjectIdSchema.safeParse(id);

  if (!parsedProjectId.success) {
    return Response.json({ error: "Invalid project id." }, { status: 400 });
  }

  if (!PageSlugSchema.safeParse(slug).success) {
    return Response.json({ error: "Invalid page slug." }, { status: 400 });
  }

  const body: unknown = await request.json().catch(() => undefined);

  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Expected a JSON object body." }, { status: 400 });
  }

  const { blockPath, value } = body as { blockPath?: unknown; value?: unknown };

  if (typeof blockPath !== "string" || blockPath.trim().length === 0) {
    return Response.json(
      {
        error:
          'blockPath is required, e.g. "content.faq.0.answer" or "content.hero.heading".',
      },
      { status: 400 },
    );
  }

  if (value === undefined) {
    // Distinct from `null`, which is a value a patch could legitimately send
    // and which the schema gate would then refuse on its own terms.
    return Response.json(
      { error: "value is required. Send the new content for that block." },
      { status: 400 },
    );
  }

  // Both reads are scoped to the operator, and both answer `null` for a project
  // that is not theirs — the same answer a project that does not exist gives.
  const stored = await getPageForUser(
    parsedProjectId.data,
    slug,
    LOCAL_OPERATOR_ID,
    prisma,
  );

  if (stored === null) {
    return Response.json({ error: "Page not found." }, { status: 404 });
  }

  const payload = await getProjectPayload(
    parsedProjectId.data,
    LOCAL_OPERATOR_ID,
    prisma,
  ).catch(() => null);

  const business = payload?.businesses[0];

  if (payload === null || business === undefined) {
    return Response.json({ error: "Page not found." }, { status: 404 });
  }

  // The page row carries no businessId — a project has exactly one business —
  // so it is restored from the payload rather than stored twice.
  const page = GeneratedPageSchema.safeParse({
    ...stored,
    businessId: business.id,
  });

  if (!page.success) {
    return Response.json(
      { error: "The stored page does not satisfy the page contract." },
      { status: 409 },
    );
  }

  const input = validateInputData({
    businesses: payload.businesses,
    services: payload.services,
    locations: payload.locations,
    content: payload.content,
  });

  const result = patchPageContent(page.data, input, blockPath, value);

  if (!result.ok) {
    // 422, not 400: the request was well-formed and the *content* was refused.
    // The stage tells an editor which standard it fell short of, which is the
    // difference between a message it can act on and "invalid".
    return Response.json(
      { error: `The edit was refused at the ${result.stage} gate.`, stage: result.stage, issues: result.issues },
      { status: 422 },
    );
  }

  if (!result.changed) {
    // Nothing to write, and saying so beats reporting a save that changed
    // nothing — an editor showing "saved" for a no-op teaches the wrong thing
    // about what the button does.
    return Response.json({ changed: false, contentHash: result.contentHash });
  }

  const written = await saveRefreshedPage(
    parsedProjectId.data,
    {
      slug,
      title: result.page.title,
      metaDescription: result.page.metaDescription,
      h1: result.page.h1,
      content: result.page.content,
      schemaOrg: result.page.schemaOrg,
      generation: {
        ...(result.page.generation ?? {
          promptVersion: "manual",
          modelVersion: "manual",
          profileId: result.page.contentProfileId,
          sourceHash: "manual",
        }),
        contentHash: result.contentHash,
        generatedAt: new Date().toISOString(),
      },
    },
    LOCAL_OPERATOR_ID,
    prisma,
  );

  if (!written) {
    // The scoped read above found the page, so reaching here means it moved or
    // changed hands mid-request.
    return Response.json({ error: "Page not found." }, { status: 404 });
  }

  // `saveRefreshedPage` stamps `source: MANUAL`, which is what arms the
  // protection built in Phase 13: a later generation run leaves this page
  // exactly as the editor left it rather than overwriting the edit.
  return Response.json({
    changed: true,
    previousContentHash: result.previousContentHash,
    contentHash: result.contentHash,
    source: "MANUAL",
  });
}
