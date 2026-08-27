import {
  DEFAULT_CONTENT_PROFILE,
  STRICT_SEO_PROFILE,
} from "@staticforge/schemas";
import { describe, expect, test, vi } from "vitest";

import {
  AIContentRejectedError,
  AIRequestError,
  AIToolCallMissingError,
  AITransportError,
} from "./errors.js";
import { GroundingFactsSchema, type GroundingFacts } from "./grounding.js";
import { renderProfileConstraints } from "./prompts.js";
import {
  AIGenerationService,
  TOOL_INPUT_SCHEMA,
  TOOL_NAME,
  type GeneratedPageContent,
} from "./service.js";

/**
 * Every test runs against a fake `messages.create`. Nothing here reaches the
 * network, reads ANTHROPIC_API_KEY, or constructs a real Anthropic client.
 */

const DETAILS = {
  businessName: "GlanzFix Reinigungsservice",
  serviceName: "Büroreinigung",
  cityName: "Duisburg",
};

const LONG_BODY = "Wir arbeiten in festen Intervallen und dokumentieren jeden Einsatz. ".repeat(4);
const LONG_ANSWER = "Ein Termin ist in der Regel innerhalb weniger Werktage möglich. ".repeat(2);

/** Content that satisfies both the structural contract and the strict profile. */
function goodContent(overrides: Partial<GeneratedPageContent> = {}): GeneratedPageContent {
  return {
    title: "Büroreinigung in Duisburg – zuverlässig und gründlich",
    metaDescription:
      "Professionelle Büroreinigung in Duisburg für Praxen, Kanzleien und Agenturen. Feste Teams, flexible Zeiten und ein verbindliches Festpreisangebot.",
    h1: "Saubere Büros in Duisburg, ohne Aufwand",
    content: {
      hero: {
        heading: "Büroreinigung in Duisburg",
        subheading: "Feste Teams, flexible Zeiten, verbindliche Preise.",
      },
      sections: [
        { heading: "Was die Büroreinigung umfasst", body: LONG_BODY, kind: "overview" },
        { heading: "Wie die Reinigung abläuft", body: LONG_BODY, kind: "process" },
        { heading: "Was die Reinigung kostet", body: LONG_BODY, kind: "pricing" },
      ],
      faq: [
        { question: "Wie schnell ist ein Termin möglich?", answer: LONG_ANSWER },
        { question: "Sind die Reinigungsmittel umweltfreundlich?", answer: LONG_ANSWER },
        { question: "Erhalte ich ein Festpreisangebot?", answer: LONG_ANSWER },
        { question: "Ist das Personal versichert?", answer: LONG_ANSWER },
      ],
      cta: {
        heading: "Kostenloses Angebot anfordern",
        buttonLabel: "Angebot anfordern",
        href: "#contact",
      },
    },
    ...overrides,
  };
}

