import { describe, expect, it } from "vitest";
import {
  FILE_NAME_LIMIT_BYTES,
  MAX_NAME_BYTES,
  truncateUtf8,
  nextAfterRemoval,
  renamedPath,
  stemLength,
  utf8Length,
  validateNoteName,
} from "./noteNames";

describe("validateNoteName", () => {
  it.each([
    ["deploy", "deploy.md"],
    ["Deploy Checklist", "Deploy Checklist.md"],
    ["notes.md", "notes.md"],
    ["NOTES.MD", "NOTES.MD"],
    ["  padded  ", "padded.md"],
    ["\tpadded.md\n", "padded.md"],
    ["v1.2 release", "v1.2 release.md"],
    ["archive.txt", "archive.txt.md"],
    ["año 日本 🐕", "año 日本 🐕.md"],
    ["a#b & c (draft) [x]", "a#b & c (draft) [x].md"],
    ["my tasks", "my tasks.md"],
    ["tasks list", "tasks list.md"],
    ["console", "console.md"],
    ["COM0", "COM0.md"],
    ["COM10", "COM10.md"],
    ["lpt", "lpt.md"],
    ["nul-terminated", "nul-terminated.md"],
    ["a".repeat(MAX_NAME_BYTES - 3), `${"a".repeat(MAX_NAME_BYTES - 3)}.md`],
  ])("accepts %j as %j", (input, name) => {
    expect(validateNoteName(input)).toEqual({ ok: true, name });
  });

  it.each([
    ["", "Enter a name."],
    ["   ", "Enter a name."],
    ["a/b", "Names cannot contain / or \\."],
    ["a\\b", "Names cannot contain / or \\."],
    ["a\0b", "Names cannot contain control characters."],
    ["a\u0007b", "Names cannot contain control characters."],
    ["a\u007fb", "Names cannot contain control characters."],
    ["a\u0085b", "Names cannot contain control characters."],
    ["a\nb", "Names cannot contain control characters."],
    ["a<b", 'Names cannot contain < > : " | ? or *.'],
    ["a>b", 'Names cannot contain < > : " | ? or *.'],
    ["a:b", 'Names cannot contain < > : " | ? or *.'],
    ['a"b', 'Names cannot contain < > : " | ? or *.'],
    ["a|b", 'Names cannot contain < > : " | ? or *.'],
    ["a?b", 'Names cannot contain < > : " | ? or *.'],
    ["a*b", 'Names cannot contain < > : " | ? or *.'],
    [".hidden", "Names cannot start with a dot."],
    [".md", "Names cannot start with a dot."],
    ["  .md", "Names cannot start with a dot."],
    ["name .md", "Names cannot end with a space or a dot."],
    ["name..md", "Names cannot end with a space or a dot."],
    ["name.", "Names cannot end with a space or a dot."],
    ["name. .md", "Names cannot end with a space or a dot."],
    ["CON", "CON is a reserved name on Windows."],
    ["con.md", "CON is a reserved name on Windows."],
    ["Prn", "PRN is a reserved name on Windows."],
    ["aux.txt", "AUX is a reserved name on Windows."],
    ["NUL.tar.md", "NUL is a reserved name on Windows."],
    ["com1", "COM1 is a reserved name on Windows."],
    ["COM9.md", "COM9 is a reserved name on Windows."],
    ["lpt1", "LPT1 is a reserved name on Windows."],
    ["LPT9.x", "LPT9 is a reserved name on Windows."],
    ["con .x", "CON is a reserved name on Windows."],
    ["tasks", "tasks.md is reserved for task lists."],
    ["tasks.md", "tasks.md is reserved for task lists."],
    ["Tasks.MD", "tasks.md is reserved for task lists."],
    ["a".repeat(MAX_NAME_BYTES - 2), "This name is too long."],
    ["é".repeat(99), "This name is too long."],
  ])("rejects %j: %s", (input, reason) => {
    expect(validateNoteName(input)).toEqual({ ok: false, reason });
  });

  it("counts the limit in UTF-8 bytes, extension included", () => {
    // 98 two-byte characters + ".md" = 199 bytes; one more is 201.
    expect(validateNoteName("é".repeat(98))).toEqual({ ok: true, name: `${"é".repeat(98)}.md` });
  });

  it("leaves room for conflict copies within the file system limit", () => {
    expect(MAX_NAME_BYTES).toBe(200);
    expect(MAX_NAME_BYTES).toBeLessThan(FILE_NAME_LIMIT_BYTES);
    // The longest accepted name with the longest conflict suffix still fits.
    const longest = `${"a".repeat(MAX_NAME_BYTES - 3)}.md`;
    expect(validateNoteName(longest)).toEqual({ ok: true, name: longest });
    expect(
      utf8Length(`${"a".repeat(MAX_NAME_BYTES - 3)} (conflict 2026-10-08 1432) 99.md`),
    ).toBeLessThanOrEqual(FILE_NAME_LIMIT_BYTES);
  });
});

describe("truncateUtf8", () => {
  it.each([
    ["abc", 5, "abc"],
    ["abc", 3, "abc"],
    ["abc", 2, "ab"],
    ["abc", 0, ""],
    ["aé", 2, "a"],
    ["aé", 3, "aé"],
    ["日本", 5, "日"],
    ["🐕🐕", 7, "🐕"],
    ["🐕🐕", 3, ""],
  ])("cuts %j to %i bytes", (text, bytes, expected) => {
    expect(truncateUtf8(text, bytes)).toBe(expected);
  });
});

describe("utf8Length", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["é", 2],
    ["日", 3],
    ["🐕", 4],
    ["\ud800", 3],
  ])("%j is %i bytes", (text, bytes) => {
    expect(utf8Length(text)).toBe(bytes);
  });
});

describe("stemLength", () => {
  it("leaves out the Markdown extension only", () => {
    expect(stemLength("deploy.md")).toBe(6);
    expect(stemLength("deploy.MD")).toBe(6);
    expect(stemLength("deploy")).toBe(6);
    expect(stemLength("a.txt")).toBe(5);
  });
});

describe("renamedPath", () => {
  it("keeps the folder", () => {
    expect(renamedPath("inbox/a.md", "b.md")).toBe("inbox/b.md");
    expect(renamedPath("api/sub/a.md", "b.md")).toBe("api/sub/b.md");
    expect(renamedPath("a.md", "b.md")).toBe("b.md");
  });
});

describe("nextAfterRemoval", () => {
  const ids = ["a", "b", "c"];

  it("selects the next item, else the previous one", () => {
    expect(nextAfterRemoval(ids, "a")).toBe("b");
    expect(nextAfterRemoval(ids, "b")).toBe("c");
    expect(nextAfterRemoval(ids, "c")).toBe("b");
  });

  it("returns null for the last item or an unknown one", () => {
    expect(nextAfterRemoval(["a"], "a")).toBeNull();
    expect(nextAfterRemoval(ids, "x")).toBeNull();
    expect(nextAfterRemoval([], "x")).toBeNull();
  });
});
