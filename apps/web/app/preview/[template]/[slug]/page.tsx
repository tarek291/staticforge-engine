import type { Metadata } from "next";
import type { ReactElement } from "react";
import { notFound } from "next/navigation";
import {
  getGeneratedPageBySlug,
  getGeneratedPageSlugs,
} from "@/lib/staticforge-output";
import {
  getTemplateView,
  getTemplateIds,
} from "@/app/[slug]/templateRegistry";

// Only prerender the (template × slug) combinations enumerated below.
export const dynamicParams = false;

interface Props {
  params: Promise<{ template: string; slug: string }>;
}

export async function generateStaticParams(): Promise<
  Array<{ template: string; slug: string }>
> {
  const templateIds = getTemplateIds();
  const slugs = await getGeneratedPageSlugs();
  return templateIds.flatMap((template) =>
    slugs.map((slug) => ({ template, slug })),
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await getGeneratedPageBySlug(slug);
  // Preview pages should never be indexed.
  const robots = { index: false, follow: false };
  if (page === null) {
    return { robots };
  }
  return {
    title: page.title,
    description: page.metaDescription,
    robots,
  };
}

export default async function TemplatePreviewRoute({
  params,
}: Props): Promise<ReactElement> {
  const { template, slug } = await params;
  const page = await getGeneratedPageBySlug(slug);
  if (page === null) {
    notFound();
  }

  // Render the page data through the requested template (ignores the page's
  // own templateId — that is the point of the preview).
  const TemplateView = getTemplateView(template);
  return <TemplateView page={page} />;
}
