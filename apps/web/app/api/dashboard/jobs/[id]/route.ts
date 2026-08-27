import { LOCAL_OPERATOR_ID, getJobForUser, prisma } from "@staticforge/database";

import {
  dashboardDisabledResponse,
  isDashboardEnabled,
} from "@/lib/dashboard/guard";

/** Poll one job's status and logs. */
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(
  _request: Request,
  context: Context,
): Promise<Response> {
  if (!isDashboardEnabled()) {
    return dashboardDisabledResponse();
  }

  const { id } = await context.params;
  const job = await getJobForUser(id, LOCAL_OPERATOR_ID, prisma);

  if (job === null) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  return Response.json(job);
}
