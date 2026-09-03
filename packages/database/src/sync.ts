import type { PrismaClient } from "@prisma/client";
import {
  noopHookBus,
  stableHash,
  type HookBus,
  type SyncPayload,
} from "@staticforge/core";
import type { Location, Service } from "@staticforge/schemas";

import { requireCapability } from "./access.js";
import { affectedSlugs, findAffectedPages } from "./impact.js";
import { requireQuotaReservation } from "./quota.js";
import { withDbRetry } from "./retry.js";

/**
 * Applying synced data, and deciding whether it changed anything.
 *
 * ## Why the comparison comes first
 *
 * A sync that always queued a run would be a standing order to spend money.
 * These sources poll and re-send: a nightly cron re-uploads the same sheet, a
 * CRM fires a webhook when a field nobody uses is touched, an operator clicks
 * "sync" twice. Every one of those, on a project with AI authoring enabled,
 * would buy a few hundred pages of prose identical to the prose already stored.
 *
 * So the incoming data is compared to what the project already holds *before*
 * anything is written, and a run is queued only when the comparison says the
 * pages would come out different. That check is the feature; the writing is the
 * easy part.
 *
 * ## What counts as a change
 *
 * Only what reaches a page. An entity is fingerprinted over the fields the
 * generator and the grounding record actually read — not over `updatedAt`, not
 * over database ids, not over the order rows came back in. A source that
 * rewrites every row every night with the same values must register as no
 * change, or the guard is decorative.
 */

/** What a project's services and locations look like, for comparison. */
export interface SyncSnapshot {
  services: Map<string, string>;
  locations: Map<string, string>;
  /**
   * The organization the project belongs to.
   *
   * Read here rather than in a second query, because the authorisation gate
   * needs it and a gate that costs an extra round trip is a gate somebody
   * eventually argues for skipping.
   */
  organizationId: string;
}

/**
 * Fingerprint one service over the fields that reach a page.
 *
 * `templateId` and `contentProfileId` are included: they change how a page is
 * rendered and which rules it is held to, so a sheet that moves a service to a
 * different profile genuinely produces a different page.
 */
export function fingerprintService(service: Service): string {
  return stableHash({
    name: service.name,
    slug: service.slug,
    description: service.description,
    benefits: service.benefits,
    pricing: service.pricing,
    templateId: service.templateId,
    contentProfileId: service.contentProfileId,
  });
}

/** Fingerprint one location over the fields that reach a page. */
export function fingerprintLocation(location: Location): string {
  return stableHash({
    city: location.city,
    state: location.state,
    country: location.country,
    postalCode: location.postalCode,
    coordinates: location.coordinates,
  });
}

/** What one collection's comparison found. */
export interface CollectionDiff {
  added: string[];
  updated: string[];
  removed: string[];
}

/** What a whole sync would change. */
export interface SyncDiff {
  services: CollectionDiff;
  locations: CollectionDiff;
  /** Whether anything at all would move. */
  changed: boolean;
}

/** An empty diff, for a collection the payload did not mention. */
function noChange(): CollectionDiff {
  return { added: [], updated: [], removed: [] };
}

/**
 * Compare one collection against what is stored.
 *
 * `undefined` means the source did not mention this collection, which is not
 * the same as sending an empty one. A sheet listing only locations must not be
 * read as an instruction to delete every service — a distinction that decides
 * whether a partial sync is useful or catastrophic.
 */
export function diffCollection(
  incoming: Array<{ id: string }> | undefined,
  fingerprints: (item: never) => string,
  current: Map<string, string>,
): CollectionDiff {
  if (incoming === undefined) {
    return noChange();
  }

  const diff = noChange();
  const seen = new Set<string>();

  for (const item of incoming) {
    seen.add(item.id);

    const next = fingerprints(item as never);
    const previous = current.get(item.id);

    if (previous === undefined) {
      diff.added.push(item.id);
    } else if (previous !== next) {
      diff.updated.push(item.id);
    }
  }

  for (const id of current.keys()) {
    if (!seen.has(id)) {
      diff.removed.push(id);
    }
  }

  return diff;
}

