/**
 * Convert an international phone string into a `tel:` URL.
 *
 * Normalizes by keeping a single leading `+` and the digits (stripping spaces,
 * parentheses, dashes, and other separators). Requires an international format:
 * `+` followed by 8–15 digits (E.164 range) — no country-specific assumptions.
 * Pure function — does not mutate its input.
 *
 * @param phone - The raw phone string (e.g. "+49 203 1234567").
 * @returns `tel:+<digits>` when valid, otherwise `null`.
 */
export function toTelHref(phone: string): string | null {
  const trimmed = phone.trim();
  if (!trimmed.startsWith("+")) {
    return null;
  }
  const digits = trimmed.replace(/\D/g, "");
  const normalized = `+${digits}`;
  if (!/^\+\d{8,15}$/.test(normalized)) {
    return null;
  }
  return `tel:${normalized}`;
}
