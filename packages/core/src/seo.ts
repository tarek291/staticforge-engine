/** Default maximum length for an SEO meta description. */
const DEFAULT_META_DESCRIPTION_LENGTH = 160;

/** Default maximum length for an SEO page title. */
const DEFAULT_TITLE_LENGTH = 70;

/**
 * Truncate text to fit within an SEO meta-description budget.
 *
 * If the text is within `maxLength` it is returned unchanged. Otherwise it is
 * cut at the last word boundary that fits (including a trailing ellipsis) so
 * words are not split. Pure function.
 *
 * @param text - The source description.
 * @param maxLength - Maximum length including the ellipsis (default 160).
 * @returns The truncated description.
 */
export function truncateMetaDescription(
  text: string,
  maxLength: number = DEFAULT_META_DESCRIPTION_LENGTH,
): string {
  return truncateAtWord(text, maxLength);
}

/**
 * Truncate text to fit within an SEO title budget.
 *
 * Behaves like {@link truncateMetaDescription} but with a smaller default
 * length suited to page titles. Pure function.
 *
 * @param text - The source title.
 * @param maxLength - Maximum length including the ellipsis (default 70).
 * @returns The truncated title.
 */
export function truncateTitle(
  text: string,
  maxLength: number = DEFAULT_TITLE_LENGTH,
): string {
  return truncateAtWord(text, maxLength);
}

/**
 * Build an absolute canonical URL from a base URL and a page slug.
 *
 * Trailing slashes on the base and leading slashes on the slug are normalized
 * so exactly one separator joins them. Pure function.
 *
 * @param baseUrl - The site origin or base path (e.g. "https://example.com").
 * @param slug - The page slug (with or without a leading slash).
 * @returns The joined canonical URL.
 */
export function generateCanonicalUrl(baseUrl: string, slug: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedSlug = slug.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedSlug}`;
}

/**
 * Truncate text at a word boundary, appending an ellipsis when shortened.
 * Internal helper shared by the title/description truncators.
 */
function truncateAtWord(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const ellipsis = "…";
  const budget = maxLength - ellipsis.length;
  const hardCut = trimmed.slice(0, budget);
  const lastSpace = hardCut.lastIndexOf(" ");
  const body = lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut;

  return `${body.replace(/[\s.,;:!?-]+$/, "")}${ellipsis}`;
}