/** A provider response carrying a tool call. */
function toolResponse(input: unknown) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: "tool_use",
    content: [
      { type: "thinking", thinking: "", signature: "" },
      { type: "tool_use", id: "toolu_test", name: TOOL_NAME, input },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/** A provider response with prose and no tool call. */
function proseResponse() {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Here is the page you asked for." }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/** The verified record the grounding gate checks against. */
const FACTS: GroundingFacts = GroundingFactsSchema.parse({
  businessName: "GlanzFix Reinigungsservice",
  foundedYear: 2014,
  emails: ["kontakt@glanzfix.de"],
  phones: ["+49 203 1234567"],
  approvedServices: ["Büroreinigung", "Grundreinigung"],
  approvedCities: ["Duisburg", "Essen"],
  unapprovedServices: ["Treppenhausreinigung", "Fensterreinigung"],
  unapprovedCities: ["Köln"],
  prices: [{ from: 25, to: 45, currency: "EUR" }],
});

/** An error shaped like the SDK's, without importing the SDK's classes. */
function apiError(status: number, headers?: Record<string, string>) {
  return Object.assign(new Error(`HTTP ${status}`), { status, headers });
}

/** Build a service around a scripted `messages.create`. */
function serviceWith(
  create: ReturnType<typeof vi.fn>,
  options: Partial<ConstructorParameters<typeof AIGenerationService>[0]> = {},
) {
  return new AIGenerationService({
    client: { messages: { create } } as never,
    profile: STRICT_SEO_PROFILE,
    retry: { sleepFn: () => Promise.resolve(), random: () => 0.5 },
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

describe("structured output", () => {
  test("forces the model to answer through the tool", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse(goodContent()));

    await serviceWith(create).generatePageContent(DETAILS);

    const request = create.mock.calls[0]?.[0];
    expect(request.tool_choice).toEqual({
      type: "tool",
      name: TOOL_NAME,
      disable_parallel_tool_use: true,
    });
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0].name).toBe(TOOL_NAME);
  });

  test("sends the contract as the tool's input schema", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse(goodContent()));

    await serviceWith(create).generatePageContent(DETAILS);

    const schema = create.mock.calls[0]?.[0].tools[0].input_schema;
    expect(schema).toBe(TOOL_INPUT_SCHEMA);
    expect(schema.type).toBe("object");
    // Self-contained: the API takes one schema, not a $ref graph.
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(Object.keys(schema.properties)).toEqual([
      "title",
      "metaDescription",
      "h1",
      "content",
    ]);
  });

  test("asks only for fields the model may legitimately author", async () => {
    const schema = TOOL_INPUT_SCHEMA as { properties: Record<string, unknown> };

    // Identifiers, slug, locale and templateId are the engine's to resolve.
    for (const owned of ["slug", "locale", "templateId", "businessId", "serviceId", "locationId", "schemaOrg"]) {
      expect(owned in schema.properties, `${owned} must not be asked of the model`).toBe(
        false,
      );
    }
  });

  test("returns the parsed content on a clean response", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse(goodContent()));

    const result = await serviceWith(create).generatePageContent(DETAILS);

    expect(result.title).toBe("Büroreinigung in Duisburg – zuverlässig und gründlich");
    expect(result.content.sections).toHaveLength(3);
  });

  test("puts the business, service and city in the user turn", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse(goodContent()));

    await serviceWith(create).generatePageContent(DETAILS);

    const userTurn = create.mock.calls[0]?.[0].messages[0].content as string;
    expect(userTurn).toContain("GlanzFix Reinigungsservice");
    expect(userTurn).toContain("Büroreinigung");
    expect(userTurn).toContain("Duisburg");
  });

  test("ignores a tool call with a different name", async () => {
    const create = vi.fn().mockResolvedValue({
      ...toolResponse(goodContent()),
      content: [{ type: "tool_use", id: "t", name: "some_other_tool", input: {} }],
    });

    await expect(serviceWith(create).generatePageContent(DETAILS)).rejects.toBeInstanceOf(
      AIToolCallMissingError,
    );
  });

  test("rejects a response that carries prose instead of a tool call", async () => {
    const create = vi.fn().mockResolvedValue(proseResponse());

    await expect(
      serviceWith(create).generatePageContent(DETAILS),
    ).rejects.toMatchObject({ name: "AIToolCallMissingError", stopReason: "end_turn" });
  });
});

// ---------------------------------------------------------------------------
// Separation of powers
// ---------------------------------------------------------------------------

