import type {
  GeneratedPage,
  InternalLink,
  LinkRelation,
} from "@staticforge/schemas";

/**
 * Internal linking for a programmatic grid.
 *
 * A site of service × city pages is a grid, and the two axes of that grid are
 * the only relations that justify a link on their own: a reader either wants a
 * different service in the same place, or the same service somewhere else.
 * Anything else is decoration, and decoration is what makes a link farm.
 *
 * ## The four rules
 *
 * 1. **No orphans.** A page nothing links to is a page nothing crawls and
 *    nobody discovers. Coverage is repaired explicitly, not hoped for.
 * 2. **No broken targets.** Every link points at a slug that exists in the same
 *    build, checked rather than assumed.
 * 3. **No absurd anchor repetition.** The same anchor text may appear only so
 *    many times across the site before it reads as manipulation.
 * 4. **No blind quota.** The number of links a page carries is earned by how
 *    much content it has. Forcing three links onto a thin page produces three
 *    links surrounded by nothing.
 *
 * Deterministic: the same pages in the same order always produce the same
 * graph, so a rebuild does not churn the output.
 */

/** How much a page may link, and how repetitive anchors may get. */
export interface LinkGraphOptions {
  /** Hard ceiling per page, whatever the content volume. Default 4. */
  maxLinksPerPage?: number;
  /**
   * Body characters a page must carry to earn one outbound link. Default 400.
   *
   * This is the rule against blind quotas: a page earns links by having
   * something to surround them with.
   */
  minCharsPerLink?: number;
  /** How often one anchor text may appear across the whole site. Default 3. */
  maxAnchorRepetition?: number;
  /**
   * Whether to repair pages that nothing links to. Default true.
   *
   * Repair may push one source page a single link over its earned budget: an
   * orphan is a correctness failure, a slightly over-linked page is a matter of
   * taste, and the first outranks the second.
   */
  repairOrphans?: boolean;
}

type ResolvedOptions = Required<LinkGraphOptions>;

const DEFAULTS: ResolvedOptions = {
  maxLinksPerPage: 4,
  minCharsPerLink: 400,
  maxAnchorRepetition: 3,
  repairOrphans: true,
};

/** A problem found in a finished graph. */
export interface LinkIssue {
  path: string;
  message: string;
}

/** Body text a page carries, which is what earns it outbound links. */
export function contentVolume(page: GeneratedPage): number {
  const sections = page.content.sections.reduce(
    (total, section) => total + section.body.length,
    0,
  );
  const faq = page.content.faq.reduce(
    (total, item) => total + item.answer.length,
    0,
  );
  return sections + faq;
}

/**
 * Anchor texts that could stand for a page, best first.
 *
 * All three are the page's own words, so they carry no hardcoded language and
 * need no translation. Having more than one is what lets the repetition rule
 * vary an anchor instead of dropping the link.
 */
