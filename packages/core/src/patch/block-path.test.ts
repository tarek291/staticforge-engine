import { describe, expect, test } from "vitest";

import { getAtPath, parseBlockPath, setAtPath } from "./block-path.js";

/**
 * A path is a string the client chose; a write is a mutation of a structure the
 * client does not own. Everything dangerous about block patching is in that
 * sentence, so most of what follows is refusals.
 */

/** A page-shaped structure to walk. */
function page() {
  return {
    title: "A title",
    content: {
      hero: { heading: "Hero", subheading: "Sub" },
      faq: [
        { question: "Q1", answer: "A1" },
        { question: "Q2", answer: "A2" },
      ],
      cta: { heading: "CTA", buttonLabel: "Go", href: "#contact" },
    },
  };
}

/** Parse and set in one step, for the common case. */
function patch(root: unknown, path: string, value: unknown) {
  const parsed = parseBlockPath(path);
  if (!parsed.ok) return { ok: false as const, issue: parsed.issue };
  return setAtPath(root, parsed.segments, value);
}

describe("parseBlockPath refuses what cannot be a page field", () => {
  test("accepts ordinary field and index paths", () => {
    for (const path of ["title", "content.hero.heading", "content.faq.0.answer"]) {
      expect(parseBlockPath(path).ok, path).toBe(true);
    }
  });

  test("refuses every segment that reaches the prototype chain", () => {
    // A naive walk-and-assign here turns an editor into a way to change the
    // behaviour of every object in the process.
    for (const path of [
      "__proto__",
      "__proto__.polluted",
      "content.__proto__.x",
      "constructor",
      "constructor.prototype.x",
      "content.hero.constructor",
      "content.prototype",
    ]) {
      const result = parseBlockPath(path);

      expect(result.ok, path).toBe(false);
      expect(result.ok === false && result.issue.message).toMatch(/prototype chain/);
    }
  });

  test("refuses empty, doubled and trailing separators", () => {
    for (const path of ["", "   ", ".", "content..hero", "content.", ".content"]) {
      expect(parseBlockPath(path).ok, path).toBe(false);
    }
  });

  test("refuses segments that are not plain names or indices", () => {
    for (const path of [
      "content[0]",
      "content.hero heading",
      "content.hero-heading",
      "content.hero/../slug",
      "content.$where",
    ]) {
      expect(parseBlockPath(path).ok, path).toBe(false);
    }
  });

  test("refuses an absurdly deep path", () => {
    expect(parseBlockPath("a.b.c.d.e.f.g.h.i.j").ok).toBe(false);
  });
});

describe("getAtPath", () => {
  test("reads nested fields and array entries", () => {
    expect(getAtPath(page(), ["content", "hero", "heading"])).toBe("Hero");
    expect(getAtPath(page(), ["content", "faq", "1", "answer"])).toBe("A2");
  });

  test("returns undefined rather than throwing on a miss", () => {
    expect(getAtPath(page(), ["content", "nope"])).toBeUndefined();
    expect(getAtPath(page(), ["content", "faq", "9", "answer"])).toBeUndefined();
    expect(getAtPath(page(), ["title", "deeper"])).toBeUndefined();
  });

  test("does not see inherited properties", () => {
    expect(getAtPath(page(), ["toString"])).toBeUndefined();
    expect(getAtPath(page(), ["content", "hasOwnProperty"])).toBeUndefined();
  });
});

describe("setAtPath replaces without mutating", () => {
  test("replaces a nested field", () => {
    const result = patch(page(), "content.hero.heading", "New");

    expect(result.ok).toBe(true);
    expect(result.ok && getAtPath(result.value, ["content", "hero", "heading"])).toBe(
      "New",
    );
  });

  test("replaces an array entry by index", () => {
    const result = patch(page(), "content.faq.1.answer", "Revised");

    expect(result.ok && getAtPath(result.value, ["content", "faq", "1", "answer"])).toBe(
      "Revised",
    );
  });

  test("leaves the original untouched", () => {
    // The caller needs the original to compare against, and to fall back to
    // when the gates refuse the result.
    const original = page();
    const before = JSON.stringify(original);

    patch(original, "content.hero.heading", "New");

    expect(JSON.stringify(original)).toBe(before);
  });

  test("leaves siblings alone", () => {
    const result = patch(page(), "content.faq.0.answer", "Revised");

    expect(result.ok && getAtPath(result.value, ["content", "faq", "1", "answer"])).toBe(
      "A2",
    );
    expect(result.ok && getAtPath(result.value, ["content", "hero", "heading"])).toBe(
      "Hero",
    );
  });
});

describe("setAtPath refuses to invent structure", () => {
  test("a field that does not exist is a failure, not a creation", () => {
    // Auto-vivification means a typo silently grows a field the schema then
    // ignores, and the page still parses.
    const result = patch(page(), "content.hero.titel", "Typo");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issue.message).toMatch(/does not exist/);
  });

  test("an index past the end is a mistake, not an append", () => {
    const result = patch(page(), "content.faq.5.answer", "New entry");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issue.message).toMatch(/past the end/);
  });

  test("cannot walk into a scalar", () => {
    const result = patch(page(), "title.deeper", "x");

    expect(result.ok).toBe(false);
  });

  test("cannot reach an inherited key even with a valid-looking path", () => {
    const result = patch(page(), "toString", "x");

    expect(result.ok).toBe(false);
  });

  test("reports where in the path it stopped", () => {
    const result = patch(page(), "content.faq.0.missing", "x");

    expect(result.ok === false && result.issue.path).toBe("content.faq.0.missing");
  });
});

describe("prototype pollution, end to end", () => {
  test("no patch can add a property to Object.prototype", () => {
    for (const path of ["__proto__.polluted", "constructor.prototype.polluted"]) {
      patch(page(), path, "yes");
    }

    // The assertion that matters. If either path had been applied, every object
    // in the process would now carry this key.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  test("a payload whose own key is __proto__ still cannot pollute", () => {
    // The value being written is the client's too. Replacing a field with an
    // object carrying a `__proto__` key must not reparent anything — plain
    // assignment does not, and this pins that.
    const result = patch(page(), "content.hero.heading", {
      ["__proto__"]: { polluted: "yes" },
    });

    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
