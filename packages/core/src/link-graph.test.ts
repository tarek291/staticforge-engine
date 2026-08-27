import { GeneratedPageSchema, type GeneratedPage } from "@staticforge/schemas";
import { describe, expect, test } from "vitest";

import {
  LinkGraphBuilder,
  anchorCandidates,
  contentVolume,
  validateInternalLinks,
  withInternalLinks,
} from "./link-graph.js";

/**
 * The grid under test is 3 services × 3 cities — the same shape the sample data
 * produces. Body volume is a parameter, because the rule against blind quotas
 * means link counts are a function of it.
 */

const SERVICES = ["office", "deep", "stairs"] as const;
const CITIES = ["duisburg", "essen", "koeln"] as const;

/** One page, with a body long enough to earn `earns` links at 400 chars each. */
function page(
  service: string,
  city: string,
  earns = 3,
): GeneratedPage {
  return GeneratedPageSchema.parse({
    slug: `${service}-${city}`,
    locale: "de",
    title: `${service} in ${city} – Titel`,
    metaDescription: `Beschreibung für ${service} in ${city} mit ausreichend Text.`,
    h1: `${service} in ${city}`,
    content: {
      hero: { heading: `Hero ${service} ${city}` },
      // `earns: 0` still needs a non-empty body — the contract forbids a blank
      // section — so it becomes one character, which earns nothing.
      sections: [{ heading: "Abschnitt", body: "B".repeat(Math.max(1, 400 * earns)) }],
      faq: [{ question: "Wie schnell?", answer: "Wenige Tage." }],
      cta: { heading: "Angebot", buttonLabel: "Anfragen", href: "#contact" },
    },
    schemaOrg: { "@type": "Service" },
    templateId: "default",
    businessId: "biz-1",
    serviceId: `svc-${service}`,
    locationId: `loc-${city}`,
  });
}

/** The full 3×3 grid. */
function grid(earns = 3): GeneratedPage[] {
  return SERVICES.flatMap((service) =>
    CITIES.map((city) => page(service, city, earns)),
  );
}

/** Every link across a set of pages, tagged with its source. */
function allLinks(pages: GeneratedPage[]) {
  return pages.flatMap((source) =>
    source.links.map((link) => ({ from: source.slug, ...link })),
  );
}