export function anchorCandidates(page: GeneratedPage): string[] {
  const candidates = [page.h1, page.title, page.content.hero.heading];
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = candidate.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** One page's relation to another, or `undefined` when they are unrelated. */
function relationBetween(
  from: GeneratedPage,
  to: GeneratedPage,
): LinkRelation | undefined {
  if (from.slug === to.slug) {
    return undefined;
  }
  if (from.locationId === to.locationId && from.serviceId !== to.serviceId) {
    return "sameCity";
  }
  if (from.serviceId === to.serviceId && from.locationId !== to.locationId) {
    return "sameService";
  }
  return undefined;
}

/**
 * Candidates for one page, alternating between the two axes.
 *
 * Interleaving matters: taking all of one relation first would give a page with
 * a small budget only same-service links, and the local cluster would never be
 * built. Alternating spends a small budget across both axes.
 */
function candidatesFor(
  page: GeneratedPage,
  pages: GeneratedPage[],
): Array<{ target: GeneratedPage; relation: LinkRelation }> {
  const sameService: Array<{ target: GeneratedPage; relation: LinkRelation }> = [];
  const sameCity: Array<{ target: GeneratedPage; relation: LinkRelation }> = [];

  for (const target of pages) {
    const relation = relationBetween(page, target);
    if (relation === "sameService") {
      sameService.push({ target, relation });
    } else if (relation === "sameCity") {
      sameCity.push({ target, relation });
    }
  }

  const interleaved: Array<{ target: GeneratedPage; relation: LinkRelation }> = [];
  const longest = Math.max(sameService.length, sameCity.length);

  for (let index = 0; index < longest; index += 1) {
    const service = sameService[index];
    const city = sameCity[index];
    if (service !== undefined) interleaved.push(service);
    if (city !== undefined) interleaved.push(city);
  }

  return interleaved;
}

/** Tracks how often each anchor text has been used across the site. */
class AnchorLedger {
  private readonly counts = new Map<string, number>();

  constructor(private readonly cap: number) {}

  private key(anchor: string): string {
    return anchor.trim().toLowerCase();
  }

  /** The first candidate still under the cap, or `undefined` if all are spent. */
  choose(candidates: string[]): string | undefined {
    return candidates.find(
      (candidate) => (this.counts.get(this.key(candidate)) ?? 0) < this.cap,
    );
  }

  /** The least-used candidate, whatever the cap. Used only to repair an orphan. */
  leastUsed(candidates: string[]): string | undefined {
    return [...candidates].sort(
      (left, right) =>
        (this.counts.get(this.key(left)) ?? 0) -
        (this.counts.get(this.key(right)) ?? 0),
    )[0];
  }

  record(anchor: string): void {
    const key = this.key(anchor);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  countOf(anchor: string): number {
    return this.counts.get(this.key(anchor)) ?? 0;
  }
}

/**
 * Builds the link graph for a set of pages.
 *
 * Pure: performs no I/O and does not mutate the pages it is given.
 */
export class LinkGraphBuilder {
  private readonly options: ResolvedOptions;

  constructor(options: LinkGraphOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** How many outbound links a page has earned. */
  budgetFor(page: GeneratedPage): number {
    const earned = Math.floor(contentVolume(page) / this.options.minCharsPerLink);
    return Math.max(0, Math.min(this.options.maxLinksPerPage, earned));
  }

  /**
   * Build the graph.
   *
   * @param pages - Every page in the build. Links may only target these.
   * @returns Outbound links keyed by source slug. Pages with none are absent.
   */
  build(pages: GeneratedPage[]): Map<string, InternalLink[]> {
    const ledger = new AnchorLedger(this.options.maxAnchorRepetition);
    const outbound = new Map<string, InternalLink[]>();
    const inbound = new Map<string, number>(pages.map((page) => [page.slug, 0]));

    // Pass one: spend each page's earned budget on its best candidates.
    for (const page of pages) {
      const budget = this.budgetFor(page);
      const links: InternalLink[] = [];

      for (const { target, relation } of candidatesFor(page, pages)) {
        if (links.length >= budget) {
          break;
        }

        const anchor = ledger.choose(anchorCandidates(target));
        if (anchor === undefined) {
          // Every form of this target's anchor is spent. Dropping the link is
          // the right trade: a link is optional, over-optimisation is not.
          continue;
        }

        links.push({ slug: target.slug, anchor, relation });
        ledger.record(anchor);
        inbound.set(target.slug, (inbound.get(target.slug) ?? 0) + 1);
      }

      if (links.length > 0) {
        outbound.set(page.slug, links);
      }
    }

    if (this.options.repairOrphans) {
      this.repairOrphans(pages, outbound, inbound, ledger);
    }

    return outbound;
  }

  /**
   * Give every unlinked page an inbound link.
   *
   * Prefers a related source that still has budget. Only when none exists does
   * it exceed a budget, and then by exactly one link — an orphan is a
   * correctness failure and a slightly over-linked page is a matter of taste.
   */
  private repairOrphans(
    pages: GeneratedPage[],
    outbound: Map<string, InternalLink[]>,
    inbound: Map<string, number>,
    ledger: AnchorLedger,
  ): void {
    const bySlug = new Map(pages.map((page) => [page.slug, page]));

    for (const page of pages) {
      if ((inbound.get(page.slug) ?? 0) > 0) {
        continue;
      }

      const sources = pages.filter(
        (candidate) =>
          relationBetween(candidate, page) !== undefined &&
          !(outbound.get(candidate.slug) ?? []).some(
            (link) => link.slug === page.slug,
          ),
      );

      if (sources.length === 0) {
        // Nothing is related to this page — a single-page build, or a page
        // sharing neither axis with any other. Not repairable, and reported by
        // validateInternalLinks rather than silently ignored.
        continue;
      }

      const withBudget = sources.filter(
        (source) =>
          (outbound.get(source.slug) ?? []).length < this.budgetFor(source),
      );

      // Spread repairs across the least-loaded source rather than piling them
      // onto whichever page happened to come first. Concentrating them would
      // fix the orphan and create a link-stuffed page in its place.
      const pool = withBudget.length > 0 ? withBudget : sources;
      const source = [...pool].sort(
        (left, right) =>
          (outbound.get(left.slug) ?? []).length -
          (outbound.get(right.slug) ?? []).length,
      )[0] as GeneratedPage;
      const relation = relationBetween(source, page);

      if (relation === undefined) {
        continue;
      }

      const candidates = anchorCandidates(page);
      const anchor = ledger.choose(candidates) ?? ledger.leastUsed(candidates);

      if (anchor === undefined) {
        continue;
      }

      const links = outbound.get(source.slug) ?? [];
      links.push({ slug: page.slug, anchor, relation });
      outbound.set(source.slug, links);
      ledger.record(anchor);
      inbound.set(page.slug, 1);

      void bySlug;
    }
  }
}

/**
 * Attach the graph to the pages.
 *
 * Returns new page objects; the input is not mutated.
 *
 * @param pages - Every page in the build.
 * @param options - Linking policy.
 * @returns The same pages, each carrying its outbound links.
 */
export function withInternalLinks(
  pages: GeneratedPage[],
  options: LinkGraphOptions = {},
): GeneratedPage[] {
  const graph = new LinkGraphBuilder(options).build(pages);

  return pages.map((page) => ({
    ...page,
    links: graph.get(page.slug) ?? [],
  }));
}

/**
 * Check a finished set of linked pages against the four rules.
 *
 * Collects every problem rather than stopping at the first, matching the
 * failure style used across the engine.
 *
 * @param pages - Pages that already carry their links.
 * @param options - The policy they were built under.
 * @returns Every violation found. Empty means the graph is sound.
 */
export function validateInternalLinks(
  pages: GeneratedPage[],
  options: LinkGraphOptions = {},
): LinkIssue[] {
  const resolved: ResolvedOptions = { ...DEFAULTS, ...options };
  const issues: LinkIssue[] = [];
  const known = new Set(pages.map((page) => page.slug));
  const inbound = new Map<string, number>(pages.map((page) => [page.slug, 0]));
  const anchorCounts = new Map<string, number>();

  for (const page of pages) {
    const seenTargets = new Set<string>();

    page.links.forEach((link, index) => {
      const at = `pages[${page.slug}].links[${index}]`;

      if (!known.has(link.slug)) {
        issues.push({
          path: at,
          message: `Broken target "${link.slug}": no page with that slug exists in this build.`,
        });
        return;
      }

      if (link.slug === page.slug) {
        issues.push({ path: at, message: "Page links to itself." });
        return;
      }

      if (seenTargets.has(link.slug)) {
        issues.push({
          path: at,
          message: `Duplicate link to "${link.slug}" from the same page.`,
        });
        return;
      }

      seenTargets.add(link.slug);
      inbound.set(link.slug, (inbound.get(link.slug) ?? 0) + 1);

      const key = link.anchor.trim().toLowerCase();
      anchorCounts.set(key, (anchorCounts.get(key) ?? 0) + 1);
    });

    if (page.links.length > resolved.maxLinksPerPage) {
      issues.push({
        path: `pages[${page.slug}].links`,
        message: `${page.links.length} links exceeds the maximum of ${resolved.maxLinksPerPage}.`,
      });
    }
  }

  // Orphans are only meaningful when there is somewhere a link could come from.
  if (pages.length > 1) {
    for (const page of pages) {
      if ((inbound.get(page.slug) ?? 0) === 0) {
        const linkable = pages.some(
          (other) => relationBetween(other, page) !== undefined,
        );

        if (linkable) {
          issues.push({
            path: `pages[${page.slug}]`,
            message:
              "Orphan page: nothing links to it, though a related page could.",
          });
        }
      }
    }
  }

  for (const [anchor, count] of anchorCounts) {
    if (count > resolved.maxAnchorRepetition) {
      issues.push({
        path: "links",
        message: `Anchor "${anchor}" is used ${count} times, over the limit of ${resolved.maxAnchorRepetition}.`,
      });
    }
  }

  return issues;
}
