import { hostname } from "node:os";

/**
 * This server instance's identity, for job leases.
 *
 * Orphan recovery has to tell "a job this instance was running before it
 * restarted" from "a job another instance is running right now". A pid cannot
 * carry that distinction — it changes on every restart, so an instance could
 * never recognise its own leftovers. A hostname can: stable across a restart of
 * the same container or machine, and distinct between instances.
 *
 * Overridable, because a platform that reuses hostnames across replicas needs
 * to say so. On a scheduler that assigns replica identifiers, that value
 * belongs here.
 */
export const INSTANCE_ID_ENV_VAR = "STATICFORGE_INSTANCE_ID";

/** Resolved once: it must not change while this process holds leases. */
const configured = process.env[INSTANCE_ID_ENV_VAR]?.trim();
const resolved =
  configured === undefined || configured === "" ? hostname() : configured;

/** Stable identity of this server instance. */
export function instanceId(): string {
  return resolved;
}
