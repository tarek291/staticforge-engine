import { describe, expect, test } from "vitest";

import {
  GroundingFactsSchema,
  collectGroundingIssues,
  containsTerm,
} from "./grounding.js";

/**
 * The three ways a fabricated claim used to reach a published page while the
 * guards reported it clean.
 *
 * Each of these failed before the fix and is written as the attacker's-eye
 * case rather than as a unit test of a helper: what matters is not that
 * `containsTerm` normalises, but that the city a business does not serve can no
 * longer be named on its landing page.
 */

const facts = (over: Record<string, unknown> = {}) =>
  GroundingFactsSchema.parse({ businessName: "Acme", ...over });

/** A page carrying `text` in the position named by `where`. */
function page(
  text: string,
  where: "body" | "secondaryLabel" | "secondaryHref" = "body",
) {
  return {
    title: "Title",
    metaDescription: "Meta description",
    h1: "Heading",
    content: {
      hero: { heading: "Hero" },
      sections: [
        { heading: "Section", body: where === "body" ? text : "Clean body." },
      ],
      faq: [{ question: "Question?", answer: "Answer." }],
      cta: {
        heading: "CTA",
        buttonLabel: "Go",
        href: "#contact",
        ...(where === "secondaryLabel"
          ? { secondary: { buttonLabel: text, href: "#call" } }
          : where === "secondaryHref"
            ? { secondary: { buttonLabel: "Call", href: text } }
            : {}),
      },
    },
  };
}

describe("SF-06: the secondary call-to-action is scanned", () => {
  test("an unverified phone number in the secondary label is caught", () => {
    // The likeliest place on a page to carry a phone number was the one field
    // the scan skipped: rendered text on a clickable control.
    const issues = collectGroundingIssues(
      page("Jetzt anrufen 0800 1234567", "secondaryLabel"),
      facts({ phones: ["+49 211 999888"] }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("content.cta.secondary.buttonLabel");
  });

  test("a price in the secondary label is caught", () => {
    // Written "120 EUR" rather than "120 €": the money detector does not
    // currently match a symbol that trails the number. That is a separate gap
    // from this one, and using a form it sees keeps this test about the field
    // being scanned at all.
    const issues = collectGroundingIssues(
      page("Ab 120 EUR buchen", "secondaryLabel"),
      facts(),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/no pricing was supplied/);
  });

  test("the secondary href is still scanned too", () => {
    const issues = collectGroundingIssues(
      page("https://not-ours.example/deal", "secondaryHref"),
      facts({ urls: ["https://acme.de"] }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("content.cta.secondary.href");
  });

  test("a clean secondary action raises nothing", () => {
    expect(
      collectGroundingIssues(page("Anrufen", "secondaryLabel"), facts()),
    ).toEqual([]);
  });
});

describe("SF-07: Unicode normalisation", () => {
  const nfc = "Düsseldorf".normalize("NFC");
  const nfd = "Düsseldorf".normalize("NFD");

  test("the two encodings really are different strings", () => {
    // Guards the premise. If these ever compare equal the tests below prove
    // nothing.
    expect(nfc).not.toBe(nfd);
    expect(nfc.length).not.toBe(nfd.length);
  });

  test("containsTerm matches across encodings, both directions", () => {
    expect(containsTerm(nfd, nfc)).toBe(true);
    expect(containsTerm(nfc, nfd)).toBe(true);
  });

  test("a city the business does not serve cannot hide in NFD", () => {
    // The bypass: the record forbids the composed form, the page uses the
    // decomposed one, and they render identically to a reader.
    const issues = collectGroundingIssues(
      page(`Wir arbeiten auch in ${nfd} regelmaessig.`),
      facts({ unapprovedCities: [nfc], approvedCities: ["Essen"] }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/does not serve/);
  });

  test("a service the business does not sell cannot hide in NFD", () => {
    const service = "Grünpflege";

    const issues = collectGroundingIssues(
      page(`Auch ${service.normalize("NFD")} gehoert dazu.`),
      facts({ unapprovedServices: [service.normalize("NFC")] }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/does not offer/);
  });

  test("word boundaries still hold after normalising", () => {
    // Normalisation must not cost the boundary check that stops "Reinigung"
    // matching inside "Büroreinigung".
    expect(containsTerm("Büroreinigung in Essen", "Reinigung")).toBe(false);
    expect(containsTerm("Reinigung in Essen", "Reinigung")).toBe(true);
  });
});

describe("SF-08: an approved claim does not approve its fragments", () => {
  test("approving 95 % does not approve a fabricated 5 %", () => {
    // The old substring match: "95 % Kundenzufriedenheit" contains "5 %", so
    // one approved statistic quietly approved another the operator never saw.
    const issues = collectGroundingIssues(
      page("Nur 5 % unserer Auftraege scheitern."),
      facts({ allowedClaims: ["95 % Kundenzufriedenheit laut Umfrage"] }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/Unsupported statistic/);
  });

  test("approving 150 EUR does not approve 50 EUR", () => {
    const issues = collectGroundingIssues(
      page("Schon ab 50 EUR pro Einsatz."),
      facts({ allowedClaims: ["Pauschale 150 EUR pro Einsatz"] }),
    );

    expect(issues).toHaveLength(1);
  });

  test("the claim the operator actually approved still passes", () => {
    // The tightening must not make the whitelist useless.
    expect(
      collectGroundingIssues(
        page("Wir erreichen 95 % Kundenzufriedenheit."),
        facts({ allowedClaims: ["95 % Kundenzufriedenheit laut Umfrage"] }),
      ),
    ).toEqual([]);
  });

  test("an approved year still passes, but a longer digit run does not lend it", () => {
    expect(
      collectGroundingIssues(
        page("Nach DIN 77400 seit 2019 zertifiziert."),
        facts({ allowedClaims: ["DIN 77400 seit 2019"] }),
      ),
    ).toEqual([]);

    // "2019" is approved; "7740" appearing inside it is not a separate approval
    // and, equally, an unapproved 2020 must not ride along.
    const issues = collectGroundingIssues(
      page("Seit 2020 im Einsatz."),
      facts({ allowedClaims: ["DIN 77400 seit 2019"] }),
    );

    expect(issues).toHaveLength(1);
  });

  test("an approved claim written in a different Unicode form still matches", () => {
    const claim = "Geprüft nach DIN".normalize("NFC");
    const written = "Geprüft nach DIN".normalize("NFD");

    // The whitelist borrows containsTerm, so it borrows the normalisation.
    expect(
      collectGroundingIssues(
        page(`${written} 77400 seit 2019.`),
        facts({ allowedClaims: [`${claim} 77400 seit 2019`] }),
      ),
    ).toEqual([]);
  });

  test("a whitespace-only claim approves nothing", () => {
    // The schema rejects an empty claim outright, so the reachable case is one
    // that trims to nothing — which must not become a wildcard exemption.
    const issues = collectGroundingIssues(
      page("Seit 2020 im Einsatz."),
      facts({ allowedClaims: ["   "] }),
    );

    expect(issues).toHaveLength(1);
  });
});
