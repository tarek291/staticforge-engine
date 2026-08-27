import type { PrismaClient } from "@prisma/client";
import { stableHash, type SyncPayload } from "@staticforge/core";
import type { Location, Service } from "@staticforge/schemas";

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
        services: true,
        locations: true,
      },
    }),
  );

  if (project === null) {
    return null;
  }

  return {
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
  /** Injected so the orchestration is testable without a queue. */
  enqueueJob?: (projectId: string, userId: string) => Promise<string | null>;
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

  const diff = diffSyncPayload(payload, snapshot);

  if (!diff.changed) {
    // The point of the whole module. Writing identical rows would be harmless;
    // queueing the run that follows would not.
    return {
      changed: false,
      diff,
      jobId: null,
      note: "The incoming data matches what this project already holds.",
    };
  }

  const enqueue = options.enqueue ?? true;

  if (!enqueue) {
    // Before the write, not after it. A dry run exists so an operator can see
    // what a sheet would do *before* letting it do anything — reporting that
    // from the far side of the transaction would answer the question honestly
    // and have already changed the answer.
    return {
      changed: true,
      diff,
      jobId: null,
      note: "Dry run: nothing was written and no run was queued.",
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
    return {
      changed: true,
      diff,
      jobId: null,
      note: "Applied, but no run was queued: this caller supplied no queue.",
    };
  }

  const jobId = await options.enqueueJob(projectId, userId);

  return { changed: true, diff, jobId };
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
