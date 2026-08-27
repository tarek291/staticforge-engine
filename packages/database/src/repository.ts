// `Prisma` is a value import, not a type-only one: clearing a nullable Json
// column requires the `Prisma.DbNull` sentinel. A plain `null` is rejected,
// because for Json columns it is ambiguous with the JSON value `null`.
import { Prisma } from "@prisma/client";
import type { PageSource, PrismaClient } from "@prisma/client";
import type {
  Business,
  GeneratedPage as EnginePage,
  Location,
  Service,
} from "@staticforge/schemas";

import { withDbRetry } from "./retry.js";

/**
 * The data-access bridge between the database and the generation engine.
 *
 * The engine's contract is the file-shaped payload it has always consumed
 * (`businesses` / `services` / `locations` / `content`). This module reshapes
 * one project's rows into exactly that, so switching a run from files to the
 * database changes only where the data is *loaded* from — validation, page
 * building, slug collision checks and rendering are untouched downstream.
 *
 * The payload is deliberately **not** validated here. It is handed to the
 * generator's existing `validateInputData`, which remains the single place
 * input is checked and already reports issues with paths like
 * `businesses[0].contactEmail`.
 */

/** Tenant context for the project, for scoping and logging. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
}

/** The content template, matching the engine's `StaticContentTemplate`. */
export interface ContentTemplatePayload {
  hero: { titleTemplate: string; subtitleTemplate: string };
  cta: { primary: string; secondary: string };
  faqs: Array<{ q: string; a: string }>;
  templateId?: string;
  contentProfileId?: string;
  /** Absolute origin, from the project. Without it a cloud run publishes no
   * sitemap, because sitemap entries must be absolute URLs. */
  siteUrl?: string;
}

/**
 * One project's data, shaped like the engine's `RawInputData`.
 *
 * `businesses` is an array of exactly one entry: a project speaks for a single
 * trading identity, but the generator iterates businesses, so the shape is kept.
 */
export interface ProjectPayload {
  workspace: WorkspaceSummary;
  /** The project's stored locale. The CLI reports a mismatch with `--locale`. */
  locale: string;
  businesses: Business[];
  services: Service[];
  locations: Location[];
  content: ContentTemplatePayload;
}

/** Thrown when a project cannot produce a usable payload. */
export class ProjectPayloadError extends Error {
  override readonly name = "ProjectPayloadError";

  constructor(
    readonly projectId: string,
    message: string,
  ) {
    super(`Project "${projectId}": ${message}`);
  }
}

/**
 * Convert a Prisma `Decimal | number | null` to a plain number.
 *
 * Prisma returns `Decimal` instances for `@db.Decimal` columns; `Number()`
 * handles both those and the plain numbers a test double supplies.
 */
function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Drop `null`, which Zod's `.optional()` rejects, in favour of `undefined`. */
function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/**
 * Load one project and reshape it into the engine's input payload.
 *
 * Fails loudly when the project is missing, or when it lacks the business
 * identity or content template a page needs — a half-configured project would
 * otherwise surface much later as a confusing validation error.
 *
 * ## Why `userId` is not optional
 *
 * This is the engine's read path, and it returns everything a tenant has: the
 * trading identity, contact details, address, every service with its pricing,
 * every location. Scoping it at the call site would mean the isolation lived in
 * whichever caller remembered — a CLI flag, an API route, a future worker — and
 * one that forgot would leak a whole tenant rather than fail.
 *
 * So the scope is folded into the query and the parameter is required. A
 * project owned by someone else raises the *same* error as one that does not
 * exist, deliberately: the two must stay indistinguishable, or this becomes a
 * way to discover which ids are real.
 *
 * @param projectId - The project to load.
 * @param userId - The owner the caller is acting as.
 * @param prisma - The client to query with. Injected so the mapping can be
 * tested against a mock with no database.
 * @returns The project's data in the engine's input shape.
 * @throws {ProjectPayloadError} If the project does not exist, is not owned by
 * `userId`, or lacks its business or content template.
 */
