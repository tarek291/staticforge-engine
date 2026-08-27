import type {
  Business,
  ContentIssue,
  Location,
  Service,
} from "@staticforge/schemas";
import { z } from "zod";

/**
 * Fact grounding: what the model is told, and what it is held to.
 *
 * Two halves of one mechanism. {@link renderGroundingFacts} puts the verified
 * record in front of the model so it has no reason to invent;
 * {@link collectGroundingIssues} then checks the answer against that same
 * record, because a prompt is a request and not a guarantee.
 *
 * ## Why the detectors look the way they do
 *
 * The engine hardcodes no human language, so the guards cannot be keyword
 * lists — a German "zertifiziert" list would silently stop working the moment a
 * tenant writes in English. Every detector here is either language-neutral by
 * construction (an email address, a currency amount, a four-digit year) or
 * matches strings that came from the tenant's own data (a service name, a city
 * name). Nothing depends on knowing the language of the text.
 *
 * ## What this cannot catch
 *
 * A fluent, plausible, unverifiable sentence with no number, no name and no
 * contact detail in it — "our teams are the most experienced in the region" —
 * passes. These guards catch *checkable* fabrication: a contact that does not
 * exist, a price nobody quoted, a founding year nobody supplied, a service the
 * business does not sell. That is the class of hallucination that turns into a
 * complaint, a refund, or a false-advertising claim.
 */

/** A price the business actually quotes, in one currency. */
export const KnownPriceSchema = z.object({
  from: z.number().nonnegative(),
  to: z.number().nonnegative(),
  currency: z.string().min(1),
});
export type KnownPrice = z.infer<typeof KnownPriceSchema>;

/** The verified record for one page. */
export const GroundingFactsSchema = z.object({
  businessName: z.string().min(1),
  /** Present only when the business supplied one. Absent means any year is a fabrication. */
  foundedYear: z.number().int().optional(),

  /** Contact details the page is allowed to publish. */
  emails: z.array(z.string().min(1)).default([]),
  phones: z.array(z.string().min(1)).default([]),
  urls: z.array(z.string().min(1)).default([]),

  /** Services this business actually sells. */
  approvedServices: z.array(z.string().min(1)).default([]),
  /** Cities this business actually serves. */
  approvedCities: z.array(z.string().min(1)).default([]),

  /**
   * Catalogue entries this business does **not** cover. Naming one on the page
   * promises work the operator cannot deliver.
   */
  unapprovedServices: z.array(z.string().min(1)).default([]),
  unapprovedCities: z.array(z.string().min(1)).default([]),

  /** Price ranges the business quotes. Empty means no price may be stated. */
  prices: z.array(KnownPriceSchema).default([]),

  /**
   * Verbatim claims the operator has approved — a certification, a guarantee,
   * a statistic they can evidence. Anything listed here is exempt from every
   * guard below.
   */
  allowedClaims: z.array(z.string().min(1)).default([]),
});
export type GroundingFacts = z.infer<typeof GroundingFactsSchema>;

/** Knobs for {@link collectGroundingIssues}. */
export interface GroundingOptions {
  /**
   * Reject any percentage figure. Percentages in marketing copy are almost
   * always statistics the model cannot have — satisfaction rates, success
   * rates — so they are refused unless whitelisted. Default true.
   */
  rejectPercentages?: boolean;
}

// ---------------------------------------------------------------------------
// Language-neutral detectors
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/giu;
const YEAR_PATTERN = /\b(?:1[89]\d{2}|20\d{2})\b/gu;
const PERCENT_PATTERN = /\b\d{1,3}(?:[.,]\d+)?\s?%/gu;

/** A currency symbol or ISO code, before or after the number. */
const MONEY_PATTERN =
  /(?:[€$£¥]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:€|\$|£|¥|EUR|USD|GBP|CHF)\b)/giu;

/** International or trunk-prefixed phone numbers, loosely. */
const PHONE_PATTERN = /(?:\+\d[\d\s().\-/]{6,}\d|\b0\d[\d\s().\-/]{7,}\d)/gu;

