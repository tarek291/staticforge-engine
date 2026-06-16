import { z } from "zod";
import {
  GeneratedPageSchema,
  type Business,
  type Service,
  type Location,
  type GeneratedPage,
} from "@staticforge/schemas";
import {
  generateSlug,
  combineSlug,
  truncateTitle,
  truncateMetaDescription,
  toTelHref,
} from "@staticforge/core";
import { ValidationError, type ValidationIssue } from "./errors.js";
import type { BuildPagesOptions, ValidatedInputData } from "./types.js";

/**
 * Values available to template placeholders. The keys mirror exactly the
 * supported placeholders: `{{service}}`, `{{city}}`, `{{business}}`.
 */
interface InterpolationValues {
  service: string;
  city: string;
  business: string;
}

/** The only placeholder names supported in interpolated content fields. */
const PLACEHOLDER_KEYS = ["service", "city", "business"] as const;
type PlaceholderKey = (typeof PLACEHOLDER_KEYS)[number];

function isPlaceholderKey(key: string): key is PlaceholderKey {
  return (PLACEHOLDER_KEYS as readonly string[]).includes(key);
}

/** Matches `{{ key }}` placeholders (optional surrounding whitespace). */
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Replace `{{key}}` placeholders in a template using the supplied values.
 * Only known keys are substituted; unknown placeholders are left untouched
 * (they are rejected separately by {@link collectUnknownPlaceholders}).
 * Pure — does not mutate inputs.
 */
function interpolate(template: string, values: InterpolationValues): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, key: string) =>
    isPlaceholderKey(key) ? values[key] : match,
  );
}

/**
 * Collect a {@link ValidationIssue} for every unknown `{{placeholder}}` in a
 * single interpolated template field. Known placeholders are ignored.
 */
function collectUnknownPlaceholders(
  template: string,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const key = match[1];
    if (key !== undefined && !isPlaceholderKey(key)) {
      issues.push({
        path,
        message: `Unknown placeholder "{{${key}}}" in ${path}. Supported placeholders: ${PLACEHOLDER_KEYS.join(", ")}.`,
      });
    }
  }
}

/**
 * Validate placeholders in the *interpolated* content fields only — hero
 * title/subtitle and each FAQ question/answer. Non-interpolated fields (CTA,
 * sections) are intentionally not scanned. The content template is shared, so
 * this is checked once rather than per generated page.
 */
function collectContentPlaceholderIssues(
  content: ValidatedInputData["content"],
  issues: ValidationIssue[],
): void {
  collectUnknownPlaceholders(
    content.hero.titleTemplate,
    "content.hero.titleTemplate",
    issues,
  );
  collectUnknownPlaceholders(
    content.hero.subtitleTemplate,
    "content.hero.subtitleTemplate",
    issues,
  );
  content.faqs.forEach((faq, index) => {
    collectUnknownPlaceholders(faq.q, `content.faqs[${index}].q`, issues);
    collectUnknownPlaceholders(faq.a, `content.faqs[${index}].a`, issues);
  });
}

/** Build a readable, dotted/bracketed path like `pages[slug].content.hero.heading`. */
function formatPath(
  path: ReadonlyArray<string | number>,
  prefix: string,
): string {
  let out = prefix;
  for (const segment of path) {
    out +=
      typeof segment === "number"
        ? `[${segment}]`
        : out.length > 0
          ? `.${segment}`
          : segment;
  }
  return out;
}

/** Map a `ZodError` from a single page into prefixed {@link ValidationIssue}s. */
function mapPageIssues(error: z.ZodError, slug: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path, `pages[${slug}]`),
    message: issue.message,
  }));
}

/**
 * Assemble a single page object from one business/service/location combination
 * and the shared content template. Returns a plain object that is validated by
 * the caller before being trusted as a {@link GeneratedPage}.
 */
