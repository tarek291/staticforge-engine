import {
  dashboardDisabledResponse,
  isDashboardEnabled,
} from "@/lib/dashboard/guard";
import { runGenerate } from "@/lib/dashboard/run-command";

/**
 * Runs the generator for one project.
 *
 * Dynamic by necessity as well as by declaration: it spawns a process, so it
 * must never be prerendered at build time.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isDashboardEnabled()) {
    return dashboardDisabledResponse();
  }

  const body: unknown = await request.json().catch(() => ({}));
  const { projectId, locale } = body as { projectId?: string; locale?: string };

  const result = await runGenerate(projectId, locale ?? "de");

  return Response.json(result, { status: result.ok ? 200 : 500 });
}