/** Strip everything but digits, so formatting differences do not matter. */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Parse a money match into a number, tolerating both decimal conventions. */
function parseAmount(match: string): number | undefined {
  const numeric = match.replace(/[^\d.,]/g, "").trim();
  if (numeric.length === 0) {
    return undefined;
  }

  // "1.234,56" → German grouping; "1,234.56" → English grouping.
  const normalized =
    numeric.lastIndexOf(",") > numeric.lastIndexOf(".")
      ? numeric.replace(/\./g, "").replace(",", ".")
      : numeric.replace(/,/g, "");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether `term` appears in `text` as a whole word.
 *
 * `\b` is unreliable outside ASCII, so boundaries are checked by hand against
 * the Unicode letter and number classes — otherwise "Essen" would never be
 * found next to a German umlaut, and "Reinigung" would falsely match inside
 * "Büroreinigung".
 *
 * ## Why both sides are normalised
 *
 * "Düsseldorf" has two valid encodings: one code point for `ü`, or `u` followed
 * by a combining diaeresis. They render identically and compare unequal. A
 * model answering in the decomposed form while the verified record holds the
 * composed one slipped past every name-based guard built on this function — the
 * city the business does not serve, the service it does not sell — with the
 * check reporting a clean page. Normalising both sides to NFC first makes the
 * comparison about the text rather than about which encoding produced it.
 */
export function containsTerm(text: string, term: string): boolean {
  const haystack = text.normalize("NFC").toLowerCase();
  const needle = term.normalize("NFC").toLowerCase().trim();

  if (needle.length === 0) {
    return false;
  }

  const isWordChar = (char: string | undefined): boolean =>
    char !== undefined && /[\p{L}\p{N}]/u.test(char);

  let index = haystack.indexOf(needle);

  while (index !== -1) {
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];

    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }

    index = haystack.indexOf(needle, index + 1);
  }

  return false;
}

/** Every string a page renders, flattened for scanning. */
export function collectText(content: {
  title: string;
  metaDescription: string;
  h1: string;
  content: {
    hero: { heading: string; subheading?: string | undefined };
    sections: Array<{ heading: string; body: string }>;
    faq: Array<{ question: string; answer: string }>;
    cta: {
      heading: string;
      buttonLabel: string;
      href: string;
      secondary?: { buttonLabel: string; href: string } | undefined;
    };
  };
}): Array<{ path: string; text: string }> {
  const parts: Array<{ path: string; text: string }> = [
    { path: "title", text: content.title },
    { path: "metaDescription", text: content.metaDescription },
    { path: "h1", text: content.h1 },
    { path: "content.hero.heading", text: content.content.hero.heading },
  ];

  if (content.content.hero.subheading !== undefined) {
    parts.push({
      path: "content.hero.subheading",
      text: content.content.hero.subheading,
    });
  }

  content.content.sections.forEach((section, index) => {
    parts.push(
      { path: `content.sections[${index}].heading`, text: section.heading },
      { path: `content.sections[${index}].body`, text: section.body },
    );
  });

  content.content.faq.forEach((item, index) => {
    parts.push(
      { path: `content.faq[${index}].question`, text: item.question },
      { path: `content.faq[${index}].answer`, text: item.answer },
    );
  });

  parts.push(
    { path: "content.cta.heading", text: content.content.cta.heading },
    { path: "content.cta.buttonLabel", text: content.content.cta.buttonLabel },
    { path: "content.cta.href", text: content.content.cta.href },
  );

  if (content.content.cta.secondary !== undefined) {
    parts.push(
      // The label is rendered text on a clickable control, which makes it one
      // of the likeliest places on the page to carry a phone number — so it is
      // scanned like every other visible string, not skipped because it is
      // short.
      {
        path: "content.cta.secondary.buttonLabel",
        text: content.content.cta.secondary.buttonLabel,
      },
      {
        path: "content.cta.secondary.href",
        text: content.content.cta.secondary.href,
      },
    );
  }

  return parts;
}

