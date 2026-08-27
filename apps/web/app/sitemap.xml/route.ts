import { readPublishedArtifact } from "@/lib/staticforge-output";

/**
 * Serves the sitemap the generator produced.
 *
 * The file is handed back verbatim rather than rebuilt here: two builders would
 * be two sources of truth, and the one a crawler reads would eventually differ
 * from the one on disk.
 */
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const xml = await readPublishedArtifact("sitemap.xml");

  if (xml === null) {
    // No site URL was configured, so no sitemap was published.
    return new Response("Not found", { status: 404 });
  }

  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