describe("separation of powers", () => {
  test("rejects content that breaks the structural contract", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse({ ...goodContent(), title: "T".repeat(71) }));

    try {
      await serviceWith(create).generatePageContent(DETAILS);
      throw new Error("expected the service to reject the content");
    } catch (error) {
      expect(error).toBeInstanceOf(AIContentRejectedError);
      expect((error as AIContentRejectedError).stage).toBe("schema");
      expect(
        (error as AIContentRejectedError).issues.some((i) => i.path === "title"),
      ).toBe(true);
    }
  });

  test("rejects a fabricated CTA target", async () => {
    const content = goodContent();
    const create = vi.fn().mockResolvedValue(
      toolResponse({
        ...content,
        content: { ...content.content, cta: { ...content.content.cta, href: "contact" } },
      }),
    );

    await expect(
      serviceWith(create).generatePageContent(DETAILS),
    ).rejects.toMatchObject({ stage: "schema" });
  });

  test("rejects content that meets the schema but misses the quality bar", async () => {
    const content = goodContent();
    const create = vi.fn().mockResolvedValue(
      toolResponse({
        ...content,
        // Structurally fine — one section is a valid page. Not good enough.
        content: { ...content.content, sections: content.content.sections.slice(0, 1) },
      }),
    );

    try {
      await serviceWith(create).generatePageContent(DETAILS);
      throw new Error("expected the service to reject the content");
    } catch (error) {
      expect(error).toBeInstanceOf(AIContentRejectedError);
      expect((error as AIContentRejectedError).stage).toBe("profile");
      expect((error as AIContentRejectedError).profileId).toBe("strictSeo");
      expect(
        (error as AIContentRejectedError).issues.some(
          (i) => i.path === "content.sections",
        ),
      ).toBe(true);
    }
  });

  test("rejects an h1 that merely repeats the title", async () => {
    const title = "Büroreinigung in Duisburg – zuverlässig und gründlich";
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse(goodContent({ title, h1: title })));

    await expect(
      serviceWith(create).generatePageContent(DETAILS),
    ).rejects.toMatchObject({ stage: "profile" });
  });

  test("never retries rejected content — a refusal is a result, not an outage", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse({ ...goodContent(), title: "" }));

    await expect(serviceWith(create).generatePageContent(DETAILS)).rejects.toBeInstanceOf(
      AIContentRejectedError,
    );
    // One paid call. Asking again would buy the same violation.
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("the same content passes a looser profile and fails a stricter one", async () => {
    const content = goodContent();
    const oneSection = {
      ...content,
      content: { ...content.content, sections: content.content.sections.slice(0, 1) },
    };
    const create = vi.fn().mockResolvedValue(toolResponse(oneSection));

    await expect(
      serviceWith(create, { profile: DEFAULT_CONTENT_PROFILE }).generatePageContent(
        DETAILS,
      ),
    ).resolves.toBeDefined();

    await expect(serviceWith(create).generatePageContent(DETAILS)).rejects.toBeInstanceOf(
      AIContentRejectedError,
    );
  });

  test("acceptOrReject applies the same verdict without a provider", () => {
    const service = serviceWith(vi.fn());

    expect(service.acceptOrReject(goodContent()).title).toBeDefined();
    expect(() => service.acceptOrReject({ title: "x" })).toThrow(AIContentRejectedError);
  });

  test("reports every violation at once rather than the first", () => {
    const service = serviceWith(vi.fn());

    try {
      service.acceptOrReject(goodContent({ title: "Kurz", h1: "Mini" }));
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as AIContentRejectedError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt and profile stay in step
// ---------------------------------------------------------------------------

describe("prompt derives from the profile", () => {
  test("states the profile's own bounds, not hardcoded ones", () => {
    const prompt = serviceWith(vi.fn()).prompt;

    expect(prompt).toContain(`content profile "strictSeo"`);
    expect(prompt).toContain(
      `between ${STRICT_SEO_PROFILE.sections.count.min} and ${STRICT_SEO_PROFILE.sections.count.max} entries`,
    );
    expect(prompt).toContain(
      `between ${STRICT_SEO_PROFILE.title.min} and ${STRICT_SEO_PROFILE.title.max} characters`,
    );
  });

  test("a different profile yields a different prompt", () => {
    const strict = serviceWith(vi.fn()).prompt;
    const loose = serviceWith(vi.fn(), { profile: DEFAULT_CONTENT_PROFILE }).prompt;

    // The rules the model is given and the rules it is judged by come from one
    // object, so they cannot drift apart.
    expect(strict).not.toBe(loose);
    expect(loose).toContain(`content profile "default"`);
  });

  test("lists the allowed section kinds when the profile requires one", () => {
    const rendered = renderProfileConstraints(STRICT_SEO_PROFILE);

    for (const kind of STRICT_SEO_PROFILE.sections.allowedKinds) {
      expect(rendered).toContain(kind);
    }
    expect(rendered).toContain("must declare a `kind`");
  });

  test("omits the kind requirement for a profile that does not need one", () => {
    expect(renderProfileConstraints(DEFAULT_CONTENT_PROFILE)).not.toContain(
      "must declare a `kind`",
    );
  });

  test("exposes the profile it enforces", () => {
    expect(serviceWith(vi.fn()).contentProfile).toBe(STRICT_SEO_PROFILE);
  });
});

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

describe("transport handling", () => {
  test("recovers from a transient failure without the caller noticing", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(529))
      .mockResolvedValue(toolResponse(goodContent()));

    await expect(serviceWith(create).generatePageContent(DETAILS)).resolves.toBeDefined();
    expect(create).toHaveBeenCalledTimes(2);
  });

  test("honours a rate limit's retry-after", async () => {
    const sleepFn = vi.fn(() => Promise.resolve());
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(429, { "retry-after": "5" }))
      .mockResolvedValue(toolResponse(goodContent()));

    await serviceWith(create, {
      retry: { sleepFn, random: () => 0.5 },
    }).generatePageContent(DETAILS);

    expect(sleepFn).toHaveBeenCalledWith(5000);
  });

  test("gives up as AITransportError once the budget is spent", async () => {
    const create = vi.fn().mockRejectedValue(apiError(503));

    try {
      await serviceWith(create, {
        retry: { sleepFn: () => Promise.resolve(), random: () => 0.5, maxRetries: 2 },
      }).generatePageContent(DETAILS);
      throw new Error("expected the service to give up");
    } catch (error) {
      expect(error).toBeInstanceOf(AITransportError);
      expect((error as AITransportError).attempts).toBe(3);
      expect((error as AITransportError).status).toBe(503);
    }
    expect(create).toHaveBeenCalledTimes(3);
  });

  test("fails immediately on a request the provider will never accept", async () => {
    const create = vi.fn().mockRejectedValue(apiError(401));

    try {
      await serviceWith(create).generatePageContent(DETAILS);
      throw new Error("expected the service to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AIRequestError);
      expect((error as AIRequestError).status).toBe(401);
    }
    // No point waiting on a bad key.
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("reports retries to the caller", async () => {
    const onRetry = vi.fn();
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(500))
      .mockResolvedValue(toolResponse(goodContent()));

    await serviceWith(create, { onRetry }).generatePageContent(DETAILS);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, status: 500 });
  });

  test("never constructs a real client or reads the API key", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const create = vi.fn().mockResolvedValue(toolResponse(goodContent()));
      await expect(
        serviceWith(create).generatePageContent(DETAILS),
      ).resolves.toBeDefined();
    } finally {
      if (before !== undefined) process.env.ANTHROPIC_API_KEY = before;
    }
  });
});

