import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import {
  LocationSchema,
  ServiceSchema,
  type Location,
  type Service,
} from "@staticforge/schemas";

import { generateSlug } from "./slug.js";

/**
 * CSV ingestion for scalable data input.
 *
 * One flat sheet describes both services and locations; the `type` column
 * decides which schema a row must satisfy. Rows are validated against the real
 * `ServiceSchema` / `LocationSchema`, so this importer can never introduce data
 * the generator would later choke on.
 *
 * ## Columns
 *
 * | Column       | service            | location          |
 * |--------------|--------------------|-------------------|
 * | `type`       | required           | required          |
 * | `name`       | required           | required (city)   |
 * | `description`| required, 100+ ch. | ignored           |
 * | `benefits`   | required, 3+       | ignored           |
 * | `state`      | ignored            | required          |
 * | `id`         | optional           | optional          |
 * | `slug`       | optional           | ignored           |
 * | `country`    | ignored            | optional (`DE`)   |
 * | `postalCode` | ignored            | optional          |
 * | `pricing`    | optional           | ignored           |
 * | `coordinates`| ignored            | optional          |
 *
 * `benefits` is a `|`-separated list. `pricing` is `from|to|currency`.
 * `coordinates` is `lat|lng`. Unknown columns are ignored.
 *
 * `description`, `benefits` and `state` are not optional conveniences — the
 * schemas require them, so a sheet without them cannot produce a valid page.
 *
 * `slug` is optional but meaningful: without it the slug is derived from
 * `name`, and derivation strips diacritics rather than transliterating them
 * (`Büroreinigung` → `buroreinigung`, not `bueroreinigung`). Curated slugs must
 * be given explicitly, because a page's URL depends on them.
 */

/** A single problem found in the sheet, addressed by 1-based row number. */
export interface CsvIssue {
  row: number;
  column: string;
  message: string;
}

/** Thrown when a sheet contains any invalid row. Reports every issue at once. */
export class CsvImportError extends Error {
  override readonly name = "CsvImportError";

  constructor(
    readonly filePath: string,
    readonly issues: CsvIssue[],
  ) {
    super(`${filePath}: ${issues.length} invalid row(s)`);
  }
}

/** The two entity collections a sheet produces. */
export interface CsvImportResult {
  services: Service[];
  locations: Location[];
}

/** A raw CSV record: every column arrives as a string. */
type CsvRow = Record<string, string | undefined>;

/** Trim a cell, treating whitespace-only and missing cells alike as absent. */
function cell(row: CsvRow, column: string): string | undefined {
  const value = row[column]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Split a `|`-separated cell into trimmed, non-empty parts. */
function list(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Parse a `from|to|currency` pricing cell. Returns undefined when absent. */
function parsePricing(value: string | undefined): unknown {
  const parts = list(value);
  if (parts.length === 0) {
    return undefined;
  }
  const [from, to, currency] = parts;
  return {
    from: Number(from),
    to: Number(to),
    ...(currency !== undefined ? { currency } : {}),
  };
}

/** Parse a `lat|lng` coordinates cell. Returns undefined when absent. */
function parseCoordinates(value: string | undefined): unknown {
  const parts = list(value);
  if (parts.length === 0) {
    return undefined;
  }
  const [lat, lng] = parts;
  return { lat: Number(lat), lng: Number(lng) };
}

/** Assemble a service candidate from one row (validated by the caller). */
function toServiceCandidate(row: CsvRow, name: string): unknown {
  const slug = cell(row, "slug") ?? generateSlug(name);
  const pricing = parsePricing(cell(row, "pricing"));

  return {
    id: cell(row, "id") ?? `svc-${slug}`,
    name,
    slug,
    description: cell(row, "description") ?? "",
    benefits: list(cell(row, "benefits")),
    ...(pricing !== undefined ? { pricing } : {}),
    ...(cell(row, "templateId") !== undefined
      ? { templateId: cell(row, "templateId") }
      : {}),
  };
}

/** Assemble a location candidate from one row (validated by the caller). */
function toLocationCandidate(row: CsvRow, name: string): unknown {
  const coordinates = parseCoordinates(cell(row, "coordinates"));

  return {
    id: cell(row, "id") ?? `loc-${generateSlug(name)}`,
    city: name,
    state: cell(row, "state") ?? "",
    country: cell(row, "country") ?? "DE",
    ...(cell(row, "postalCode") !== undefined
      ? { postalCode: cell(row, "postalCode") }
      : {}),
    ...(coordinates !== undefined ? { coordinates } : {}),
  };
}

/**
 * Read and validate a CSV sheet into services and locations.
 *
 * Collects every issue across the whole sheet and throws once, so a bad import
 * is fixed in a single pass rather than one row per run — the same failure
 * style the generator's validation uses.
 *
 * @param filePath - Path to the CSV file.
 * @returns The parsed services and locations, in sheet order.
 * @throws {CsvImportError} If any row is missing a required column, carries an
 * unknown `type`, or fails its schema.
 */
export function importFromCsv(filePath: string): CsvImportResult {
  const raw = readFileSync(filePath, "utf8");

  const rows = parse(raw, {
    columns: (header: string[]) => header.map((name) => name.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as CsvRow[];

  const services: Service[] = [];
  const locations: Location[] = [];
  const issues: CsvIssue[] = [];

  rows.forEach((row, index) => {
    // +2: one for the header line, one to make the number 1-based, so it
    // matches what a spreadsheet shows.
    const rowNumber = index + 2;

    const type = cell(row, "type")?.toLowerCase();
    const name = cell(row, "name");

    if (name === undefined) {
      issues.push({ row: rowNumber, column: "name", message: "name is required." });
      return;
    }

    if (type !== "service" && type !== "location") {
      issues.push({
        row: rowNumber,
        column: "type",
        message: `Unknown type "${type ?? ""}". Expected "service" or "location".`,
      });
      return;
    }

    const schema = type === "service" ? ServiceSchema : LocationSchema;
    const candidate =
      type === "service"
        ? toServiceCandidate(row, name)
        : toLocationCandidate(row, name);

    const result = schema.safeParse(candidate);

    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          row: rowNumber,
          column: issue.path.join(".") || type,
          message: issue.message,
        });
      }
      return;
    }

    if (type === "service") {
      services.push(result.data as Service);
    } else {
      locations.push(result.data as Location);
    }
  });

  // Duplicate ids would silently collapse entities downstream — the generator
  // indexes by id, so two rows sharing one id means one of them disappears.
  collectDuplicateIds(services, "service", issues);
  collectDuplicateIds(locations, "location", issues);

  if (issues.length > 0) {
    throw new CsvImportError(filePath, issues);
  }

  return { services, locations };
}

/** Record an issue for every repeated id in a collection. */
function collectDuplicateIds(
  items: Array<{ id: string }>,
  label: "service" | "location",
  issues: CsvIssue[],
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      issues.push({
        row: index + 2,
        column: "id",
        message: `Duplicate ${label} id "${item.id}".`,
      });
    }
    seen.add(item.id);
  }
}
