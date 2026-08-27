/**
 * Local-only guard for the dashboard's operational routes.
 *
 * The generate and build endpoints spawn processes on the host. That is exactly
 * what makes them useful locally and exactly what makes them dangerous
 * anywhere else: an unauthenticated endpoint that runs commands is remote code
 * execution, whatever it was built for.
 *
 * This phase deliberately ships no authentication, so the only honest control
 * is to refuse to run at all outside a local operator's machine. The check is
 * a positive opt-in rather than a "not production" test, because a missing
 * NODE_ENV would otherwise read as permission.
 */

/** Environment variable an operator sets to enable the control endpoints. */
export const DASHBOARD_ENV_VAR = "STATICFORGE_DASHBOARD";

/** Whether the operational endpoints may run. */
export function isDashboardEnabled(): boolean {
  return process.env[DASHBOARD_ENV_VAR] === "local";
}

/** The refusal, as a response. */
export function dashboardDisabledResponse(): Response {
  return Response.json(
    {
      ok: false,
      error:
        `Control endpoints are disabled. They run build commands on the host, ` +
        `so they are opt-in: set ${DASHBOARD_ENV_VAR}=local to enable them, and ` +
        `only on a machine you control. This build ships no authentication.`,
    },
    { status: 403 },
  );
}
