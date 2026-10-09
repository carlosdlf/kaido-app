import { describe, expect, it } from "vitest";
import { appendLines, hasUnionLine, missingIgnoreLines } from "./setupFiles";

describe("hasUnionLine", () => {
  it.each([
    ["tasks.md merge=union\n", true],
    ["**/tasks.md   merge=union", true],
    ["*.md text merge=union\r\n", true],
    ["**/*.md merge=union", true],
    ["/tasks.md merge=union", false],
    ["  tasks.md merge=union  ", true],
    ["*.md text\n", false],
    ["tasks.md text\n", false],
    ["other.md merge=union\n", false],
    ["", false],
  ])("%j → %s", (text, expected) => {
    expect(hasUnionLine(text)).toBe(expected);
  });

  it("treats a missing file as missing the line", () => {
    expect(hasUnionLine(null)).toBe(false);
  });
});

describe("missingIgnoreLines", () => {
  it("lists the lines that are not there yet", () => {
    expect(missingIgnoreLines(null)).toEqual([".kaido-*.tmp", ".Trash-*"]);
    expect(missingIgnoreLines("node_modules\n.Trash-*\n")).toEqual([".kaido-*.tmp"]);
    expect(missingIgnoreLines(".kaido-*.tmp\r\n.Trash-*")).toEqual([]);
    expect(missingIgnoreLines("**/.kaido-*.tmp\n**/.Trash-*\n")).toEqual([]);
  });
});

describe("appendLines", () => {
  it("creates, appends and keeps line endings", () => {
    expect(appendLines(null, ["a", "b"])).toBe("a\nb\n");
    expect(appendLines("", ["a"])).toBe("a\n");
    expect(appendLines("x\n", ["a"])).toBe("x\na\n");
    expect(appendLines("x", ["a"])).toBe("x\na\n");
    expect(appendLines("x\r\ny", ["a"])).toBe("x\r\ny\r\na\r\n");
  });
});