/** Whether a collection diff moved anything. */
function moves(diff: CollectionDiff): boolean {
  return (
    diff.added.length > 0 || diff.updated.length > 0 || diff.removed.length > 0
  );
}

/**
 * Compare an incoming payload against a project's current state.
 *
 * Pure: it reads nothing and writes nothing, so the decision that gates a paid
 * run is testable on its own.
 */
export function diffSyncPayload(
  payload: SyncPayload,
  snapshot: SyncSnapshot,
): SyncDiff {
  const services = diffCollection(
    payload.services,
    fingerprintService as (item: never) => string,
    snapshot.services,
  );
  const locations = diffCollection(
    payload.locations,
    fingerprintLocation as (item: never) => string,
    snapshot.locations,
  );

  return { services, locations, changed: moves(services) || moves(locations) };
}

/**
 * Read a project's services and locations as fingerprints.
 *
 * Scoped to the owner like every other read here: a sync must not be able to
 * discover another tenant's data by observing whether it reported a change.
 *
 * @returns The snapshot, or `null` when the project is not the caller's — the
 * same answer as a project that does not exist.
 */
export async function loadSyncSnapshot(
  projectId: string,
  userId: string,
  prisma: PrismaClient,
): Promise<SyncSnapshot | null> {
  const project = await withDbRetry(() =>
    prisma.project.findFirst({
      where: { id: projectId, userId },
      select: {
        id: true,
        organizationId: true,
        services: true,
        locations: true,
      },
    }),
  );

  if (project === null) {
    return null;
  }

  return {
    organizationId: project.organizationId,
    services: new Map(
      project.services.map((row) => [
        row.id,
        fingerprintService({
          id: row.id,
          name: row.name,
          slug: row.slug,
          description: row.description,
          benefits: row.benefits,
          ...(row.priceFrom !== null && row.priceTo !== null
            ? {
                pricing: {
                  from: Number(row.priceFrom),
                  to: Number(row.priceTo),
                  currency: row.priceCurrency ?? "EUR",
                },
              }
            : {}),
          ...(row.templateId !== null ? { templateId: row.templateId } : {}),
          ...(row.contentProfileId !== null
            ? { contentProfileId: row.contentProfileId }
            : {}),
        }),
      ]),
    ),
    locations: new Map(
      project.locations.map((row) => [
        row.id,
        fingerprintLocation({
          id: row.id,
          city: row.city,
          state: row.state,
          country: row.country,
          ...(row.postalCode !== null ? { postalCode: row.postalCode } : {}),
          ...(row.latitude !== null && row.longitude !== null
            ? { coordinates: { lat: row.latitude, lng: row.longitude } }
            : {}),
        }),
      ]),
    ),
  };
}

/** What a sync did. */
export interface SyncResult {
  /** Whether anything actually moved. `false` means nothing was written. */
  changed: boolean;
  diff: SyncDiff;
  /** The run queued because of this sync, if one was. */
  jobId: string | null;
  /** Why no job was queued, when none was. */
  note?: string;
  /**
   * What the queued run was allowed to re-author.
   *
   * Empty means a full run — either because the change altered which pages
   * should exist, or because nothing was queued at all. The two are told apart
   * by `jobId`.
   */
  scope: string[];
}

/**
 * Whether a change altered *which* pages should exist, rather than only their
 * content.
 *
 * The distinction decides whether an incremental run is even possible. An
 * updated service makes its existing pages stale, and those pages can be listed
 * and re-authored. An *added* service has no pages to list — they have to be
 * created, and only a full run creates pages. A *removed* one is the same
 * problem seen from the other side: its pages cascade away, and every surviving
 * page that linked to them now carries a link to nothing, so the link graph has
 * to be recomputed across the project.
 *
 * Getting this backwards is not a performance bug. A scoped run after a service
 * was added would queue a job for pages that do not exist, do nothing, report
 * success, and leave the new service unpublished with no error anywhere.
 */
export function changesPageSet(diff: SyncDiff): boolean {
  return (
    diff.services.added.length > 0 ||
    diff.services.removed.length > 0 ||
    diff.locations.added.length > 0 ||
    diff.locations.removed.length > 0
  );
}

