import type { Business, Service, Location, Locale } from "@staticforge/schemas";

/**
 * Raw, unvalidated input data loaded from disk.
 *
 * Every field is `unknown` because loading does not validate shape — that is
 * the responsibility of a later validation step.
 */
export interface RawInputData {
  businesses: unknown;
  services: unknown;
  locations: unknown;
  content: unknown;
}

/** Absolute (or resolvable) file paths for each input source. */
export interface InputPaths {
  businesses: string;
  services: string;
  locations: string;
  content: string;
}

/**
 * Static, business-agnostic content template used to render pages.
 * Strings may contain placeholder tokens resolved later during generation.
 */
export interface StaticContentTemplate {
  hero: { titleTemplate: string; subtitleTemplate: string };
  // `cta.secondary` is reserved for a future secondary CTA: accepted in input
  // but not yet rendered or written to generated output.
  cta: { primary: string; secondary: string };
  faqs: Array<{ q: string; a: string }>;
  templateId?: string;
}

/**
 * Fully validated and typed input data, ready for page generation.
 * Produced by `validateInputData` from {@link RawInputData}.
 */
export interface ValidatedInputData {
  businesses: Business[];
  services: Service[];
  locations: Location[];
  content: StaticContentTemplate;
}

/** Options controlling how pages are built. */
export interface BuildPagesOptions {
  /** Locale assigned to every generated page (`"de" | "en"`). */
  locale: Locale;
}
