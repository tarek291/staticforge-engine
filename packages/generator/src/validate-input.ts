import { z } from "zod";
import {
  BusinessSchema,
  ServiceSchema,
  LocationSchema,
  type Business,
  type Service,
  type Location,
} from "@staticforge/schemas";
import { ValidationError, type ValidationIssue } from "./errors.js";
import type {
  RawInputData,
  StaticContentTemplate,
  ValidatedInputData,
} from "./types.js";

/**
 * Outcome of a non-throwing validation pass: either the validated data, or the
 * full list of issues found. Used to separate *collecting* problems from
 * *throwing* them, so multiple sections can be validated before failing.
 */
export type CollectResult<T> =
  | { ok: true; data: T }
  | { ok: false; issues: ValidationIssue[] };

/** Local schema mirroring {@link StaticContentTemplate}; faqs require ≥3 items. */
const StaticContentTemplateSchema = z.object({
  hero: z.object({
    titleTemplate: z.string(),
    subtitleTemplate: z.string(),
  }),
  cta: z.object({
    primary: z.string(),
    secondary: z.string(),
  }),
  faqs: z
    .array(z.object({ q: z.string(), a: z.string() }))
    .min(3),
  // Optional override selecting which template renders the generated pages.
  // Absent → the generator falls back to "default". Empty string is rejected.
  templateId: z.string().min(1).optional(),
});

/** Build a readable, dotted/bracketed path like `businesses[0].contactEmail`. */
function formatPath(path: ReadonlyArray<string | number>, prefix: string): string {
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

/** Map a `ZodError`'s issues into prefixed {@link ValidationIssue}s. */
function mapZodIssues(error: z.ZodError, prefix: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path, prefix),
    message: issue.message,
  }));
}

// --- Internal collectors (RETURN, never throw) ---

/** Collect all issues for the businesses array. */
export function collectBusinessIssues(data: unknown): CollectResult<Business[]> {
  const result = z.array(BusinessSchema).safeParse(data);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, issues: mapZodIssues(result.error, "businesses") };
}

/** Collect all issues for the services array. */
export function collectServiceIssues(data: unknown): CollectResult<Service[]> {
  const result = z.array(ServiceSchema).safeParse(data);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, issues: mapZodIssues(result.error, "services") };
}

/** Collect all issues for the locations array. */
export function collectLocationIssues(data: unknown): CollectResult<Location[]> {
  const result = z.array(LocationSchema).safeParse(data);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, issues: mapZodIssues(result.error, "locations") };
}

/** Collect all issues for the static content template. */
export function collectContentIssues(
  data: unknown,
): CollectResult<StaticContentTemplate> {
  const result = StaticContentTemplateSchema.safeParse(data);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, issues: mapZodIssues(result.error, "content") };
}

// --- Public validators (THROW on failure) ---

/** Validate the businesses array, throwing {@link ValidationError} on failure. */
export function validateBusinesses(data: unknown): Business[] {
  const result = collectBusinessIssues(data);
  if (!result.ok) {
    throw new ValidationError("businesses", result.issues);
  }
  return result.data;
}

/** Validate the services array, throwing {@link ValidationError} on failure. */
export function validateServices(data: unknown): Service[] {
  const result = collectServiceIssues(data);
  if (!result.ok) {
    throw new ValidationError("services", result.issues);
  }
  return result.data;
}

/** Validate the locations array, throwing {@link ValidationError} on failure. */
export function validateLocations(data: unknown): Location[] {
  const result = collectLocationIssues(data);
  if (!result.ok) {
    throw new ValidationError("locations", result.issues);
  }
  return result.data;
}

/** Validate the content template, throwing {@link ValidationError} on failure. */
export function validateContent(data: unknown): StaticContentTemplate {
  const result = collectContentIssues(data);
  if (!result.ok) {
    throw new ValidationError("content", result.issues);
  }
  return result.data;
}

/**
 * Validate every section of {@link RawInputData} at once.
 *
 * Runs all four collectors (never the throwing validators), gathers issues from
 * every failed section into a single list, and — if anything failed — throws
 * exactly one {@link ValidationError} with `entityType` `"input"`. It never
 * stops at the first failure, so callers see all problems in one pass.
 *
 * @param raw - The raw, unvalidated input data.
 * @returns The fully validated and typed input data.
 * @throws {ValidationError} If any section fails validation.
 */
export function validateInputData(raw: RawInputData): ValidatedInputData {
  const businesses = collectBusinessIssues(raw.businesses);
  const services = collectServiceIssues(raw.services);
  const locations = collectLocationIssues(raw.locations);
  const content = collectContentIssues(raw.content);

  const issues: ValidationIssue[] = [
    ...(businesses.ok ? [] : businesses.issues),
    ...(services.ok ? [] : services.issues),
    ...(locations.ok ? [] : locations.issues),
    ...(content.ok ? [] : content.issues),
  ];

  if (
    !businesses.ok ||
    !services.ok ||
    !locations.ok ||
    !content.ok
  ) {
    throw new ValidationError("input", issues);
  }

  return {
    businesses: businesses.data,
    services: services.data,
    locations: locations.data,
    content: content.data,
  };
}
