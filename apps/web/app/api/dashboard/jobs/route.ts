import { ProjectIdSchema } from "@staticforge/core";
import { LOCAL_OPERATOR_ID, enqueueJob, prisma } from "@staticforge/database";
import { LocaleSchema } from "@staticforge/schemas";

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
 *
 * Every field is parsed before it is used. Two of them end up on a command line
 * that a shell reads on Windows, and one of them becomes a directory name, so
 * "is a non-empty string" is not a sufficient check for either: a value that
 * reaches `spawn` unparsed is a command, and a value that reaches `join`
 * unparsed can leave the output tree.
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

  // The locale reaches `argv`. An unparsed value there is not an argument, it
  // is a command-line fragment, so it is pinned to the supported set here
  // rather than defaulted and forwarded.
  const parsedLocale = LocaleSchema.safeParse(locale ?? "de");

  if (!parsedLocale.success) {
    return Response.json(
      { error: `locale must be one of: ${LocaleSchema.options.join(", ")}.` },
      { status: 400 },
    );
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
  const job = await enqueueJob(
    parsedProjectId.data,
    LOCAL_OPERATOR_ID,
    kind,
    prisma,
    target,
  );

  if (job === null) {
    // Deliberately indistinguishable from "no such project": a caller must not
    // be able to probe which ids are real.
    return Response.json({ error: "Project not found." }, { status: 404 });
  }

  startJob(
    job.id,
    parsedProjectId.data,
    kind,
    parsedLocale.data,
    LOCAL_OPERATOR_ID,
    target,
  );

  return Response.json(job, { status: 202 });
}
