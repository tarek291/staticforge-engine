import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { CsvImportError, importFromCsv } from "./csv-importer.js";

const HEADER =
  "type,name,slug,id,description,benefits,state,country,postalCode,pricing,coordinates";

/** A description long enough to satisfy `ServiceSchema.description.min(100)`. */
const LONG_DESCRIPTION = "D".repeat(120);

/** Three benefits, the minimum `ServiceSchema` accepts. */
const THREE_BENEFITS = "Vorteil eins|Vorteil zwei|Vorteil drei";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "staticforge-csv-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a sheet (header + rows) to a temp file and return its path. */
function sheet(name: string, ...rows: string[]): string {
  const path = join(dir, `${name}.csv`);
  writeFileSync(path, [HEADER, ...rows].join("\n"), "utf8");
  return path;
}

describe("slug handling", () => {
  test("derives a slug from a German name when none is given", () => {
    const path = sheet(
      "derived",
      `service,Büroreinigung,,,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
    );

    const { services } = importFromCsv(path);

    expect(services).toHaveLength(1);
    // generateSlug strips diacritics rather than transliterating them, so "ü"
    // collapses to "u". This is the documented behaviour, not a typo.
    expect(services[0]?.slug).toBe("buroreinigung");
    expect(services[0]?.id).toBe("svc-buroreinigung");
  });

  test("uses an explicit slug verbatim and skips derivation", () => {
    const path = sheet(
      "explicit",
      `service,Büroreinigung,bueroreinigung,,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
    );

    const { services } = importFromCsv(path);

    // The curated German transliteration survives — this is what keeps the
    // published /bueroreinigung-* routes stable.
    expect(services[0]?.slug).toBe("bueroreinigung");
    expect(services[0]?.id).toBe("svc-bueroreinigung");
  });

  test("an explicit id overrides the slug-derived default", () => {
    const path = sheet(
      "explicit-id",
      `service,Büroreinigung,bueroreinigung,svc-custom,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
    );

    const { services } = importFromCsv(path);

    expect(services[0]?.id).toBe("svc-custom");
    expect(services[0]?.slug).toBe("bueroreinigung");
  });

  test("derives a location id from the city name", () => {
    const path = sheet(
      "loc-id",
      `location,Düsseldorf,,,,,Nordrhein-Westfalen,,,,`,
    );

    const { locations } = importFromCsv(path);

    expect(locations[0]?.id).toBe("loc-dusseldorf");
    expect(locations[0]?.city).toBe("Düsseldorf");
  });
});

describe("optional columns", () => {
  test("parses pipe-separated pricing and coordinates", () => {
    const path = sheet(
      "optional",
      `service,Grundreinigung,,,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,35|60|EUR,`,
      `location,Essen,,,,,Nordrhein-Westfalen,DE,45127,,51.4556|7.0116`,
    );

    const { services, locations } = importFromCsv(path);

    expect(services[0]?.pricing).toEqual({ from: 35, to: 60, currency: "EUR" });
    expect(locations[0]?.coordinates).toEqual({ lat: 51.4556, lng: 7.0116 });
    expect(locations[0]?.postalCode).toBe("45127");
  });

  test("omits pricing and coordinates when their cells are empty", () => {
    const path = sheet(
      "no-optional",
      `service,Treppenhausreinigung,,,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
      `location,Duisburg,,,,,Nordrhein-Westfalen,,,,`,
    );

    const { services, locations } = importFromCsv(path);

    expect(services[0]?.pricing).toBeUndefined();
    expect(locations[0]?.coordinates).toBeUndefined();
    expect(locations[0]?.postalCode).toBeUndefined();
  });

  test("defaults a location country to DE", () => {
    const path = sheet("country", `location,Essen,,,,,Nordrhein-Westfalen,,,,`);

    expect(importFromCsv(path).locations[0]?.country).toBe("DE");
  });

  test("splits benefits on the pipe separator", () => {
    const path = sheet(
      "benefits",
      `service,Grundreinigung,,,${LONG_DESCRIPTION},"a | b | c",,,,,`,
    );

    expect(importFromCsv(path).services[0]?.benefits).toEqual(["a", "b", "c"]);
  });
});

