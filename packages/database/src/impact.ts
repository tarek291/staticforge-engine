import type { PageSource, PrismaClient } from "@prisma/client";

import { withDbRetry } from "./retry.js";

/**
 * Which existing pages a change reaches.
 *
 * ## Why this exists
 *
 * A run regenerates a project. That was fine while a project was a demo and is
 * wrong the moment one is a customer: editing the description of one service in
 * a forty-city account re-authors two hundred pages, and pays for every one of
 * them, to change five. The generator cannot know which pages a change reached
 * — it never saw the change. The sync layer saw it and does not know which
 * pages exist. This module is where the two meet.
 *
 * ## Why it is a query and not a computation
 *
 * The eligible cross-product is computable in memory, and the gap analyst does
 * exactly that. But this question is different: it asks which pages *exist*,
 * not which ought to. A page that was never generated cannot be re-authored,
 * and a page whose row an operator has since edited must not be. Only the table
 * knows either.
 *
 * ## What it refuses
 *
 * A page whose `source` is `MANUAL` is never returned, under any argument. That
 * is the whole reason this returns rows rather than slugs computed from a
 * cross-product: a human edited that page, and the value of an incremental run
 * is precisely that it does not have to touch everything, so there is no excuse
 * for it to touch that.
 */

/**
 * Page sources an automated run may rewrite.
 *
 * An allowlist rather than `not: MANUAL`, and the difference is not stylistic.
 * A future `PageSource` — imported, published, approved — would be *included*
 * by a negative filter the moment it was added to the schema, and the first
 * anyone would know is a customer's page being overwritten. An allowlist fails
 * the other way: a new source is skipped until someone decides it is safe to
 * regenerate, which is a conversation rather than an incident.
 */
export const REGENERABLE_PAGE_SOURCES: readonly PageSource[] = ["TEMPLATE", "AI"];

/** One existing page a change reached. */
export interface AffectedPage {
  id: string;
  slug: string;
  serviceId: string;
  locationId: string;
  /** Always one of {@link REGENERABLE_PAGE_SOURCES}. Never `MANUAL`. */
  source: PageSource;
}

/**
 * Find the existing pages a set of changed services and locations reaches.
 *
 * A page is reached when it renders one of the changed services *or* sits in
 * one of the changed locations — the page's content is drawn from both, so
 * either moving makes it stale. A page matching both is one row and is returned
 * once.
 *
 * Scoped to `userId` like every other read in this package. The signature
 * carries the owner even though `projectId` alone would find the rows, because
 * a project id travels in URLs and log lines: knowing one must not be enough to
 * enumerate another tenant's page slugs. Nothing else enforces this — there is
 * no row-level security behind it yet — so the scope in this query *is* the
 * isolation boundary.
 *
 * @param projectId - The project whose pages to search.
 * @param userId - The owner the caller is acting as.
 * @param changedServiceIds - Services whose definition moved.
 * @param changedLocationIds - Locations whose definition moved.
 * @param prisma - The client to read with. Injected so this is testable against
 * a mock with no database.
 * @returns The reached pages, ordered by slug so a caller's output is stable.
 * Empty when nothing changed, when the project is not the caller's, or when
 * every page the change reached is hand-edited.
 */
export async function findAffectedPages(
  projectId: string,
  userId: string,
  changedServiceIds: readonly string[],
  changedLocationIds: readonly string[],
  prisma: PrismaClient,
): Promise<AffectedPage[]> {
  // No change, no query. Short-circuited rather than left to the database
  // because the failure mode of the alternative is severe and quiet: an `OR`
  // over two empty `in` filters is a condition that matches nothing today, and
  // exactly the shape a later refactor "simplifies" into a filter that is
  // dropped — at which point every page in the project is affected and an
  // empty sync queues a full re-author of the account.
  if (changedServiceIds.length === 0 && changedLocationIds.length === 0) {
    return [];
  }

  const rows = await withDbRetry(() =>
    prisma.generatedPage.findMany({
      where: {
        projectId,
        // Scoped through the relation as well as by id, the same way the write
        // path is: a future refactor that drops one still cannot reach another
        // tenant's rows through the other.
        project: { userId },
        // The refusal. Expressed in the query rather than filtered afterwards
        // so there is no window in which a MANUAL page is in a list at all —
        // an in-memory filter is one `.map()` away from being bypassed by a
        // caller who only wanted the slugs.
        source: { in: [...REGENERABLE_PAGE_SOURCES] },
        OR: [
          { serviceId: { in: [...changedServiceIds] } },
          { locationId: { in: [...changedLocationIds] } },
        ],
      },
      select: { id: true, slug: true, serviceId: true, locationId: true, source: true },
      orderBy: { slug: "asc" },
    }),
  );

  return rows;
}

/** The slugs of a set of affected pages, in order. */
export function affectedSlugs(pages: readonly AffectedPage[]): string[] {
  return pages.map((page) => page.slug);
}
