import { ProjectIdSchema, jsonSyncAdapter } from "@staticforge/core";
import {
  AccessDeniedError,
  authorizeProjectAccess,
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
 * ## Authentication, as of Phase 25
 *
 * `Authorization: Bearer sf_org_…`. The key resolves to *one organization*, and
 * that is what replaced the single `STATICFORGE_WEBHOOK_SECRET` this route used
 * to trust. The old design had one value that authenticated the caller and said
 * nothing about which tenant they were — so anyone holding it could sync any
 * project the operator owned, which is exactly why it could never be handed to
 * a customer.
 *
 * Three checks, in this order, and the order is the point:
 *
 * 1. **Who is this?** The key resolves to an organization, or the request stops.
 * 2. **Is the project theirs?** The project's organization must be the key's.
 *    Answered before anything else touches the project, so a key cannot be used
 *    to discover which project ids exist outside its own tenant.
 * 3. **May they do this?** The key acts as a member of its organization, so the
 *    same `requireCapability` gate every other write passes runs unchanged. A
 *    key issued as a VIEWER is refused here exactly as a person would be.
 *
 * Not gated by a feature flag, and as of Phase 29 nothing else is either. The
 * local-only `STATICFORGE_DASHBOARD` switch existed because the dashboard's
 * control routes shipped no authentication; every route now authenticates, so
 * the flag protected nothing and has been removed. A flag is a deployment
 * convention, a gate is a check, and only one of them survives being forgotten.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
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

  // Authentication and the tenant boundary, before the payload is even parsed
  // and long before anything is written. The rule itself lives in
  // `@staticforge/database` so it can be tested without standing up a server;
  // this route only turns its verdict into a status code.
  const auth = await authorizeProjectAccess(
    request.headers.get("authorization"),
    parsedProjectId.data,
    prisma,
  );

  if (!auth.ok) {
    // `WWW-Authenticate` on a 401 because RFC 7235 requires it, and because it
    // tells an integrator which scheme to use without telling an attacker
    // anything they did not already know.
    return Response.json(
      { error: auth.error },
      auth.status === 401
        ? { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
        : { status: auth.status },
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

  let result: Awaited<ReturnType<typeof syncProject>>;

  try {
    result = await syncProject(
    parsedProjectId.data,
    // The key acts as itself, not as the operator. Every write it causes is
    // attributable to this credential in the audit trail, and revoking the key
    // removes the membership that let it through.
    auth.principal.userId,
    parsed.payload,
    prisma,
    {
      enqueueJob: async (project, owner, scope) => {
        // The scope travels with the job so the run re-authors only the pages
        // the change reached. Empty means a full run.
        const job = await enqueueJob(
          project,
          owner,
          "GENERATE",
          prisma,
          undefined,
          scope,
        );
        return job?.id ?? null;
      },
    },
    );
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      // Authenticating is not the same as being allowed. A key issued as a
      // VIEWER reaches this line and is refused, which is the whole reason keys
      // are members rather than a parallel permission path.
      //
      // 403 for a key whose role is too weak; 404 for one with no membership at
      // all, which reads the same as a project that is not there.
      return error.heldRole === null
        ? Response.json({ error: "Project not found." }, { status: 404 })
        : Response.json({ error: error.message }, { status: 403 });
    }

    throw error;
  }

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
