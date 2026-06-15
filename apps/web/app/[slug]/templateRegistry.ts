import type { ReactElement } from "react";
import type { GeneratedPage } from "@staticforge/schemas";
import { GeneratedPageView } from "./GeneratedPageView";
import { LuxuryLandingView } from "./LuxuryLandingView";

/** A presentation view: receives a validated page and returns JSX. */
export type TemplateView = (props: { page: GeneratedPage }) => ReactElement;

/**
 * Route-local registry mapping a page-level `templateId` to its presentation
 * view. Registered templates are `default` and `luxuryLanding`; an unknown
 * `templateId` throws a clear error (see {@link getTemplateView}). The
 * generator only emits `templateId` strings and stays registry-agnostic.
 */
const TEMPLATE_REGISTRY: Record<string, TemplateView> = {
  default: GeneratedPageView,
  luxuryLanding: LuxuryLandingView,
};

/**
 * Resolve the view component for a given `templateId`.
 *
 * Pure and synchronous — performs no data loading or I/O. Throws on an unknown
 * `templateId` so typos surface loudly at build time rather than silently
 * rendering the default view.
 *
 * @param templateId - The page's template identifier.
 * @returns The matching view.
 * @throws {Error} If `templateId` is not registered.
 */
export function getTemplateView(templateId: string): TemplateView {
  const view = TEMPLATE_REGISTRY[templateId];
  if (view === undefined) {
    throw new Error(
      `Unknown templateId "${templateId}". Registered templates: ${Object.keys(TEMPLATE_REGISTRY).join(", ")}.`,
    );
  }
  return view;
}
