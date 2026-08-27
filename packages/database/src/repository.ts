import type { PrismaClient } from "@prisma/client";
import type {
  Business,
  Location,
  Service,
} from "@staticforge/schemas";

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
 * @param projectId - The project to load.
 * @param prisma - The client to query with. Injected so the mapping can be
 * tested against a mock with no database.
 * @returns The project's data in the engine's input shape.
 * @throws {ProjectPayloadError} If the project, its business, or its content
 * template does not exist.
 */
export async function getProjectPayload(
  projectId: string,
  prisma: PrismaClient,
): Promise<ProjectPayload> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      workspace: true,
      business: true,
      content: true,
      services: { orderBy: { createdAt: "asc" } },
      locations: { orderBy: { createdAt: "asc" } },
    },
  });

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
      // Project-level default. A service-level templateId still wins over it.
      templateId: project.templateId,
    },
  };
}