function assemblePage(
  business: Business,
  service: Service,
  location: Location,
  content: ValidatedInputData["content"],
  locale: BuildPagesOptions["locale"],
): GeneratedPage {
  const values: InterpolationValues = {
    service: service.name,
    city: location.city,
    business: business.name,
  };

  const titleText = interpolate(content.hero.titleTemplate, values);
  const subtitleText = interpolate(content.hero.subtitleTemplate, values);
  const slug = combineSlug([generateSlug(service.slug), location.city]);
  const templateId = service.templateId ?? content.templateId ?? "default";

  // Optional secondary CTA: a tel: link, only when the phone normalizes to a
  // valid tel href and a secondary label is provided. Not rendered yet.
  const telHref = toTelHref(business.contactPhone);
  const secondaryCta =
    telHref !== null && content.cta.secondary.trim().length > 0
      ? { buttonLabel: content.cta.secondary, href: telHref }
      : undefined;

  return {
    slug,
    locale,
    title: truncateTitle(titleText),
    metaDescription: truncateMetaDescription(subtitleText),
    h1: titleText,
    content: {
      hero: {
        heading: titleText,
        subheading: subtitleText,
      },
      sections: [
        {
          heading: service.name,
          body: service.description,
        },
      ],
      faq: content.faqs.map((item) => ({
        question: interpolate(item.q, values),
        answer: interpolate(item.a, values),
      })),
      cta: {
        heading: titleText,
        buttonLabel: content.cta.primary,
        href: `mailto:${business.contactEmail}`,
        ...(secondaryCta ? { secondary: secondaryCta } : {}),
      },
    },
    schemaOrg: {
      "@context": "https://schema.org",
      "@type": "Service",
      name: titleText,
      serviceType: service.name,
      description: subtitleText,
      provider: {
        "@type": "LocalBusiness",
        name: business.name,
        email: business.contactEmail,
        telephone: business.contactPhone,
      },
      areaServed: {
        "@type": "City",
        name: location.city,
      },
    },
    templateId,
    businessId: business.id,
    serviceId: service.id,
    locationId: location.id,
  };
}

/**
 * Build pages in memory — one {@link GeneratedPage} per *eligible*
 * business × service × location combination. A business with no eligibility
 * fields covers all services and locations; its optional `serviceIds` /
 * `locationIds` narrow the eligible set. Duplicate slugs across combinations
 * are rejected. With the current sample input (1 business, 3 services, 3
 * locations, no eligibility fields) this produces 9 pages.
 *
 * Page text is derived entirely from the content template and entity data —
 * no language is hardcoded. Every page is validated against
 * {@link GeneratedPageSchema}; if any page is invalid, a single
 * {@link ValidationError} is thrown containing every issue across all pages.
 *
 * Pure — performs no I/O and writes no files.
 *
 * @param input - Validated input data.
 * @param options - Build options (locale).
 * @returns The generated pages.
 * @throws {ValidationError} If any assembled page fails schema validation.
 */
/**
 * Select the entities a business is eligible for.
 *
 * `undefined` ids → unconstrained (all items). Otherwise only items whose id is
 * listed are kept (preserving input order); an empty list yields none. Any
 * referenced id that does not exist is collected as a {@link ValidationIssue}.
 */
function selectEligible<T extends { id: string }>(
  items: T[],
  ids: string[] | undefined,
  businessId: string,
  field: "serviceIds" | "locationIds",
  label: "service" | "location",
  issues: ValidationIssue[],
): T[] {
  if (ids === undefined) {
    return items;
  }
  const known = new Set(items.map((item) => item.id));
  for (const id of ids) {
    if (!known.has(id)) {
      issues.push({
        path: `businesses[${businessId}].${field}`,
        message: `Unknown ${label} id "${id}" referenced by business="${businessId}".`,
      });
    }
  }
  const allowed = new Set(ids);
  return items.filter((item) => allowed.has(item.id));
}

export function buildPages(
  input: ValidatedInputData,
  options: BuildPagesOptions,
): GeneratedPage[] {
  const pages: GeneratedPage[] = [];
  const issues: ValidationIssue[] = [];
  const seenSlugs = new Set<string>();

  // Reject unknown placeholders in interpolated content fields up front.
  collectContentPlaceholderIssues(input.content, issues);

  for (const business of input.businesses) {
    const eligibleServices = selectEligible(
      input.services,
      business.serviceIds,
      business.id,
      "serviceIds",
      "service",
      issues,
    );
    const eligibleLocations = selectEligible(
      input.locations,
      business.locationIds,
      business.id,
      "locationIds",
      "location",
      issues,
    );

    for (const service of eligibleServices) {
      for (const location of eligibleLocations) {
        const page = assemblePage(
          business,
          service,
          location,
          input.content,
          options.locale,
        );

        // Guard against two combinations producing the same slug, which would
        // otherwise silently overwrite output files and duplicate manifest rows.
        if (seenSlugs.has(page.slug)) {
          issues.push({
            path: `pages[${page.slug}]`,
            message: `Duplicate slug "${page.slug}" produced by business="${business.id}", service="${service.id}", location="${location.id}" (already generated by an earlier combination).`,
          });
        } else {
          seenSlugs.add(page.slug);
        }

        const result = GeneratedPageSchema.safeParse(page);
        if (result.success) {
          pages.push(result.data);
        } else {
          issues.push(...mapPageIssues(result.error, page.slug));
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new ValidationError("pages", issues);
  }

  return pages;
}
