import { describe, expect, test, vi } from "vitest";
import type { Business, Location, Service } from "@staticforge/schemas";

import {
  ANALYST_TOOL_NAME,
  GapAnalysisRejectedError,
  analyzeContentGaps,
  buildAnalystPrompt,
  findContentGaps,
  type GapAnalysisInput,
} from "./gap-analysis.js";
import { AIToolCallMissingError } from "../errors.js";

/**
 * An analyst is the first place the engine asks a model what to *do*, and
 * advice looks harmless in a way authored content does not. A bad
 * recommendation is not published, so it seems to cost nothing — until an
 * operator acts on it and finds it names a service that does not exist.
 *
 * So the tests are about the two guards: the shape is pinned, and the
 * identifiers inside the shape are checked against the catalogue that was put
 * in front of the model. A schema cannot do the second one: `svc-invented` is a
 * perfectly well-formed string.
 */

const business: Business = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Reinigung",
  slug: "acme",
  niche: "cleaning",
  description: "D".repeat(80),
  contactEmail: "kontakt@acme.de",
  contactPhone: "+49 203 1234567",
  address: {
    street: "Musterstr 1",
    city: "Duisburg",
    state: "NRW",
    postalCode: "47051",
    country: "DE",
  },
};

const services: Service[] = [
  {
    id: "svc-buero",
    name: "Büroreinigung",
    slug: "bueroreinigung",
    description: "S".repeat(120),
    benefits: ["a", "b", "c"],
  },
  {
    id: "svc-grund",
    name: "Grundreinigung",
    slug: "grundreinigung",
    description: "G".repeat(120),
    benefits: ["a", "b", "c"],
  },
];

const locations: Location[] = [
  { id: "loc-duisburg", city: "Duisburg", state: "NRW", country: "DE" },
  { id: "loc-essen", city: "Essen", state: "NRW", country: "DE" },
];

/** A project with one of four combinations already covered. */
function input(over: Partial<GapAnalysisInput> = {}): GapAnalysisInput {
  return {
    business,
    services,
    locations,
    existingPages: [{ serviceId: "svc-buero", locationId: "loc-duisburg" }],
    ...over,
  };
}

/** A well-formed analyst answer. */
function answer(over: Record<string, unknown> = {}) {
  return {
    summary:
      "Coverage is thin outside Duisburg, and the deep-clean line is unrepresented entirely.",
    recommendedPages: [
      {
        serviceId: "svc-buero",
        locationId: "loc-essen",
        rationale:
          "Essen has a dense commercial core and no office-cleaning page yet, so this is the closest gap to existing demand.",
        priority: "high",
      },
    ],
    suggestedNewServices: [],
    ...over,
  };
}

/** A client double that answers with one tool call. */
function clientReturning(toolInput: unknown) {
  const create = vi.fn().mockResolvedValue({
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "t1", name: ANALYST_TOOL_NAME, input: toolInput },
    ],
  });

  return { client: { messages: { create } } as never, create };
}

describe("findContentGaps", () => {
  test("is the exact set difference, computed without a model", () => {
    // Which pairs are missing is a loop, not a judgement. Handing it to a model
    // would spend tokens on combinatorics it is bad at.
    const gaps = findContentGaps(input());

    expect(gaps).toHaveLength(3);
    expect(gaps.map((gap) => `${gap.serviceId}×${gap.locationId}`).sort()).toEqual([
      "svc-buero×loc-essen",
      "svc-grund×loc-duisburg",
      "svc-grund×loc-essen",
    ]);
  });

  test("a fully covered project has no gaps", () => {
    const covered = services.flatMap((service) =>
      locations.map((location) => ({
        serviceId: service.id,
        locationId: location.id,
      })),
    );

    expect(findContentGaps(input({ existingPages: covered }))).toEqual([]);
  });

  test("an empty project is all gaps", () => {
    expect(findContentGaps(input({ existingPages: [] }))).toHaveLength(4);
  });
});

