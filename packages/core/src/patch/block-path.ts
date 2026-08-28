/**
 * Addressing one block inside a page, and replacing it.
 *
 * A visual editor does not send a page. It sends "the answer to FAQ 3 is now
 * this", and something has to turn that sentence into a write. The whole risk
 * of the feature is concentrated in that translation, because a path is a
 * string the client chose and a write is a mutation of a structure the client
 * does not own.
 *
 * ## What a path may not do
 *
 * **Reach the prototype.** `__proto__.polluted`, `constructor.prototype.x` —
 * a naive walk-and-assign turns an editor into a way to change the behaviour of
 * every object in the process. Segments naming the prototype chain are refused
 * outright rather than escaped or sanitised, because there is no legitimate
 * page field with those names and "reject" is the only rule with no edge cases.
 *
 * **Create structure.** Auto-vivification — inventing the objects a path passes
 * through — sounds convenient and means a typo silently grows a new shape
 * inside a validated payload. `content.hero.titel` would add a field rather
 * than fail, and the page would still parse because the schema ignores what it
 * does not name. Every segment must already exist.
 *
 * **Grow an array.** An index past the end is a mistake, not an append. A
 * client that wants a fourth FAQ entry is making a structural change, which is
 * a different operation from editing the third one.
 *
 * **Mutate the input.** Every function here returns a new value. The caller
 * needs the original intact to compare against, and to fall back to when the
 * gates refuse the result.
 */

/** Why a path or a patch was refused. */
export interface PatchIssue {
  path: string;
  message: string;
}

/** A parsed path, or the reason it was rejected. */
export type ParsedBlockPath =
  | { ok: true; segments: string[] }
  | { ok: false; issue: PatchIssue };

/**
 * Segment names that reach the prototype chain.
 *
 * Refused wherever they appear, at any depth. No page field is called any of
 * these, so nothing legitimate is lost by making the rule absolute.
 */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Longest path worth accepting. A page is four levels deep at most. */
const MAX_DEPTH = 8;

/**
 * Split a dotted path into segments, refusing anything dangerous.
 *
 * @param raw - A path such as `content.hero.heading` or `content.faq.0.answer`.
 */
export function parseBlockPath(raw: string): ParsedBlockPath {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, issue: { path: raw, message: "The path is empty." } };
  }

  const segments = trimmed.split(".");

  if (segments.length > MAX_DEPTH) {
    return {
      ok: false,
      issue: {
        path: raw,
        message: `The path is ${segments.length} levels deep; the limit is ${MAX_DEPTH}.`,
      },
    };
  }

  for (const segment of segments) {
    if (segment.length === 0) {
      return {
        ok: false,
        issue: {
          path: raw,
          message: "The path has an empty segment. Check for a doubled or trailing dot.",
        },
      };
    }

    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return {
        ok: false,
        issue: {
          path: raw,
          message:
            `"${segment}" addresses the prototype chain, not page content. ` +
            `No page field has that name.`,
        },
      };
    }

    // Anything outside this set is either a typo or an attempt to be clever
    // with a key. Page fields are plain identifiers and array indices.
    if (!/^[A-Za-z0-9_]+$/.test(segment)) {
      return {
        ok: false,
        issue: {
          path: raw,
          message: `"${segment}" is not a valid field name or array index.`,
        },
      };
    }
  }

  return { ok: true, segments };
}

/** Whether a value is a plain object we may walk into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the value a path addresses.
 *
 * @returns The value, or `undefined` when the path does not resolve. A field
 * that exists and holds `undefined` is indistinguishable from one that does not
 * exist, which is correct here: neither is something an editor can patch.
 */
export function getAtPath(root: unknown, segments: string[]): unknown {
  let current: unknown = root;

  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);

      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }

      current = current[index];
      continue;
    }

    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

/** The result of applying a patch. */
export type SetAtPathResult =
  | { ok: true; value: unknown }
  | { ok: false; issue: PatchIssue };

/**
 * Return a copy of `root` with the value at `segments` replaced.
 *
 * Copies only the nodes along the path — the rest of the structure is shared,
 * which is safe because nothing here mutates. The original is never touched, so
 * a caller whose gates refuse the result still holds the page it started with.
 *
 * @param root - The structure to patch.
 * @param segments - A path already through {@link parseBlockPath}.
 * @param value - What to put there.
 */
export function setAtPath(
  root: unknown,
  segments: string[],
  value: unknown,
): SetAtPathResult {
  if (segments.length === 0) {
    return {
      ok: false,
      issue: { path: "(root)", message: "The path is empty." },
    };
  }

  const [head, ...rest] = segments;

  if (head === undefined) {
    return {
      ok: false,
      issue: { path: "(root)", message: "The path is empty." },
    };
  }

  if (Array.isArray(root)) {
    const index = Number(head);

    if (!Number.isInteger(index) || index < 0) {
      return {
        ok: false,
        issue: {
          path: head,
          message: `"${head}" is not an array index.`,
        },
      };
    }

    if (index >= root.length) {
      // An index past the end is a mistake, not an append. Adding an entry is a
      // structural change and a different operation.
      return {
        ok: false,
        issue: {
          path: head,
          message:
            `Index ${index} is past the end of a ${root.length}-entry list. ` +
            `Patching cannot add entries.`,
        },
      };
    }

    const copy = [...root];

    if (rest.length === 0) {
      copy[index] = value;
      return { ok: true, value: copy };
    }

    const nested = setAtPath(root[index], rest, value);

    if (!nested.ok) {
      return { ok: false, issue: { ...nested.issue, path: `${head}.${nested.issue.path}` } };
    }

    copy[index] = nested.value;
    return { ok: true, value: copy };
  }

  if (!isRecord(root)) {
    return {
      ok: false,
      issue: {
        path: head,
        message: `Cannot walk into a ${root === null ? "null" : typeof root} value.`,
      },
    };
  }

  if (!Object.hasOwn(root, head)) {
    // No auto-vivification. A typo must fail rather than quietly grow a field
    // the schema will then ignore.
    return {
      ok: false,
      issue: {
        path: head,
        message:
          `"${head}" does not exist here. Patching replaces existing content; ` +
          `it does not create fields.`,
      },
    };
  }

  if (rest.length === 0) {
    return { ok: true, value: { ...root, [head]: value } };
  }

  const nested = setAtPath(root[head], rest, value);

  if (!nested.ok) {
    return { ok: false, issue: { ...nested.issue, path: `${head}.${nested.issue.path}` } };
  }

  return { ok: true, value: { ...root, [head]: nested.value } };
}