/** What a sync decided to queue, and why. */
export interface QueuePlan {
  /** Whether to queue a run at all. */
  queue: boolean;
  /** Pages the run may re-author. Empty means unscoped — a full run. */
  scope: string[];
  /** One line, for the operator and the result note. */
  reason: string;
}

/** How a sync should behave once it knows what changed. */
export interface SyncOptions {
  /**
   * Apply the change and queue a run.
   *
   * Off for a dry run: nothing is written and nothing is queued, which is how
   * an operator checks what a sheet would do before letting it do it. The diff
   * is still returned, because that is the whole question being asked.
   */
  enqueue?: boolean;
  /**
   * Injected so the orchestration is testable without a queue.
   *
   * `scope` is the list of page slugs the run may re-author, and an empty list
   * means a full run. A caller that ignores the third argument still compiles
   * and still works — it simply buys the whole project every time, which is
   * what every caller did before this parameter existed.
   */
  enqueueJob?: (
    projectId: string,
    userId: string,
    scope: readonly string[],
  ) => Promise<string | null>;
  /**
   * Lifecycle bus. Defaults to one with nothing installed.
   *
   * A sync that changed nothing is still worth announcing: "we checked and it
   * was current" is the answer an audit trail needs most often, and a plugin
   * that only heard about changes could not tell a quiet system from a broken
   * integration.
   */
  hooks?: HookBus;
}

/** Announce a finished sync. Every listener failure is absorbed. */
async function announceSync(
  hooks: HookBus,
  projectId: string,
  userId: string,
  organizationId: string | null,
  result: SyncResult,
  reservedUnits = 0,
): Promise<void> {
  await hooks.emit("afterProjectSync", {
    reservedUnits,
    projectId,
    userId,
    organizationId,
    changed: result.changed,
    jobId: result.jobId,
    servicesAdded: result.diff.services.added.length,
    servicesUpdated: result.diff.services.updated.length,
    servicesRemoved: result.diff.services.removed.length,
    locationsAdded: result.diff.locations.added.length,
    locationsUpdated: result.diff.locations.updated.length,
    locationsRemoved: result.diff.locations.removed.length,
    scopedPages: result.scope.length,
    syncedAt: new Date().toISOString(),
  });
}

/**
 * Decide what run, if any, a change deserves.
 *
 * Three outcomes, and the middle one is the feature:
 *
 * 1. **The page set moved** — something was added or removed. Only a full run
 *    can create a page or repair a link graph, so the scope is empty.
 * 2. **Content moved on pages that exist** — the changed services and locations
 *    are looked up against the pages actually stored, and the run is scoped to
 *    exactly those slugs. This is the whole point: a description edited on one
 *    service in a forty-city account re-authors forty pages, not two hundred.
 * 3. **Nothing was reached** — every page the change touched is hand-edited, or
 *    the project has never been generated. No run is queued at all.
 *
 * The third outcome is the one worth being careful about, because "queue
 * nothing" and "queue everything" look identical from the outside until the
 * bill arrives. The reason is returned so the caller can say which happened.
 *
 * Read-only, and safe to call before the sync's write: it asks which pages
 * exist, and applying a payload of updates does not create or destroy any.
 *
 * @returns The plan. Never throws for an unknown project — an unowned project
 * simply reaches no pages, which is already an outcome this handles.
 */
export async function planSyncRun(
  projectId: string,
  userId: string,
  diff: SyncDiff,
  prisma: PrismaClient,
): Promise<QueuePlan> {
  if (changesPageSet(diff)) {
    return {
      queue: true,
      scope: [],
      reason:
        "services or locations were added or removed, so the page set itself " +
        "changed: a full run is the only kind that can create a page or " +
        "recompute the link graph.",
    };
  }

  const affected = await findAffectedPages(
    projectId,
    userId,
    diff.services.updated,
    diff.locations.updated,
    prisma,
  );

  if (affected.length === 0) {
    // Deliberately not a full run. The change reached nothing that an
    // automated run may rewrite — every page it touched is hand-edited, or
    // there are no pages yet — and queueing "just in case" is how an
    // incremental system quietly becomes the thing it replaced.
    return {
      queue: false,
      scope: [],
      reason:
        "the change reached no page this engine may rewrite: every page it " +
        "touches is hand-edited, or the project has not been generated yet.",
    };
  }

  return {
    queue: true,
    scope: affectedSlugs(affected),
    reason: `${affected.length} existing page(s) are stale and will be re-authored.`,
  };
}

