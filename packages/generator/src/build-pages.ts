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
} from "@staticforge/core";
import { ValidationError, type ValidationIssue } from "./errors.js";
import type { BuildPagesOptions, ValidatedInputData } from "./types.js";

/**
 * Values available to template placeholders. The keys mirror exactly the
 * placeholders currently present in the content templates: `{{service}}`,
 * `{{city}}`, `{{business}}`. No other placeholders are supported.
 */
interface InterpolationValues {
  service: string;
  city: string;
  business: string;
}

/** Matches `{{ key }}` placeholders (optional surrounding whitespace). */
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Replace `{{key}}` placeholders in a template using the supplied values.
 * Only known keys are substituted; any unknown placeholder is left untouched.
 * Pure — does not mutate inputs.
 */
function interpolate(template: string, values: InterpolationValues): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    if (key === "service" || key === "city" || key === "business") {
      return values[key];
    }
    return match;
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
        href: "#contact",
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
 * Build one {@link GeneratedPage} for every business × service × location
 * combination, in memory. With the current sample input (1 business, 3
 * services, 3 locations) this produces 9 pages.
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
export function buildPages(
  input: ValidatedInputData,
  options: BuildPagesOptions,
): GeneratedPage[] {
  const pages: GeneratedPage[] = [];
  const issues: ValidationIssue[] = [];

  for (const business of input.businesses) {
    for (const service of input.services) {
      for (const location of input.locations) {
        const page = assemblePage(
          business,
          service,
          location,
          input.content,
          options.locale,
        );

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
