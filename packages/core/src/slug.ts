/**
 * Convert arbitrary text into a URL-safe slug.
 *
 * Lowercases the input, strips diacritics, replaces any run of
 * non-alphanumeric characters with a single dash, and trims leading/trailing
 * dashes. Pure function — does not mutate its input.
 *
 * @param text - The source text to slugify.
 * @returns A lowercase, dash-separated slug (empty string if no usable chars).
 */
export function generateSlug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Combine multiple text parts into a single slug joined by dashes.
 *
 * Each part is individually slugified, empty results are dropped, and the
 * remaining parts are joined with a single dash. Pure function.
 *
 * @param parts - Ordered text fragments to combine (e.g. service + city).
 * @returns A single dash-separated slug.
 */
export function combineSlug(parts: string[]): string {
  return parts
    .map(generateSlug)
    .filter((part) => part.length > 0)
    .join("-");
}