describe("fail-loud validation", () => {
  /** Run an import expected to fail and hand back the collected issues. */
  function issuesFrom(path: string) {
    try {
      importFromCsv(path);
    } catch (error) {
      expect(error).toBeInstanceOf(CsvImportError);
      return (error as CsvImportError).issues;
    }
    throw new Error("expected importFromCsv to throw");
  }

  test("rejects a description shorter than the schema minimum", () => {
    const path = sheet(
      "short-description",
      `service,Kurzdienst,,,zu kurz,${THREE_BENEFITS},,,,,`,
    );

    const issues = issuesFrom(path);

    expect(issues).toContainEqual({
      row: 2,
      column: "description",
      message: "String must contain at least 100 character(s)",
    });
  });

  test("rejects fewer than three benefits", () => {
    const path = sheet(
      "few-benefits",
      `service,Kurzdienst,,,${LONG_DESCRIPTION},"nur eins|und zwei",,,,,`,
    );

    const issues = issuesFrom(path);

    expect(issues).toContainEqual({
      row: 2,
      column: "benefits",
      message: "Array must contain at least 3 element(s)",
    });
  });

  test("rejects a location without a state", () => {
    const path = sheet("no-state", `location,Köln,,,,,,,,,`);

    const issues = issuesFrom(path);

    expect(issues.some((issue) => issue.column === "state")).toBe(true);
  });

  test("rejects an unknown type", () => {
    const path = sheet("bad-type", `widget,Nonsense,,,,,,,,,`);

    const issues = issuesFrom(path);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.column).toBe("type");
    expect(issues[0]?.message).toContain('Unknown type "widget"');
  });

  test("rejects a row with no name", () => {
    const path = sheet(
      "no-name",
      `service,,,,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
    );

    const issues = issuesFrom(path);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ row: 2, column: "name" });
  });

  test("rejects duplicate ids, which would silently drop an entity", () => {
    const path = sheet(
      "duplicate-ids",
      `service,Erste,,svc-same,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
      `service,Zweite,,svc-same,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
    );

    const issues = issuesFrom(path);

    expect(issues.some((issue) => issue.message.includes("Duplicate service id"))).toBe(
      true,
    );
  });

  test("collects issues across the whole sheet in one pass", () => {
    const path = sheet(
      "many",
      `service,Kurzdienst,,,zu kurz,nur eins,,,,,`,
      `location,Köln,,,,,,,,,`,
      `widget,Nonsense,,,,,,,,,`,
    );

    const issues = issuesFrom(path);

    // Not one failure per run: every bad row is reported together.
    expect(issues.length).toBeGreaterThanOrEqual(4);
    expect(new Set(issues.map((issue) => issue.row))).toEqual(new Set([2, 3, 4]));
  });

  test("reports rows by the number a spreadsheet shows", () => {
    const path = sheet(
      "row-numbers",
      `service,Gut,,,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
      `service,Schlecht,,,zu kurz,${THREE_BENEFITS},,,,,`,
    );

    const issues = issuesFrom(path);

    // Header is line 1, the good row is 2, so the bad row is 3.
    expect(issues.every((issue) => issue.row === 3)).toBe(true);
  });
});

describe("sheet handling", () => {
  test("returns empty collections for a header-only sheet", () => {
    const path = sheet("empty");

    expect(importFromCsv(path)).toEqual({ services: [], locations: [] });
  });

  test("preserves sheet order within each collection", () => {
    const path = sheet(
      "order",
      `service,Erste,,,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
      `location,Duisburg,,,,,Nordrhein-Westfalen,,,,`,
      `service,Zweite,,,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
      `location,Essen,,,,,Nordrhein-Westfalen,,,,`,
    );

    const { services, locations } = importFromCsv(path);

    expect(services.map((item) => item.name)).toEqual(["Erste", "Zweite"]);
    expect(locations.map((item) => item.city)).toEqual(["Duisburg", "Essen"]);
  });

  test("ignores case in the type column", () => {
    const path = sheet(
      "case",
      `SERVICE,Erste,,,${LONG_DESCRIPTION},${THREE_BENEFITS},,,,,`,
      `Location,Essen,,,,,Nordrhein-Westfalen,,,,`,
    );

    const { services, locations } = importFromCsv(path);

    expect(services).toHaveLength(1);
    expect(locations).toHaveLength(1);
  });
});