/**
 * Apply an incoming payload to a project, and queue a run only if it changed.
 *
 * The whole write is one transaction: a sync that failed half-way would leave a
 * project describing services it no longer has locations for, and the run
 * queued after it would publish that.
 *
 * A collection the payload did not mention is left entirely alone — not
 * emptied. That is the difference between a partial sync and a deletion.
 *
 * @returns What changed, and the run queued for it if any.
 */
export async function syncProject(
  projectId: string,
  userId: string,
  payload: SyncPayload,
  prisma: PrismaClient,
  options: SyncOptions = {},
): Promise<SyncResult | null> {
  const snapshot = await loadSyncSnapshot(projectId, userId, prisma);

  if (snapshot === null) {
    return null;
  }

  // The authorisation gate, and it is the first thing that happens after the
  // project is located. A sync writes tenant data and enqueues paid work, so it
  // needs `project:write` — which a VIEWER does not have. Placed here rather
  // than in each of the three callers, because a check per caller is a check
  // somebody forgets to add to the fourth.
  //
  // This throws rather than returning null. A refusal is not "no such project",
  // and collapsing the two would leave a caller unable to tell an operator
  // whether to fix an id or ask for a role.
  await requireCapability(snapshot.organizationId, userId, "project:write", prisma);

  // The commercial ceiling, checked before the comparison and long before the
  // write. A sync is one operation whether or not it changes anything — it is
  // the lever an integration can pull in a loop — so it costs one unit.
  //
  // Gated only on the path that is *metered*. A dry run emits no lifecycle
  // event and therefore never becomes a usage row, so refusing one would charge
  // a tenant nothing and cost it the ability to find out what a sheet would do
  // — which is exactly what somebody near their limit most needs to know.
  // Keeping the check and the charge on the same paths is what stops the two
  // drifting into a system that bills for what it did not gate, or the reverse.
  //
  // The gate *holds* the unit it admits rather than only checking for it, so a
  // burst of concurrent syncs cannot all read the same total and all pass. One
  // unit is also the exact charge — a sync is one operation whatever it finds
  // — so the hold and the settlement are equal and the ledger ends with the
  // single row it always had.
  const reservation =
    (options.enqueue ?? true)
      ? await requireQuotaReservation(
          snapshot.organizationId,
          "SYNC_OPERATIONS",
          1,
          prisma,
          projectId,
        )
      : { reserved: 0 };

  const diff = diffSyncPayload(payload, snapshot);

  const hooks = options.hooks ?? noopHookBus();

  if (!diff.changed) {
    // The point of the whole module. Writing identical rows would be harmless;
    // queueing the run that follows would not.
    const unchanged: SyncResult = {
      changed: false,
      diff,
      jobId: null,
      scope: [],
      note: "The incoming data matches what this project already holds.",
    };

    await announceSync(
      hooks,
      projectId,
      userId,
      snapshot.organizationId,
      unchanged,
      reservation.reserved,
    );

    return unchanged;
  }

  const enqueue = options.enqueue ?? true;

  // Computed before the write, which is both safe and necessary: it reads which
  // pages exist, and a payload of updates neither creates nor destroys one — so
  // a dry run can report the plan without having caused it.
  const plan = await planSyncRun(projectId, userId, diff, prisma);

  if (!enqueue) {
    // Before the write, not after it. A dry run exists so an operator can see
    // what a sheet would do *before* letting it do anything — reporting that
    // from the far side of the transaction would answer the question honestly
    // and have already changed the answer.
    //
    // Deliberately not announced: nothing happened, and a plugin told a project
    // synced when it did not would be lying to an audit trail.
    return {
      changed: true,
      diff,
      jobId: null,
      scope: plan.scope,
      note:
        `Dry run: nothing was written and no run was queued. ` +
        (plan.queue
          ? plan.scope.length === 0
            ? `A real sync would queue a full run — ${plan.reason}`
            : `A real sync would queue a run scoped to ${plan.scope.length} page(s) — ${plan.reason}`
          : `A real sync would queue nothing — ${plan.reason}`),
    };
  }

  await withDbRetry(() =>
    prisma.$transaction(async (tx) => {
      // Ownership again, inside the transaction. The snapshot proved it a
      // moment ago; a check before a transaction is a check with a window.
      const owned = await tx.project.findFirst({
        where: { id: projectId, userId },
        select: { id: true },
      });

      if (owned === null) {
        throw new Error(`Project "${projectId}": not found.`);
      }

      if (payload.services !== undefined) {
        const keep = payload.services.map((service: Service) => service.id);

        await tx.service.deleteMany({
          where: { projectId, id: { notIn: keep } },
        });

        for (const service of payload.services) {
          const fields = {
            name: service.name,
            slug: service.slug,
            description: service.description,
            benefits: service.benefits,
            priceFrom: service.pricing?.from ?? null,
            priceTo: service.pricing?.to ?? null,
            priceCurrency: service.pricing?.currency ?? null,
            templateId: service.templateId ?? null,
            contentProfileId: service.contentProfileId ?? null,
          };

          await tx.service.upsert({
            where: { id: service.id },
            create: { id: service.id, projectId, ...fields },
            update: fields,
          });
        }
      }

      if (payload.locations !== undefined) {
        const keep = payload.locations.map((location: Location) => location.id);

        await tx.location.deleteMany({
          where: { projectId, id: { notIn: keep } },
        });

        for (const location of payload.locations) {
          const fields = {
            // A location's display name is not part of the sync contract, so it
            // tracks the city rather than being invented or left stale.
            name: location.city,
            slug: location.id,
            city: location.city,
            state: location.state,
            country: location.country,
            postalCode: location.postalCode ?? null,
            latitude: location.coordinates?.lat ?? null,
            longitude: location.coordinates?.lng ?? null,
          };

          await tx.location.upsert({
            where: { id: location.id },
            create: { id: location.id, projectId, ...fields },
            update: fields,
          });
        }
      }
    }),
  );

  if (options.enqueueJob === undefined) {
    // The data was applied, but this caller supplied no way to queue a run.
    const applied: SyncResult = {
      changed: true,
      diff,
      jobId: null,
      scope: plan.scope,
      note: "Applied, but no run was queued: this caller supplied no queue.",
    };

    await announceSync(
      hooks,
      projectId,
      userId,
      snapshot.organizationId,
      applied,
      reservation.reserved,
    );

    return applied;
  }

  if (!plan.queue) {
    // The data was applied — it is the project's data and the source is
    // authoritative about it — but nothing was queued, because nothing this
    // engine may rewrite went stale. Announced like any other sync: a plugin
    // that only heard about runs could not tell a project holding steady from
    // an integration that stopped calling.
    const quiet: SyncResult = {
      changed: true,
      diff,
      jobId: null,
      scope: [],
      note: `Applied, but no run was queued: ${plan.reason}`,
    };

    await announceSync(
      hooks,
      projectId,
      userId,
      snapshot.organizationId,
      quiet,
      reservation.reserved,
    );

    return quiet;
  }

  const jobId = await options.enqueueJob(projectId, userId, plan.scope);
  const result: SyncResult = { changed: true, diff, jobId, scope: plan.scope };

  await announceSync(
    hooks,
    projectId,
    userId,
    snapshot.organizationId,
    result,
    reservation.reserved,
  );

  return result;
}

/** Render a diff as a line an operator can read. */
export function describeSyncDiff(diff: SyncDiff): string {
  const part = (label: string, collection: CollectionDiff): string | undefined =>
    moves(collection)
      ? `${label}: ${collection.added.length} added, ` +
        `${collection.updated.length} updated, ${collection.removed.length} removed`
      : undefined;

  const parts = [
    part("services", diff.services),
    part("locations", diff.locations),
  ].filter((value): value is string => value !== undefined);

  return parts.length === 0 ? "no changes" : parts.join("; ");
}
