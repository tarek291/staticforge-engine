import { ProjectIdSchema } from "@staticforge/core";
import { LOCAL_OPERATOR_ID, enqueueJob, prisma } from "@staticforge/database";
import { LocaleSchema } from "@staticforge/schemas";

import {
  dashboardDisabledResponse,
  isDashboardEnabled,
} from "@/lib/dashboard/guard";

/**
 * Queue an engine run.
 *
 * Writes one row and answers. That is the whole of it now.
 *
 * ## Why this route no longer runs anything
 *
 * It used to spawn the engine and supervise it in the background of the Next.js
 * process. That worked on one developer's machine and could not survive
 * anywhere else: an HTTP server holding an hour-long build cannot be restarted,
 * replicated or deployed without destroying the work in flight, so the web tier
 * could neither scale nor ship. The coupling also put an unbounded, host-level
 * capability behind a request handler, which is why the whole surface had to be
 * gated behind a local-only environment variable to be safe at all.
 *
 * A separate worker claims this row and does the work. The server's job is to
 * record the intent and get out of the way, and a queued job now survives the
 * server being restarted — because nothing about it depended on this process.
 *
 * Every field is parsed before it is stored. Two of them end up on a command
 * line that a shell reads on Windows, and one becomes a directory name, so "is
 * a non-empty string" is not a sufficient check for either — even though this
 * route no longer builds that command itself.
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

  // The locale reaches the worker's `argv`. An unparsed value there is not an
  // argument, it is a command-line fragment, so it is pinned to the supported
  // set here rather than defaulted and forwarded.
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

  // 202: recorded, not done. Whether a worker is running is deliberately not
  // checked here — a job queued with no worker up is not an error, it is a job
  // waiting, and it will be claimed when one starts.
  return Response.json(job, { status: 202 });
}
