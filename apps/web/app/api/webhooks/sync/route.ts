import {
  ProjectIdSchema,
  jsonSyncAdapter,
  verifyWebhookToken,
  webhookAuthStatus,
  WEBHOOK_SECRET_ENV_VAR,
} from "@staticforge/core";
import {
  LOCAL_OPERATOR_ID,
  describeSyncDiff,
  enqueueJob,
  prisma,
  syncProject,
} from "@staticforge/database";

/**
 * The push half of the sync layer.
 *
 * A system that already knows when its data changed says so, instead of the
 * engine asking on a timer. Everything after the authentication is the same
 * code the `sync` command runs — one adapter, one comparison, one write path —
 * because a webhook that accepted data the CLI would reject, or that skipped
 * the change check, would be a second definition of what a sync is.
 *
 * ## What this endpoint is not gated by
 *
 * Not by `STATICFORGE_DASHBOARD`. That guard exists because the dashboard's
 * control routes ship no authentication at all; this one does, and gating a
 * webhook behind a local-only flag would make it useless for the thing it is
 * for. It fails closed instead: with no secret configured it refuses every
 * call, including the first.
 *
 * ## The limit worth stating plainly
 *
 * One shared secret authenticates the *caller*, not a tenant. Until per-project
 * secrets exist, anyone holding this value can sync any project the operator
 * owns — so it is one trust domain, and it is not ready to be handed to a
 * customer. Writes are scoped to the operator all the same, so the blast radius
 * stops at that boundary rather than at the whole table.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = verifyWebhookToken(
    request.headers.get("authorization"),
    process.env[WEBHOOK_SECRET_ENV_VAR],
  );

  if (!auth.ok) {
    return Response.json(
      { error: auth.message },
      { status: webhookAuthStatus(auth.reason) },
    );
  }

  const body: unknown = await request.json().catch(() => undefined);

  if (body === undefined || typeof body !== "object" || body === null) {
    return Response.json(
      { error: "Expected a JSON object body." },
      { status: 400 },
    );
  }

  const { projectId, ...data } = body as Record<string, unknown>;

  const parsedProjectId = ProjectIdSchema.safeParse(projectId);

  if (!parsedProjectId.success) {
    return Response.json(
      {
        error:
          "projectId is required, and must be 1-64 characters of A-Z, a-z, " +
          "0-9, underscore or dash.",
      },
      { status: 400 },
    );
  }

  const parsed = jsonSyncAdapter.parse(data);

  if (!parsed.ok) {
    // Every problem at once: a caller fixing a payload should need one round
    // trip, not one per bad field.
    return Response.json(
      { error: "The payload does not satisfy the contract.", issues: parsed.issues },
      { status: 422 },
    );
  }

  const result = await syncProject(
    parsedProjectId.data,
    LOCAL_OPERATOR_ID,
    parsed.payload,
    prisma,
    {
      enqueueJob: async (project, owner) => {
        const job = await enqueueJob(project, owner, "GENERATE", prisma);
        return job?.id ?? null;
      },
    },
  );

  if (result === null) {
    // Deliberately indistinguishable from "no such project", so an
    // authenticated caller still cannot enumerate ids it was not given.
    return Response.json({ error: "Project not found." }, { status: 404 });
  }

  if (!result.changed) {
    // 200, not 202: the call succeeded and there is nothing to wait for. A 202
    // would tell a caller to poll for a job that was never created.
    return Response.json({
      changed: false,
      queued: false,
      summary: "no changes",
      detail: result.note,
    });
  }

  return Response.json(
    {
      changed: true,
      queued: result.jobId !== null,
      jobId: result.jobId,
      summary: describeSyncDiff(result.diff),
      diff: result.diff,
    },
    { status: 202 },
  );
}
