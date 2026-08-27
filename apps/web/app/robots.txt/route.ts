import { readPublishedArtifact } from "@/lib/staticforge-output";

/** Serves the robots.txt the generator produced. See sitemap.xml/route.ts. */
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const body = await readPublishedArtifact("robots.txt");

  if (body === null) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
