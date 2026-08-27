import { prisma } from "@staticforge/database";

/**
 * Read models for the dashboard.
 *
 * Every query returns a plain, serialisable shape rather than a Prisma row:
 * Decimal and Date values cannot cross the server/client boundary, and shaping
 * here keeps that conversion in one place instead of scattered through the JSX.
 *
 * Reads only. Nothing in the dashboard writes to the database — the engine owns
 * that, and a second writer would be a second source of truth.
 */

/** A project as the index lists it. */
export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  locale: string;
  templateId: string;
  contentProfileId: string;
  workspaceName: string;
  businessName: string | null;
  serviceCount: number;
  locationCount: number;
  pageCount: number;
  /** Pages the grid would produce, for comparison with what exists. */
  expectedPages: number;
}

/** Everything one project's detail view shows. */
export interface ProjectDetail extends ProjectSummary {
  services: Array<{
    id: string;
    name: string;
    slug: string;
    templateId: string | null;
    contentProfileId: string | null;
  }>;
  locations: Array<{ id: string; name: string; city: string; state: string }>;
  pages: Array<{
    slug: string;
    title: string;
    templateId: string;
    contentProfileId: string;
    source: string;
    linkCount: number;
    updatedAt: string;
  }>;
}

/** Whether the database is reachable at all. */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    // A missing or unreachable database is an ordinary state for this
    // dashboard — the engine also runs entirely from local files.
    return false;
  }
}

/** List every project, with the counts an operator scans for. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const projects = await prisma.project.findMany({
    orderBy: [{ workspaceId: "asc" }, { slug: "asc" }],
    include: {
      workspace: { select: { name: true } },
      business: { select: { name: true } },
      _count: { select: { services: true, locations: true, generatedPages: true } },
    },
  });

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    locale: project.locale,
    templateId: project.templateId,
    contentProfileId: project.contentProfileId,
    workspaceName: project.workspace.name,
    businessName: project.business?.name ?? null,
    serviceCount: project._count.services,
    locationCount: project._count.locations,
    pageCount: project._count.generatedPages,
    expectedPages: project._count.services * project._count.locations,
  }));
}

/** Load one project in full, or `null` when it does not exist. */
export async function getProjectDetail(id: string): Promise<ProjectDetail | null> {
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      workspace: { select: { name: true } },
      business: { select: { name: true } },
      services: { orderBy: { slug: "asc" } },
      locations: { orderBy: { slug: "asc" } },
      generatedPages: { orderBy: { slug: "asc" } },
      _count: { select: { services: true, locations: true, generatedPages: true } },
    },
  });

  if (project === null) {
    return null;
  }

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    locale: project.locale,
    templateId: project.templateId,
    contentProfileId: project.contentProfileId,
    workspaceName: project.workspace.name,
    businessName: project.business?.name ?? null,
    serviceCount: project._count.services,
    locationCount: project._count.locations,
    pageCount: project._count.generatedPages,
    expectedPages: project._count.services * project._count.locations,

    services: project.services.map((service) => ({
      id: service.id,
      name: service.name,
      slug: service.slug,
      templateId: service.templateId,
      contentProfileId: service.contentProfileId,
    })),

    locations: project.locations.map((location) => ({
      id: location.id,
      name: location.name,
      city: location.city,
      state: location.state,
    })),

    pages: project.generatedPages.map((page) => ({
      slug: page.slug,
      title: page.title,
      templateId: page.templateId,
      contentProfileId: page.contentProfileId,
      source: page.source,
      // `links` is a Json column; its length is all the table shows.
      linkCount: Array.isArray(page.links) ? page.links.length : 0,
      updatedAt: page.updatedAt.toISOString(),
    })),
  };
}
