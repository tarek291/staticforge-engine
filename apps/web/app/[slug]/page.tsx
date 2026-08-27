import type { Metadata } from "next";
import type { ReactElement } from "react";
import { notFound } from "next/navigation";
import { buildPageMetadata } from "@staticforge/core";
import {
  getGeneratedPageBySlug,
  getGeneratedPageSlugs,
  getGeneratedPages,
  getSiteConfig,
} from "@/lib/staticforge-output";
import { getTemplateView } from "./templateRegistry";

// Only serve slugs generated at build time; unknown slugs 404 immediately.
export const dynamicParams = false;

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams(): Promise<Array<{ slug: string }>> {
  const slugs = await getGeneratedPageSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await getGeneratedPageBySlug(slug);
  if (page === null) {
    return {};
  }

  const base: Metadata = {
    title: page.title,
    description: page.metaDescription,
  };

  const site = await getSiteConfig();
  if (site === null) {
    // No domain configured: emit what does not need one rather than inventing
    // an origin, which would publish a canonical pointing at nowhere.
    return base;
  }

  const pages = await getGeneratedPages();
  const meta = buildPageMetadata(page, site, pages);

  return {
    ...base,
    alternates: {
      canonical: meta.canonical,
      ...(meta.alternates.length > 0
        ? {
            languages: Object.fromEntries(
              meta.alternates.map((alternate) => [
                alternate.hreflang,
                alternate.href,
              ]),
            ),
          }
        : {}),
    },
    robots: { index: meta.robots.index, follow: meta.robots.follow },
    openGraph: {
      title: meta.openGraph.title,
      description: meta.openGraph.description,
      url: meta.openGraph.url,
      type: meta.openGraph.type,
      locale: meta.openGraph.locale,
      siteName: meta.openGraph.siteName,
    },
  };
}

export default async function GeneratedPageRoute({
  params,
}: Props): Promise<ReactElement> {
  const { slug } = await params;
  const page = await getGeneratedPageBySlug(slug);
  if (page === null) {
    notFound();
  }

  const TemplateView = getTemplateView(page.templateId);
  return <TemplateView page={page} />;
}
