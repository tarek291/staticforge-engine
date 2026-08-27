import { LOCAL_OPERATOR_ID, enqueueJob, prisma } from "@staticforge/database";

import {
  dashboardDisabledResponse,
  isDashboardEnabled,
} from "@/lib/dashboard/guard";
import { startJob } from "@/lib/dashboard/jobs";

/**
 * Queue an engine run.
 *
 * Answers 202 as soon as the job row exists, then does the work in the
 * background. Waiting for a five-hundred-page build inside a request would be
 * cut off by a proxy, a browser, or a platform timeout long before it finished.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isDashboardEnabled()) {
    return dashboardDisabledResponse();
  }

  const body: unknown = await request.json().catch(() => ({}));
  const { projectId, kind, locale, slug, feedback } = body as {
    projectId?: string;
    kind?: "GENERATE" | "BUILD" | "REFRESH";
    locale?: string;
    slug?: string;
    feedback?: string;
  };

  if (typeof projectId !== "string" || projectId.length === 0) {
    return Response.json({ error: "projectId is required." }, { status: 400 });
  }

  if (kind !== "GENERATE" && kind !== "BUILD" && kind !== "REFRESH") {
    return Response.json(
      { error: 'kind must be "GENERATE", "BUILD" or "REFRESH".' },
      { status: 400 },
    );
  }

  // A refresh needs a target and a reason. Without feedback the call would
  // rewrite a page for no stated purpose, which is worse than doing nothing.
  const target =
    kind === "REFRESH"
      ? { slug: slug ?? "", feedback: (feedback ?? "").trim() }
      : undefined;

  if (target !== undefined && (target.slug === "" || target.feedback === "")) {
    return Response.json(
      { error: "A refresh needs both a page slug and feedback." },
      { status: 400 },
    );
  }

  // Ownership is checked inside enqueueJob, in the same query that finds the
  // project — so a project belonging to another tenant is simply not found.
  const job = await enqueueJob(projectId, LOCAL_OPERATOR_ID, kind, prisma, target);

  if (job === null) {
    // Deliberately indistinguishable from "no such project": a caller must not
    // be able to probe which ids are real.
    return Response.json({ error: "Project not found." }, { status: 404 });
  }

  startJob(job.id, projectId, kind, locale ?? "de", target);

  return Response.json(job, { status: 202 });
}
