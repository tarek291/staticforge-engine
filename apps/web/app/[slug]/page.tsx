import type { Metadata } from "next";
import type { ReactElement } from "react";
import { notFound } from "next/navigation";
import {
  getGeneratedPageBySlug,
  getGeneratedPageSlugs,
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
  return {
    title: page.title,
    description: page.metaDescription,
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