describe("the briefing tells the model what it may reference", () => {
  test("names every service and location by id", () => {
    const prompt = buildAnalystPrompt(input(), findContentGaps(input()));

    for (const id of ["svc-buero", "svc-grund", "loc-duisburg", "loc-essen"]) {
      expect(prompt).toContain(id);
    }
  });

  test("states the gaps rather than asking for them", () => {
    const prompt = buildAnalystPrompt(input(), findContentGaps(input()));

    expect(prompt).toContain("Missing combinations (3)");
  });

  test("caps how many gaps it enumerates", () => {
    const many = Array.from({ length: 400 }, (_unused, index) => ({
      id: `loc-${index}`,
      city: `City${index}`,
      state: "NRW",
      country: "DE",
    }));

    const wide = input({ locations: many, existingPages: [] });
    const prompt = buildAnalystPrompt(wide, findContentGaps(wide));

    // Beyond a point the list is noise the model pays for and cannot use.
    expect(prompt).toContain("showing the first 200");
  });
});

describe("a valid answer is accepted", () => {
  test("returns the analysis and the gap count", async () => {
    const { client } = clientReturning(answer());

    const result = await analyzeContentGaps(input(), { client });

    expect(result.analysis.recommendedPages).toHaveLength(1);
    expect(result.analysis.recommendedPages[0]?.serviceId).toBe("svc-buero");
    expect(result.gapCount).toBe(3);
    expect(result.discarded).toEqual([]);
  });

  test("answers through a forced tool call", async () => {
    const { client, create } = clientReturning(answer());

    await analyzeContentGaps(input(), { client });

    const request = create.mock.calls[0]?.[0];

    expect(request.tool_choice).toMatchObject({ type: "tool", name: ANALYST_TOOL_NAME });
    expect(request.tools?.[0]?.name).toBe(ANALYST_TOOL_NAME);
  });

  test("accepts suggested services, which carry no identifiers to invent", async () => {
    const { client } = clientReturning(
      answer({
        suggestedNewServices: [
          {
            name: "Fensterreinigung",
            rationale:
              "Window cleaning is bought by the same facility managers who already buy office cleaning here.",
            priority: "medium",
          },
        ],
      }),
    );

    const result = await analyzeContentGaps(input(), { client });

    expect(result.analysis.suggestedNewServices[0]?.name).toBe("Fensterreinigung");
  });
});

describe("a malformed answer is refused, not repaired", () => {
  test("a missing rationale is rejected", async () => {
    const { client } = clientReturning(
      answer({
        recommendedPages: [
          { serviceId: "svc-grund", locationId: "loc-essen", priority: "high" },
        ],
      }),
    );

    await expect(analyzeContentGaps(input(), { client })).rejects.toBeInstanceOf(
      GapAnalysisRejectedError,
    );
  });

  test("a rationale too short to evaluate is rejected", async () => {
    // "Good opportunity" is a row, not a recommendation.
    const { client } = clientReturning(
      answer({
        recommendedPages: [
          {
            serviceId: "svc-grund",
            locationId: "loc-essen",
            rationale: "Good opportunity.",
            priority: "high",
          },
        ],
      }),
    );

    await expect(analyzeContentGaps(input(), { client })).rejects.toBeInstanceOf(
      GapAnalysisRejectedError,
    );
  });

  test("an invented priority is rejected", async () => {
    const { client } = clientReturning(
      answer({
        recommendedPages: [
          {
            serviceId: "svc-grund",
            locationId: "loc-essen",
            rationale: "R".repeat(60),
            priority: "urgent",
          },
        ],
      }),
    );

    await expect(analyzeContentGaps(input(), { client })).rejects.toBeInstanceOf(
      GapAnalysisRejectedError,
    );
  });

  test("an unknown key is rejected rather than ignored", async () => {
    const { client } = clientReturning(answer({ extraAdvice: "call them" }));

    await expect(analyzeContentGaps(input(), { client })).rejects.toBeInstanceOf(
      GapAnalysisRejectedError,
    );
  });

  test("an answer that is not the contract at all is rejected", async () => {
    for (const value of [null, 42, "some advice", [], {}]) {
      const { client } = clientReturning(value);

      await expect(
        analyzeContentGaps(input(), { client }),
        JSON.stringify(value),
      ).rejects.toBeInstanceOf(GapAnalysisRejectedError);
    }
  });

  test("the rejection names the failing field, so the prompt can be fixed", async () => {
    const { client } = clientReturning(answer({ summary: "short" }));

    try {
      await analyzeContentGaps(input(), { client });
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      // A malformed answer is evidence about the model or the prompt. Patching
      // it up would hide exactly what is needed to fix either.
      expect(error).toBeInstanceOf(GapAnalysisRejectedError);
      expect((error as GapAnalysisRejectedError).issues[0]?.path).toBe("summary");
    }
  });

  test("prose instead of a tool call is rejected", async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Here is my analysis…" }],
    });

    await expect(
      analyzeContentGaps(input(), { client: { messages: { create } } as never }),
    ).rejects.toBeInstanceOf(AIToolCallMissingError);
  });
});

