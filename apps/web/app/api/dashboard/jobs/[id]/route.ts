import { getJobForUser, prisma } from "@staticforge/database";

import { requireApiAuth } from "@/lib/auth";

/**
 * Poll one job's status and logs.
 *
 * A job log carries a tenant's project ids, page slugs and engine output, so
 * this is a tenant read like any other and is scoped to the caller who proved
 * who they are. A job belonging to someone else answers `404` — the same answer
 * as a job that does not exist, because two answers would let anyone holding a
 * job id confirm it is real.
 */
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: Context,
): Promise<Response> {
  const auth = await requireApiAuth(request, "jobs/[id]");

  if (!auth.ok) {
    return auth.response;
  }

  const { id } = await context.params;
  const job = await getJobForUser(id, auth.principal.userId, prisma);

  if (job === null) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  return Response.json(job);
}
