import { join } from "node:path";
import { loadJsonFile } from "./load-json.js";
import type { InputPaths, RawInputData } from "./types.js";

/**
 * Load all four input files in parallel and return them as raw, unvalidated data.
 *
 * This intentionally performs **no validation** — every field of the returned
 * {@link RawInputData} is `unknown`. Validating the shape against the schemas is
 * the responsibility of a later step.
 *
 * @param paths - Resolved file paths for each input source.
 * @returns The parsed-but-unvalidated contents of every input file.
 * @throws {FileNotFoundError} If any file is missing.
 * @throws {InvalidJsonError} If any file contains invalid JSON.
 */
export async function loadInputData(paths: InputPaths): Promise<RawInputData> {
  const [businesses, services, locations, content] = await Promise.all([
    loadJsonFile(paths.businesses),
    loadJsonFile(paths.services),
    loadJsonFile(paths.locations),
    loadJsonFile(paths.content),
  ]);

  return { businesses, services, locations, content };
}

/**
 * Build the standard set of input paths relative to a root directory.
 *
 * Uses {@link join} for cross-platform path construction.
 *
 * @param rootDir - The directory containing the input JSON files.
 * @returns The conventional {@link InputPaths} for that directory.
 */
export function defaultInputPaths(rootDir: string): InputPaths {
  return {
    businesses: join(rootDir, "businesses.json"),
    services: join(rootDir, "services.json"),
    locations: join(rootDir, "locations.json"),
    content: join(rootDir, "content.json"),
  };
}