// ---------------------------------------------------------------------------
// Fact grounding — gate 4
// ---------------------------------------------------------------------------

describe("fact grounding", () => {
  /** Plant text in the first section's body. */
  function withClaim(claim: string): GeneratedPageContent {
    const base = goodContent();
    const [first, ...rest] = base.content.sections;

    return {
      ...base,
      content: {
        ...base.content,
        sections: [{ ...first!, body: `${first!.body}${claim}` }, ...rest],
      },
    };
  }

  test("puts the verified record in front of the model", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse(goodContent()));

    await serviceWith(create).generatePageContent({ ...DETAILS, facts: FACTS });

    const userTurn = create.mock.calls[0]?.[0].messages[0].content as string;
    expect(userTurn).toContain("Verified record");
    expect(userTurn).toContain("kontakt@glanzfix.de");
    expect(userTurn).toContain("25–45 EUR");
    // Prevention as well as detection: it is told what it may not name.
    expect(userTurn).toContain("Treppenhausreinigung");
  });

  test("omits the record when none is supplied", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse(goodContent()));

    await serviceWith(create).generatePageContent(DETAILS);

    expect(create.mock.calls[0]?.[0].messages[0].content).not.toContain(
      "Verified record",
    );
  });

  test("rejects an invented contact detail at the grounding gate", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse(withClaim(" Schreiben Sie an fake@example.com.")));

    try {
      await serviceWith(create).generatePageContent({ ...DETAILS, facts: FACTS });
      throw new Error("expected the service to reject the content");
    } catch (error) {
      expect(error).toBeInstanceOf(AIContentRejectedError);
      expect((error as AIContentRejectedError).stage).toBe("grounding");
    }
  });

  test("rejects an invented founding year", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse(withClaim(" Seit 1998 im Ruhrgebiet.")));

    await expect(
      serviceWith(create).generatePageContent({ ...DETAILS, facts: FACTS }),
    ).rejects.toMatchObject({ stage: "grounding" });
  });

  test("rejects a service the business does not sell", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse(withClaim(" Auch Fensterreinigung im Angebot.")));

    await expect(
      serviceWith(create).generatePageContent({ ...DETAILS, facts: FACTS }),
    ).rejects.toMatchObject({ stage: "grounding" });
  });

  test("rejects a price nobody quoted", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse(withClaim(" Pauschal ab 750 EUR.")));

    await expect(
      serviceWith(create).generatePageContent({ ...DETAILS, facts: FACTS }),
    ).rejects.toMatchObject({ stage: "grounding" });
  });

  test("accepts content that stays inside the record", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        toolResponse(withClaim(" Seit 2014 tätig, ab 30 EUR, kontakt@glanzfix.de.")),
      );

    await expect(
      serviceWith(create).generatePageContent({ ...DETAILS, facts: FACTS }),
    ).resolves.toBeDefined();
  });

  test("does not retry a fabrication — a lie does not become true on a second call", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse(withClaim(" Seit 1998 im Ruhrgebiet.")));

    await expect(
      serviceWith(create).generatePageContent({ ...DETAILS, facts: FACTS }),
    ).rejects.toBeInstanceOf(AIContentRejectedError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("skips the gate when no record is supplied", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse(withClaim(" Seit 1998, ab 900 EUR, fake@example.com.")));

    // Nothing to check against: what is not known cannot be verified.
    await expect(serviceWith(create).generatePageContent(DETAILS)).resolves.toBeDefined();
  });

  test("refuses to generate ungrounded when requireFacts is on", async () => {
    const create = vi.fn().mockResolvedValue(toolResponse(goodContent()));

    await expect(
      serviceWith(create, { requireFacts: true }).generatePageContent(DETAILS),
    ).rejects.toBeInstanceOf(AIRequestError);
    // Refused before spending anything.
    expect(create).not.toHaveBeenCalled();
  });

  test("quality is judged before grounding, so a thin page fails as thin", async () => {
    const base = goodContent();
    const create = vi.fn().mockResolvedValue(
      toolResponse({
        ...base,
        content: {
          ...base.content,
          sections: [
            { ...base.content.sections[0]!, body: `${base.content.sections[0]!.body} Seit 1998.` },
          ],
        },
      }),
    );

    // Both gates would fire; the earlier verdict is the useful one, because the
    // page will be rewritten anyway.
    await expect(
      serviceWith(create).generatePageContent({ ...DETAILS, facts: FACTS }),
    ).rejects.toMatchObject({ stage: "profile" });
  });

  test("honours the percentage switch", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(toolResponse(withClaim(" 98% Zufriedenheit.")));

    await expect(
      serviceWith(create).generatePageContent({ ...DETAILS, facts: FACTS }),
    ).rejects.toMatchObject({ stage: "grounding" });

    await expect(
      serviceWith(create, {
        grounding: { rejectPercentages: false },
      }).generatePageContent({ ...DETAILS, facts: FACTS }),
    ).resolves.toBeDefined();
  });

  test("acceptOrReject applies the grounding gate without a provider", () => {
    const service = serviceWith(vi.fn());

    expect(() =>
      service.acceptOrReject(withClaim(" Seit 1998 im Ruhrgebiet."), FACTS),
    ).toThrow(AIContentRejectedError);

    // Same content, no record to check against: nothing to object to.
    expect(
      service.acceptOrReject(withClaim(" Seit 1998 im Ruhrgebiet.")).h1,
    ).toBeDefined();
  });

  test("names the offending field and the fact that contradicts it", () => {
    try {
      serviceWith(vi.fn()).acceptOrReject(
        withClaim(" Seit 1998 im Ruhrgebiet."),
        FACTS,
      );
      throw new Error("expected a rejection");
    } catch (error) {
      const issues = (error as AIContentRejectedError).issues;
      expect(issues[0]?.path).toMatch(/^content\.sections\[0\]\.body$/);
      expect(issues[0]?.message).toContain("2014");
    }
  });
});