/**
 * Whether the operator has pre-approved a claim containing this fragment.
 *
 * Matched on word boundaries rather than as a bare substring. A plain
 * `includes` makes every approved claim silently approve its own fragments:
 * approving "95 % Kundenzufriedenheit" also approves a fabricated "5 %",
 * because the second string sits inside the first. The same holds for money —
 * approving "150 €" would approve "50 €" — and for years inside longer digit
 * runs. An exemption should cover what the operator wrote, not everything
 * spellable from its characters.
 *
 * {@link containsTerm} supplies the boundaries, and with them the same NFC
 * normalisation the other guards get, so a claim and a page written in
 * different Unicode forms still match.
 */
function isWhitelisted(fragment: string, facts: GroundingFacts): boolean {
  const needle = fragment.trim();

  if (needle.length === 0) {
    return false;
  }

  return facts.allowedClaims.some((claim) => containsTerm(claim, needle));
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Every contact detail on the page must be one the business actually owns. */
function checkContacts(
  parts: Array<{ path: string; text: string }>,
  facts: GroundingFacts,
  issues: ContentIssue[],
): void {
  const knownEmails = new Set(facts.emails.map((value) => value.toLowerCase()));
  const knownPhones = new Set(facts.phones.map(digitsOnly));
  const knownUrls = facts.urls.map((value) => value.toLowerCase());

  for (const { path, text } of parts) {
    for (const match of text.matchAll(EMAIL_PATTERN)) {
      const email = match[0].toLowerCase();
      if (!knownEmails.has(email) && !isWhitelisted(email, facts)) {
        issues.push({
          path,
          message: `Unverified email address "${match[0]}". Known: ${facts.emails.join(", ") || "(none supplied)"}.`,
        });
      }
    }

    for (const match of text.matchAll(PHONE_PATTERN)) {
      const digits = digitsOnly(match[0]);
      // A "phone number" shorter than seven digits is a date or a quantity.
      if (digits.length < 7) {
        continue;
      }
      if (
        !knownPhones.has(digits) &&
        ![...knownPhones].some((known) => known.endsWith(digits) || digits.endsWith(known)) &&
        !isWhitelisted(match[0], facts)
      ) {
        issues.push({
          path,
          message: `Unverified phone number "${match[0].trim()}". Known: ${facts.phones.join(", ") || "(none supplied)"}.`,
        });
      }
    }

    for (const match of text.matchAll(URL_PATTERN)) {
      const url = match[0].toLowerCase();
      if (
        !knownUrls.some((known) => url.startsWith(known)) &&
        !isWhitelisted(url, facts)
      ) {
        issues.push({
          path,
          message: `Unverified URL "${match[0]}". Known: ${facts.urls.join(", ") || "(none supplied)"}.`,
        });
      }
    }
  }
}

/** A stated price must fall inside a range the business actually quotes. */
function checkPrices(
  parts: Array<{ path: string; text: string }>,
  facts: GroundingFacts,
  issues: ContentIssue[],
): void {
  for (const { path, text } of parts) {
    for (const match of text.matchAll(MONEY_PATTERN)) {
      if (isWhitelisted(match[0], facts)) {
        continue;
      }

      if (facts.prices.length === 0) {
        issues.push({
          path,
          message: `Price claim "${match[0].trim()}" but no pricing was supplied for this service. Remove the figure or add it to the service record.`,
        });
        continue;
      }

      const amount = parseAmount(match[0]);
      const covered =
        amount !== undefined &&
        facts.prices.some((price) => amount >= price.from && amount <= price.to);

      if (!covered) {
        issues.push({
          path,
          message:
            `Price claim "${match[0].trim()}" is outside every quoted range ` +
            `(${facts.prices.map((p) => `${p.from}–${p.to} ${p.currency}`).join(", ")}).`,
        });
      }
    }
  }
}

/** A year on the page must be the founding year the business supplied. */
function checkYears(
  parts: Array<{ path: string; text: string }>,
  facts: GroundingFacts,
  issues: ContentIssue[],
): void {
  for (const { path, text } of parts) {
    for (const match of text.matchAll(YEAR_PATTERN)) {
      const year = Number(match[0]);

      if (facts.foundedYear === year || isWhitelisted(match[0], facts)) {
        continue;
      }

      issues.push({
        path,
        message:
          facts.foundedYear === undefined
            ? `Year "${match[0]}" claimed, but no founding year was supplied. The business record carries no date to support it.`
            : `Year "${match[0]}" does not match the recorded founding year ${facts.foundedYear}.`,
      });
    }
  }
}

/** The page may not promise services or cities the business does not cover. */
function checkScope(
  parts: Array<{ path: string; text: string }>,
  facts: GroundingFacts,
  issues: ContentIssue[],
): void {
  for (const { path, text } of parts) {
    for (const service of facts.unapprovedServices) {
      if (
        containsTerm(text, service) &&
        !facts.approvedServices.some((approved) => containsTerm(approved, service)) &&
        !isWhitelisted(service, facts)
      ) {
        issues.push({
          path,
          message: `Names service "${service}", which this business does not offer. Approved: ${facts.approvedServices.join(", ") || "(none)"}.`,
        });
      }
    }

    for (const city of facts.unapprovedCities) {
      if (
        containsTerm(text, city) &&
        !facts.approvedCities.some((approved) => containsTerm(approved, city)) &&
        !isWhitelisted(city, facts)
      ) {
        issues.push({
          path,
          message: `Names city "${city}", which this business does not serve. Approved: ${facts.approvedCities.join(", ") || "(none)"}.`,
        });
      }
    }
  }
}

/** Percentages are statistics the model cannot have. */
function checkPercentages(
  parts: Array<{ path: string; text: string }>,
  facts: GroundingFacts,
  issues: ContentIssue[],
): void {
  for (const { path, text } of parts) {
    for (const match of text.matchAll(PERCENT_PATTERN)) {
      if (!isWhitelisted(match[0], facts)) {
        issues.push({
          path,
          message: `Unsupported statistic "${match[0].trim()}". No figure in the business record backs it.`,
        });
      }
    }
  }
}

/**
 * Check authored content against the verified record.
 *
 * Collects every finding rather than stopping at the first, so an operator sees
 * the whole picture in one pass — the same failure style used everywhere else
 * in the engine.
 *
 * @param content - The authored slice of a page.
 * @param facts - The verified record for this page.
 * @param options - Guard configuration.
 * @returns Every unsupported claim found. Empty means the page is grounded.
 */
export function collectGroundingIssues(
  content: Parameters<typeof collectText>[0],
  facts: GroundingFacts,
  options: GroundingOptions = {},
): ContentIssue[] {
  const { rejectPercentages = true } = options;
  const parts = collectText(content);
  const issues: ContentIssue[] = [];

  checkContacts(parts, facts, issues);
  checkPrices(parts, facts, issues);
  checkYears(parts, facts, issues);
  checkScope(parts, facts, issues);

  if (rejectPercentages) {
    checkPercentages(parts, facts, issues);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Building facts, and telling the model about them
// ---------------------------------------------------------------------------

/** The catalogue a page is drawn from, used to know what is *not* approved. */
export interface FactCatalogue {
  services: Service[];
  locations: Location[];
}

/**
 * Assemble the verified record for one service-in-city page.
 *
 * The business's eligibility fields decide what counts as approved; everything
 * else in the catalogue becomes explicitly unapproved, which is what makes
 * "promises a service we do not sell" detectable at all.
 *
 * The page's own city is not a parameter: it is already in the approved set,
 * and the record describes what the *business* may claim rather than what this
 * one page is about.
 *
 * @param service - The page's service. Only its pricing enters the record, so
 * a page about one service cannot quote another's rates.
 */
export function buildGroundingFacts(
  business: Business,
  service: Service,
  catalogue: FactCatalogue,
  allowedClaims: string[] = [],
): GroundingFacts {
  const eligibleServiceIds = business.serviceIds;
  const eligibleLocationIds = business.locationIds;

  const approvedServices = catalogue.services.filter(
    (item) => eligibleServiceIds === undefined || eligibleServiceIds.includes(item.id),
  );
  const approvedLocations = catalogue.locations.filter(
    (item) => eligibleLocationIds === undefined || eligibleLocationIds.includes(item.id),
  );

  const approvedServiceIds = new Set(approvedServices.map((item) => item.id));
  const approvedLocationIds = new Set(approvedLocations.map((item) => item.id));

  return GroundingFactsSchema.parse({
    businessName: business.name,
    ...(business.foundedYear !== undefined
      ? { foundedYear: business.foundedYear }
      : {}),

    emails: [business.contactEmail],
    phones: [business.contactPhone],
    urls: [],

    approvedServices: approvedServices.map((item) => item.name),
    approvedCities: approvedLocations.map((item) => item.city),

    unapprovedServices: catalogue.services
      .filter((item) => !approvedServiceIds.has(item.id))
      .map((item) => item.name),
    unapprovedCities: catalogue.locations
      .filter((item) => !approvedLocationIds.has(item.id))
      .map((item) => item.city),

    // Only this service's pricing: a page about one service may not quote
    // another service's rates.
    prices:
      service.pricing !== undefined
        ? [
            {
              from: service.pricing.from,
              to: service.pricing.to,
              currency: service.pricing.currency,
            },
          ]
        : [],

    allowedClaims,
  });
}

/**
 * Render the verified record as prompt text.
 *
 * This is the half that prevents fabrication rather than catching it. The model
 * is given the record and told plainly which figures it may state, so it has no
 * reason to guess — and is told that anything else is rejected, so guessing has
 * no upside.
 */
export function renderGroundingFacts(facts: GroundingFacts): string {
  const lines: string[] = [
    "## Verified record",
    "",
    "These are the only facts you may state. Everything below is checked against this record after you answer, and content that states anything else is rejected outright.",
    "",
    `- Business name: ${facts.businessName}`,
  ];

  lines.push(
    facts.foundedYear !== undefined
      ? `- Founding year: ${facts.foundedYear} — the only year you may mention.`
      : "- Founding year: not supplied. Do not state any year, in any form.",
  );

  lines.push(
    facts.emails.length > 0
      ? `- Email: ${facts.emails.join(", ")}`
      : "- Email: none. Do not write an email address.",
    facts.phones.length > 0
      ? `- Phone: ${facts.phones.join(", ")}`
      : "- Phone: none. Do not write a phone number.",
  );

  if (facts.urls.length > 0) {
    lines.push(`- Web addresses: ${facts.urls.join(", ")}`);
  } else {
    lines.push("- Web addresses: none. Do not write a URL.");
  }

  lines.push(
    facts.prices.length > 0
      ? `- Pricing: ${facts.prices.map((p) => `${p.from}–${p.to} ${p.currency}`).join(", ")}. You may describe what drives the price, but no figure outside this range.`
      : "- Pricing: not supplied. Do not state any price or currency amount. You may still explain what drives cost.",
  );

  if (facts.approvedServices.length > 0) {
    lines.push(`- Services this business offers: ${facts.approvedServices.join(", ")}`);
  }
  if (facts.unapprovedServices.length > 0) {
    lines.push(
      `- Services it does NOT offer, and must not be named: ${facts.unapprovedServices.join(", ")}`,
    );
  }
  if (facts.approvedCities.length > 0) {
    lines.push(`- Cities it serves: ${facts.approvedCities.join(", ")}`);
  }
  if (facts.unapprovedCities.length > 0) {
    lines.push(
      `- Cities it does NOT serve, and must not be named: ${facts.unapprovedCities.join(", ")}`,
    );
  }

  lines.push(
    facts.allowedClaims.length > 0
      ? `- Pre-approved claims you may repeat verbatim: ${facts.allowedClaims.join("; ")}`
      : "- No certifications, awards, guarantees, review counts, customer numbers or statistics have been supplied. Do not state any.",
    "",
    "Percentages are treated as unsupported statistics unless they appear above.",
  );

  return lines.join("\n");
}