describe("identifiers are checked against the catalogue", () => {
  /** Run with one recommendation and return what survived. */
  async function withRecommendation(page: Record<string, unknown>) {
    const { client } = clientReturning(answer({ recommendedPages: [page] }));
    return analyzeContentGaps(input(), { client });
  }

  test("a service that does not exist is discarded", async () => {
    // The hallucination a schema cannot catch: well-formed, and not real.
    const result = await withRecommendation({
      serviceId: "svc-gartenpflege",
      locationId: "loc-essen",
      rationale: "R".repeat(60),
      priority: "high",
    });

    expect(result.analysis.recommendedPages).toEqual([]);
    expect(result.discarded[0]?.reason).toMatch(/No service "svc-gartenpflege"/);
  });

  test("a location that does not exist is discarded", async () => {
    const result = await withRecommendation({
      serviceId: "svc-buero",
      locationId: "loc-berlin",
      rationale: "R".repeat(60),
      priority: "high",
    });

    expect(result.discarded[0]?.reason).toMatch(/No location "loc-berlin"/);
  });

  test("a combination that already has a page is discarded", async () => {
    const result = await withRecommendation({
      serviceId: "svc-buero",
      locationId: "loc-duisburg",
      rationale: "R".repeat(60),
      priority: "high",
    });

    expect(result.discarded[0]?.reason).toMatch(/already exists/);
  });

  test("a duplicate recommendation is kept once", async () => {
    const page = {
      serviceId: "svc-grund",
      locationId: "loc-essen",
      rationale: "R".repeat(60),
      priority: "high",
    };
    const { client } = clientReturning(answer({ recommendedPages: [page, page] }));

    const result = await analyzeContentGaps(input(), { client });

    expect(result.analysis.recommendedPages).toHaveLength(1);
    expect(result.discarded[0]?.reason).toMatch(/more than once/);
  });

  test("valid recommendations survive alongside discarded ones", async () => {
    const { client } = clientReturning(
      answer({
        recommendedPages: [
          {
            serviceId: "svc-invented",
            locationId: "loc-essen",
            rationale: "R".repeat(60),
            priority: "high",
          },
          {
            serviceId: "svc-grund",
            locationId: "loc-essen",
            rationale: "R".repeat(60),
            priority: "medium",
          },
        ],
      }),
    );

    const result = await analyzeContentGaps(input(), { client });

    // One bad row does not discard the answer, and is not swallowed either.
    expect(result.analysis.recommendedPages).toHaveLength(1);
    expect(result.discarded).toHaveLength(1);
  });
});

describe("the analyst writes nothing", () => {
  test("makes exactly one provider call and no others", async () => {
    const { client, create } = clientReturning(answer());

    await analyzeContentGaps(input(), { client });

    // The whole surface: one read of what it was handed, one call, one answer.
    // There is no database client, queue or file handle in this module to do
    // anything else with.
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("does not mutate the input it was given", async () => {
    const given = input();
    const snapshot = JSON.stringify(given);
    const { client } = clientReturning(answer());

    await analyzeContentGaps(given, { client });

    expect(JSON.stringify(given)).toBe(snapshot);
  });
});
