import { readFile } from "node:fs/promises";
import { FileNotFoundError, InvalidJsonError } from "./errors.js";

/** Narrow an unknown error to a Node system error carrying a `code`. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Read a UTF-8 JSON file from disk and return its parsed contents.
 *
 * The generic parameter `T` is the *expected* shape of the parsed value. It is
 * a convenience cast only — this function performs no runtime validation, so
 * the caller is responsible for validating the result if `T` is not `unknown`.
 *
 * @typeParam T - Expected type of the parsed JSON (defaults to `unknown`).
 * @param filePath - Path to the JSON file to read.
 * @returns The parsed JSON value, cast to `T`.
 * @throws {FileNotFoundError} If the file does not exist (ENOENT).
 * @throws {InvalidJsonError} If the file contents are not valid JSON.
 */
export async function loadJsonFile<T = unknown>(filePath: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new FileNotFoundError(filePath, { cause: error });
    }
    throw error;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new InvalidJsonError(filePath, { cause: error });
  }
}