export async function getProjectPayload(
  projectId: string,
  userId: string,
  prisma: PrismaClient,
): Promise<ProjectPayload> {
  // `findFirst`, not `findUnique`: the scope is part of the lookup rather than
  // a check applied to its result, so "not yours" cannot be reached by an early
  // return that forgot to run.
  //
  // Retried on a dropped connection: this is the first query of a run that may
  // then spend an hour authoring pages, and losing it to a recycled pooler
  // connection would waste the whole invocation. A read repeats cleanly.
  const project = await withDbRetry(() =>
    prisma.project.findFirst({
      where: { id: projectId, userId },
      include: {
        workspace: true,
        business: true,
        content: true,
        services: { orderBy: { createdAt: "asc" } },
        locations: { orderBy: { createdAt: "asc" } },
      },
    }),
  );

  if (project === null) {
    throw new ProjectPayloadError(projectId, "not found.");
  }

  const { business, content, workspace } = project;

  if (business === null) {
    throw new ProjectPayloadError(
      projectId,
      "has no business record; a generated page has no identity to speak for.",
    );
  }

  if (content === null) {
    throw new ProjectPayloadError(
      projectId,
      "has no content template; there is nothing to render pages from.",
    );
  }

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    },

    locale: project.locale,

    businesses: [
      {
        id: business.id,
        name: business.name,
        slug: business.slug,
        niche: business.niche,
        description: business.description,
        ...(business.foundedYear !== null
          ? { foundedYear: business.foundedYear }
          : {}),
        contactEmail: business.contactEmail,
        contactPhone: business.contactPhone,
        address: {
          street: business.addressStreet,
          city: business.addressCity,
          state: business.addressState,
          postalCode: business.addressPostalCode,
          country: business.addressCountry,
        },
        // Eligibility is left unconstrained: every service and location on the
        // project belongs to it, so the full cartesian product applies.
      },
    ],

    services: project.services.map((service) => {
      const from = toNumber(service.priceFrom);
      const to = toNumber(service.priceTo);

      return {
        id: service.id,
        name: service.name,
        slug: service.slug,
        description: service.description,
        benefits: service.benefits,
        // PricingSchema needs both bounds; a half-filled price is no price.
        ...(from !== undefined && to !== undefined
          ? {
              pricing: {
                from,
                to,
                currency: service.priceCurrency ?? "EUR",
              },
            }
          : {}),
        ...(service.templateId !== null
          ? { templateId: service.templateId }
          : {}),
        ...(service.contentProfileId !== null
          ? { contentProfileId: service.contentProfileId }
          : {}),
      };
    }),

    locations: project.locations.map((location) => {
      const lat = toNumber(location.latitude);
      const lng = toNumber(location.longitude);

      return {
        id: location.id,
        city: location.city,
        state: location.state,
        country: location.country,
        ...(optional(location.postalCode) !== undefined
          ? { postalCode: location.postalCode as string }
          : {}),
        ...(lat !== undefined && lng !== undefined
          ? { coordinates: { lat, lng } }
          : {}),
      };
    }),

    content: {
      hero: {
        titleTemplate: content.heroTitleTemplate,
        subtitleTemplate: content.heroSubtitleTemplate,
      },
      cta: {
        primary: content.ctaPrimary,
        secondary: content.ctaSecondary,
      },
      // `faqs` is a Json column, so its shape is unknown to the type system.
      // The generator's validateInputData is what actually checks it — and
      // rejects the payload if this is not `[{ q, a }, …]` with 3+ entries.
      faqs: content.faqs as ContentTemplatePayload["faqs"],
      // Project-level defaults. Service-level values still win over them.
      templateId: project.templateId,
      contentProfileId: project.contentProfileId,
      // Carried on the content block because that is where the generator reads
      // it from in file mode; one code path, one lookup.
      ...(project.siteUrl !== null ? { siteUrl: project.siteUrl } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/** Outcome of one persistence pass. */
export interface SaveGeneratedPagesResult {
  /** Pages written (created or updated). */
  saved: number;
  /** Stale pages deleted because this run no longer produces their slug. */
  removed: number;
}

/** Options for {@link saveGeneratedPages}. */
export interface SaveGeneratedPagesOptions {
  /**
   * How the content was produced. Defaults to `TEMPLATE`; the generator passes
   * `AI` when the authoring pass ran, so a dashboard can tell a templated page
   * from an authored one.
   */
  source?: PageSource;
}

/**
 * Persist a run's pages for one project, atomically.
 *
 * Everything happens inside a single `$transaction`, so a failure part-way
 * leaves the project's pages exactly as they were rather than half-updated.
 *
 * The transaction runs in three stages, and the order matters:
 *
 * 1. **Prove ownership** — a scoped read of the project. It is the *first
 *    statement inside the transaction* rather than a check before it, because a
 *    check outside leaves a window in which the project changes hands, and
 *    because a separate step is a step a caller can skip. A run that does not
 *    own the project writes nothing at all.
 * 2. **Delete stale pages** — rows whose slug this run no longer produces. This
 *    mirrors what `savePages` already does for files, and it is not optional:
 *    the table also carries a unique `(projectId, serviceId, locationId)`
 *    constraint, so a renamed service would otherwise leave an old row that the
 *    slug-keyed upsert cannot see and whose presence makes the insert fail.
 * 3. **Upsert each page**, keyed on `(projectId, slug)`.
 *
 * An empty `pages` array therefore clears the project's pages, matching the
 * file pipeline, where a run that produces nothing leaves nothing behind.
 *
 * `content` and `schemaOrg` are stored as JSON columns; they are rendered whole
 * and never queried field by field. `businessId` is not stored: a project has
 * exactly one business, so the page's identity follows from the project.
 *
 * @param projectId - The project these pages belong to.
 * @param userId - The owner the caller is acting as.
 * @param pages - Validated pages from the generator.
 * @param prisma - The client to write with. Injected so the write path can be
 * tested against a mock with no database.
 * @param options - Provenance of the content.
 * @returns How many pages were written and how many stale rows were removed.
 * @throws {ProjectPayloadError} If the project does not exist or is not owned
 * by `userId` — the same message either way, so a write cannot be used to probe
 * which ids are real.
 */
export async function saveGeneratedPages(
  projectId: string,
  userId: string,
  pages: EnginePage[],
  prisma: PrismaClient,
  options: SaveGeneratedPagesOptions = {},
): Promise<SaveGeneratedPagesResult> {
  const source: PageSource = options.source ?? "TEMPLATE";
  const slugs = pages.map((page) => page.slug);

  // Retried whole. A transaction is the one write shape that is always safe to
  // repeat: a connection lost part-way rolls it back completely, so the second
  // attempt starts against exactly the state the first one found. This is also
  // the write worth protecting most — it lands at the end of a long run, and
  // losing it there discards everything the run produced.
  return withDbRetry(() =>
    prisma.$transaction(async (tx) => {
      const owned = await tx.project.findFirst({
        where: { id: projectId, userId },
        select: { id: true },
      });

      if (owned === null) {
        throw new ProjectPayloadError(projectId, "not found.");
      }

      // Scoped through the relation as well as by id. The ownership check above
      // already settles it; expressing it again here means a future refactor that
      // drops the check still cannot delete another tenant's rows.
      const { count: removed } = await tx.generatedPage.deleteMany({
        where: { projectId, project: { userId }, slug: { notIn: slugs } },
      });

      for (const page of pages) {
        const fields = {
          locale: page.locale,
          title: page.title,
          metaDescription: page.metaDescription,
          h1: page.h1,
          content: page.content as unknown as Prisma.InputJsonObject,
          schemaOrg: page.schemaOrg as Prisma.InputJsonObject,
          templateId: page.templateId,
          contentProfileId: page.contentProfileId,
          source,
          // Provenance travels with the page or it is lost: cloud mode would
          // otherwise silently drop the prompt, model and source fingerprint that
          // the file output records.
          generation:
            page.generation === undefined
              ? Prisma.DbNull
              : (page.generation as unknown as Prisma.InputJsonObject),
          // Links travel with the page for the same reason provenance does: cloud
          // mode would otherwise hold a page whose internal graph had vanished.
          links: page.links as unknown as Prisma.InputJsonArray,
          serviceId: page.serviceId,
          locationId: page.locationId,
        };

        await tx.generatedPage.upsert({
          where: { projectId_slug: { projectId, slug: page.slug } },
          create: { projectId, slug: page.slug, ...fields },
          update: fields,
        });
      }

      return { saved: pages.length, removed };
    }),
  );
}
