import { describe, expect, test } from "vitest";

import { GroundingFactsSchema, collectGroundingIssues } from "./grounding.js";

/**
 * The price guard, against the way prices are actually written.
 *
 * The detector's trailing boundary was `\b`, which is only defined between a
 * word character and a non-word one. A match ending in `€` therefore closed
 * only when a letter or digit followed it — which in "ab 49 € pro Einsatz" it
 * never does. The symbol-first form was caught and the German form was not, so
 * a fabricated price written the ordinary way passed the guard untouched.
 */

const facts = (over: Record<string, unknown> = {}) =>
  GroundingFactsSchema.parse({ businessName: "Acme", ...over });

/** A page whose body carries `text`. */
function page(text: string) {
  return {
    title: "Title",
    metaDescription: "Meta description",
    h1: "Heading",
    content: {
      hero: { heading: "Hero" },
      sections: [{ heading: "Section", body: text }],
      faq: [{ question: "Q?", answer: "A." }],
      cta: { heading: "CTA", buttonLabel: "Go", href: "#contact" },
    },
  };
}

/** The messages the guards produced for this text. */
function messages(text: string, over: Record<string, unknown> = {}): string[] {
  return collectGroundingIssues(page(text), facts(over)).map(
    (issue) => issue.message,
  );
}

describe("a price nobody quoted is caught however it is written", () => {
  test.each([
    ["symbol after the number, spaced — the German form", "Ab 49 € pro Einsatz."],
    ["symbol after the number, unspaced", "Ab 49€ pro Einsatz."],
    ["symbol before the number", "Ab € 49 pro Einsatz."],
    ["ISO code after the number", "Ab 49 EUR pro Einsatz."],
    ["German grouping and decimal", "Pauschal 1.234,56 € netto."],
    ["at the end of a sentence", "Der Preis liegt bei 89,90€."],
    ["other currencies", "Ab 49 CHF pro Einsatz."],
  ])("%s", (_label, text) => {
    const found = messages(text);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/no pricing was supplied/);
  });
});

describe("the guard still judges amounts against the quoted range", () => {
  const priced = {
    prices: [{ from: 20, to: 80, currency: "EUR" }],
  };

  test("an amount inside the range passes, in the German form", () => {
    expect(messages("Ab 49 € pro Einsatz.", priced)).toEqual([]);
  });

  test("an amount above the range is refused, in the German form", () => {
    const found = messages("Ab 149 € pro Einsatz.", priced);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/outside every quoted range/);
  });

  test("an amount below the range is refused", () => {
    expect(messages("Schon ab 9€.", priced)).toHaveLength(1);
  });

  test("a German-grouped amount inside the range still parses", () => {
    expect(messages("Pauschal 49,50 € netto.", priced)).toEqual([]);
  });
});

describe("the boundary is a boundary, not an absence of one", () => {
  test("a currency code that only starts a longer word is not a price", () => {
    // "EURO" is a word, not an amount. `\b` refused it and the lookahead must
    // keep refusing it, or every mention of a euro becomes a price claim.
    expect(messages("120 EURO Rabatt im Angebot.")).toEqual([]);
  });

  test("a bare number is not a price", () => {
    expect(messages("Wir reinigen 120 Quadratmeter pro Stunde.")).toEqual([]);
  });

  test("a whitelisted price still passes", () => {
    expect(
      messages("Die Anfahrt kostet 15 €.", {
        allowedClaims: ["Anfahrtspauschale 15 €"],
      }),
    ).toEqual([]);
  });

  test("a whitelisted price does not whitelist a different one", () => {
    // The SF-08 tightening has to hold for the forms SF-18's fix newly exposes.
    expect(
      messages("Die Anfahrt kostet 5 €.", {
        allowedClaims: ["Anfahrtspauschale 15 €"],
      }),
    ).toHaveLength(1);
  });
});
