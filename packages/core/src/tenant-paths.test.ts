import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  ProjectIdSchema,
  UnsafeIdentifierError,
  assertSafeProjectId,
  resolveOutputDir,
} from "./tenant-paths.js";

/**
 * A project id crosses two boundaries where a string stops being data: a shell
 * command line, and a filesystem path. These tests are about what must be
 * refused at both, and about the isolation the path itself provides.
 */

const ROOT = join("C:", "repo");

describe("ProjectIdSchema", () => {
  test("accepts the identifier shapes the database actually produces", () => {
    for (const id of ["prj_1", "cm3x9k2p0000abcdefghijkl", "prj-glanzfix-de", "A1"]) {
      expect(ProjectIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test("refuses anything a shell would read as syntax", () => {
    // Each of these is a working command on Windows, where the spawn goes
    // through a shell and argv entries are command-line fragments.
    for (const id of [
      "prj & whoami",
      "prj && calc",
      "prj|whoami",
      "prj;whoami",
      "prj`whoami`",
      "prj$(whoami)",
      'prj"x"',
      "prj>out.txt",
      "prj^x",
    ]) {
      expect(ProjectIdSchema.safeParse(id).success).toBe(false);
    }
  });

  test("refuses anything that could walk out of a directory", () => {
    for (const id of ["..", "../other", "a/b", "a\b", ".", "a.b"]) {
      expect(ProjectIdSchema.safeParse(id).success).toBe(false);
    }
  });

  test("refuses the empty string and anything past a sane length", () => {
    expect(ProjectIdSchema.safeParse("").success).toBe(false);
    expect(ProjectIdSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(ProjectIdSchema.safeParse("a".repeat(64)).success).toBe(true);
  });
});

describe("assertSafeProjectId", () => {
  test("returns the id when it is safe", () => {
    expect(assertSafeProjectId("prj_1")).toBe("prj_1");
  });

  test("throws with the field name, so an operator knows which input to fix", () => {
    expect(() => assertSafeProjectId("prj & whoami", "--project-id")).toThrow(
      UnsafeIdentifierError,
    );
    expect(() => assertSafeProjectId("prj & whoami", "--project-id")).toThrow(
      /--project-id/,
    );
  });
});

describe("resolveOutputDir", () => {
  test("local file mode keeps data/output, unchanged", () => {
    // One operator, one site. Moving it would break every existing invocation
    // and the web app's own fallback path.
    expect(resolveOutputDir(ROOT, undefined)).toBe(join(ROOT, "data", "output"));
  });

  test("a database run gets its own subtree", () => {
    expect(resolveOutputDir(ROOT, "prj_1")).toBe(
      join(ROOT, "data", "output", "prj_1"),
    );
  });

  test("two projects never resolve to the same directory", () => {
    // This is the whole point: savePages clears the pages directory before
    // writing it, so a shared directory means one run deletes the other's site
    // and the deployed output is whoever finished last.
    expect(resolveOutputDir(ROOT, "prj_a")).not.toBe(
      resolveOutputDir(ROOT, "prj_b"),
    );
  });

  test("a traversing id cannot escape the output tree", () => {
    expect(() => resolveOutputDir(ROOT, "../../..")).toThrow(
      UnsafeIdentifierError,
    );
    expect(() => resolveOutputDir(ROOT, "..")).toThrow(UnsafeIdentifierError);
  });

  test("every resolved directory stays under data/output", () => {
    const base = join(ROOT, "data", "output");

    for (const id of [undefined, "prj_1", "a".repeat(64)]) {
      expect(resolveOutputDir(ROOT, id).startsWith(base)).toBe(true);
    }
  });
});