/** How many links point at each slug. */
function inboundCounts(pages: GeneratedPage[]): Map<string, number> {
  const counts = new Map(pages.map((item) => [item.slug, 0]));
  for (const link of allLinks(pages)) {
    counts.set(link.slug, (counts.get(link.slug) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Rule 2: no broken targets
// ---------------------------------------------------------------------------

describe("no broken targets", () => {
  test("every link points at a page in the same build", () => {
    const linked = withInternalLinks(grid());
    const known = new Set(linked.map((item) => item.slug));

    for (const link of allLinks(linked)) {
      expect(known.has(link.slug), `${link.from} → ${link.slug}`).toBe(true);
    }
  });

  test("no page links to itself", () => {
    for (const link of allLinks(withInternalLinks(grid()))) {
      expect(link.slug).not.toBe(link.from);
    }
  });

  test("no page links to the same target twice", () => {
    for (const item of withInternalLinks(grid())) {
      const targets = item.links.map((link) => link.slug);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  test("the validator catches a target that does not exist", () => {
    const [first, ...rest] = withInternalLinks(grid());
    const broken: GeneratedPage = {
      ...first!,
      links: [{ slug: "does-not-exist", anchor: "Anywhere", relation: "sameCity" }],
    };

    const issues = validateInternalLinks([broken, ...rest]);

    expect(issues.some((issue) => issue.message.includes("Broken target"))).toBe(true);
  });

  test("the validator catches a self-link", () => {
    const [first, ...rest] = withInternalLinks(grid());
    const selfish: GeneratedPage = {
      ...first!,
      links: [{ slug: first!.slug, anchor: "Itself", relation: "sameCity" }],
    };

    expect(
      validateInternalLinks([selfish, ...rest]).some((issue) =>
        issue.message.includes("links to itself"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 1: no orphans
// ---------------------------------------------------------------------------

describe("no orphan pages", () => {
  test("every page has at least one inbound link", () => {
    for (const [slug, count] of inboundCounts(withInternalLinks(grid()))) {
      expect(count, `${slug} has no inbound links`).toBeGreaterThan(0);
    }
  });

  test("holds even when pages are too thin to earn a budget", () => {
    // Bodies of 100 characters earn zero links at 400 per link. Coverage must
    // still be repaired, because an orphan is a correctness failure.
    const thin = grid(0);

    for (const [slug, count] of inboundCounts(withInternalLinks(thin))) {
      expect(count, `${slug} has no inbound links`).toBeGreaterThan(0);
    }
  });

  test("the validator reports an orphan", () => {
    const stripped = withInternalLinks(grid()).map((item, index) =>
      index === 0 ? item : { ...item, links: [] },
    );

    const orphans = validateInternalLinks(stripped).filter((issue) =>
      issue.message.includes("Orphan page"),
    );

    expect(orphans.length).toBeGreaterThan(0);
  });

  test("a lone page is not an orphan, because nothing could link to it", () => {
    const single = withInternalLinks([page("office", "duisburg")]);

    expect(single[0]?.links).toEqual([]);
    expect(validateInternalLinks(single)).toEqual([]);
  });

  test("an unrelated page is not reported as a repairable orphan", () => {
    // Shares neither service nor city with anything: no relation exists, so no
    // link would be justified.
    const isolated = GeneratedPageSchema.parse({
      ...page("office", "duisburg"),
      slug: "lonely-page",
      serviceId: "svc-unique",
      locationId: "loc-unique",
    });

    const linked = withInternalLinks([...grid(), isolated]);

    expect(linked.find((item) => item.slug === "lonely-page")?.links.length).toBe(0);
    expect(
      validateInternalLinks(linked).some((issue) =>
        issue.path.includes("lonely-page"),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: contextual justification, not a blind quota
// ---------------------------------------------------------------------------

describe("links are earned, not imposed", () => {
  test("a page with no body earns no links of its own", () => {
    const builder = new LinkGraphBuilder();

    expect(builder.budgetFor(page("office", "duisburg", 0))).toBe(0);
  });

  test("budget grows with content volume", () => {
    const builder = new LinkGraphBuilder();

    expect(builder.budgetFor(page("office", "duisburg", 1))).toBe(1);
    expect(builder.budgetFor(page("office", "duisburg", 2))).toBe(2);
  });

  test("budget stops at the ceiling however long the page", () => {
    const builder = new LinkGraphBuilder({ maxLinksPerPage: 4 });

    expect(builder.budgetFor(page("office", "duisburg", 50))).toBe(4);
  });

  test("a thin page is not forced to carry a full quota", () => {
    const thin = withInternalLinks(grid(1));

    // One link earned; repair may add one more, never a fixed three.
    for (const item of thin) {
      expect(item.links.length, item.slug).toBeLessThanOrEqual(2);
    }
  });

  test("no page exceeds the configured ceiling", () => {
    const linked = withInternalLinks(grid(10), { maxLinksPerPage: 3 });

    for (const item of linked) {
      expect(item.links.length, item.slug).toBeLessThanOrEqual(3);
    }
  });

  test("contentVolume counts section bodies and FAQ answers", () => {
    const item = page("office", "duisburg", 1);

    expect(contentVolume(item)).toBe(400 + "Wenige Tage.".length);
  });
});

// ---------------------------------------------------------------------------
// Contextual relations
// ---------------------------------------------------------------------------

describe("relations are contextual", () => {
  test("links only ever connect the two axes of the grid", () => {
    const linked = withInternalLinks(grid());
    const bySlug = new Map(linked.map((item) => [item.slug, item]));

    for (const link of allLinks(linked)) {
      const from = bySlug.get(link.from)!;
      const to = bySlug.get(link.slug)!;

      if (link.relation === "sameCity") {
        expect(to.locationId).toBe(from.locationId);
        expect(to.serviceId).not.toBe(from.serviceId);
      } else {
        expect(to.serviceId).toBe(from.serviceId);
        expect(to.locationId).not.toBe(from.locationId);
      }
    }
  });

  test("a page with room links along both axes", () => {
    const linked = withInternalLinks(grid(4));
    const relations = new Set(linked[0]?.links.map((link) => link.relation));

    // Interleaving is what stops a small budget from being spent entirely on
    // one axis, leaving the other cluster unbuilt.
    expect(relations).toEqual(new Set(["sameService", "sameCity"]));
  });

  test("same-city siblings are reachable from each other", () => {
    const linked = withInternalLinks(grid(4));
    const duisburg = linked.filter((item) => item.locationId === "loc-duisburg");

    const reaches = duisburg.some((item) =>
      item.links.some((link) => link.relation === "sameCity"),
    );

    expect(reaches).toBe(true);
  });

  test("same-service siblings are reachable from each other", () => {
    const linked = withInternalLinks(grid(4));
    const office = linked.filter((item) => item.serviceId === "svc-office");

    const reaches = office.some((item) =>
      item.links.some((link) => link.relation === "sameService"),
    );

    expect(reaches).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: anchor repetition
// ---------------------------------------------------------------------------

describe("anchors do not repeat absurdly", () => {
  test("no anchor exceeds the site-wide cap", () => {
    const linked = withInternalLinks(grid(4), { maxAnchorRepetition: 3 });
    const counts = new Map<string, number>();

    for (const link of allLinks(linked)) {
      const key = link.anchor.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const [anchor, count] of counts) {
      expect(count, `anchor "${anchor}"`).toBeLessThanOrEqual(3);
    }
  });

  test("a tighter cap is respected", () => {
    const linked = withInternalLinks(grid(4), { maxAnchorRepetition: 1 });
    const counts = new Map<string, number>();

    for (const link of allLinks(linked)) {
      const key = link.anchor.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    // Repair may push exactly one anchor over, since an orphan outranks taste.
    const over = [...counts.values()].filter((count) => count > 1);
    expect(over.length).toBeLessThanOrEqual(1);
  });

  test("anchors come from the target page, never from a fixed phrase", () => {
    const linked = withInternalLinks(grid(4));
    const bySlug = new Map(linked.map((item) => [item.slug, item]));

    for (const link of allLinks(linked)) {
      const target = bySlug.get(link.slug)!;
      // Language-neutral by construction: the anchor is the target's own words.
      expect(anchorCandidates(target)).toContain(link.anchor);
    }
  });

  test("anchorCandidates offers distinct forms, deduplicated", () => {
    const candidates = anchorCandidates(page("office", "duisburg"));

    expect(candidates.length).toBeGreaterThan(1);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test("the validator reports an over-used anchor", () => {
    const linked = withInternalLinks(grid(4));
    const forced = linked.map((item) => ({
      ...item,
      links: item.links.map((link) => ({ ...link, anchor: "Same Anchor" })),
    }));

    expect(
      validateInternalLinks(forced).some((issue) =>
        issue.message.includes("over the limit"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism and purity
// ---------------------------------------------------------------------------

describe("graph behaviour", () => {
  test("is deterministic across runs", () => {
    expect(allLinks(withInternalLinks(grid()))).toEqual(
      allLinks(withInternalLinks(grid())),
    );
  });

  test("does not mutate the pages it is given", () => {
    const original = grid();
    const snapshot = structuredClone(original);

    withInternalLinks(original);

    expect(original).toEqual(snapshot);
  });

  test("a graph built by the builder passes its own validator", () => {
    expect(validateInternalLinks(withInternalLinks(grid()))).toEqual([]);
  });

  test("a thin-page graph also passes its own validator", () => {
    expect(validateInternalLinks(withInternalLinks(grid(0)))).toEqual([]);
  });

  test("repairOrphans can be switched off", () => {
    const linked = withInternalLinks(grid(0), { repairOrphans: false });

    expect(allLinks(linked)).toEqual([]);
    // And the validator then says so, rather than the silence of a broken graph.
    expect(
      validateInternalLinks(linked).filter((issue) =>
        issue.message.includes("Orphan page"),
      ).length,
    ).toBe(9);
  });

  test("an empty build produces nothing and complains about nothing", () => {
    expect(withInternalLinks([])).toEqual([]);
    expect(validateInternalLinks([])).toEqual([]);
  });
});
