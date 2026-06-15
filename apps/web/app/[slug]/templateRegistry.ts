import type { ReactElement } from "react";
import type { GeneratedPage } from "@staticforge/schemas";
import { GeneratedPageView } from "./GeneratedPageView";
import { LuxuryLandingView } from "./LuxuryLandingView";

/** A presentation view: receives a validated page and returns JSX. */
export type TemplateView = (props: { page: GeneratedPage }) => ReactElement;

/**
 * Maps a page-level `templateId` to its presentation view. Currently a single
 * `"default"` entry; unknown ids fall back to the default view.
 */
const TEMPLATE_REGISTRY: Record<string, TemplateView> = {
  default: GeneratedPageView,
  luxuryLanding: LuxuryLandingView,
};

/**
 * Resolve the view component for a given `templateId`.
 *
 * Pure and synchronous — performs no data loading or I/O. Any unknown or future
 * id falls back to {@link GeneratedPageView} so rendering stays stable.
 *
 * @param templateId - The page's template identifier.
 * @returns The matching view, or the default view as a fallback.
 */
export function getTemplateView(templateId: string): TemplateView {
  return TEMPLATE_REGISTRY[templateId] ?? GeneratedPageView;
}
