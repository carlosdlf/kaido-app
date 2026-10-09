import { describe, expect, it } from "vitest";
import {
  formatTable,
  nextCell,
  previousCell,
  splitRow,
  tablePrefixLength,
  textWidth,
} from "./markdownTable";

const texts = (line: string) => splitRow(line).map((cell) => cell.text);

describe("textWidth", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(textWidth("")).toBe(0);
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("café")).toBe(4);
    expect(textWidth("🐕")).toBe(1);
    expect(textWidth("a🐕b𝔸")).toBe(4);
  });
});

describe("tablePrefixLength", () => {
  it("measures indentation and quote markers", () => {
    expect(tablePrefixLength("| a |")).toBe(0);
    expect(tablePrefixLength("  | a |")).toBe(2);
    expect(tablePrefixLength("> | a |")).toBe(2);
    expect(tablePrefixLength("> > | a |")).toBe(4);
    expect(tablePrefixLength("  >\t| a |")).toBe(4);
    expect(tablePrefixLength("a | b")).toBe(0);
  });
});

describe("splitRow", () => {
  it("splits on pipes with optional outer pipes", () => {
    expect(texts("| a | b |")).toEqual(["a", "b"]);
    expect(texts("a | b")).toEqual(["a", "b"]);
    expect(texts("| a | b")).toEqual(["a", "b"]);
    expect(texts("a | b |")).toEqual(["a", "b"]);
    expect(texts("  |a|b|  ")).toEqual(["a", "b"]);
    expect(texts("plain")).toEqual(["plain"]);
    expect(texts("")).toEqual([""]);
    expect(texts("|")).toEqual([""]);
    expect(texts("||")).toEqual([""]);
    expect(texts("| |  |")).toEqual(["", ""]);
  });

  it("reports cell offsets between the pipes", () => {
    expect(splitRow("| a |b|")).toEqual([
      { text: "a", from: 1, to: 4 },
      { text: "b", from: 5, to: 6 },
    ]);
    expect(splitRow("x|y")).toEqual([
      { text: "x", from: 0, to: 1 },
      { text: "y", from: 2, to: 3 },
    ]);
  });

  it("keeps escaped pipes in the cell", () => {
    expect(texts("| a \\| b | c |")).toEqual(["a \\| b", "c"]);
    expect(texts("| a \\|")).toEqual(["a \\|"]);
    // An escaped backslash does not escape the pipe after it.
    expect(texts("| a \\\\| b |")).toEqual(["a \\\\", "b"]);
    expect(texts("| a \\")).toEqual(["a \\"]);
  });

  it("splits on pipes inside code spans, as GFM does", () => {
    expect(texts("| `a|b` | c |")).toEqual(["`a", "b`", "c"]);
    expect(texts("| ``a|b`` |")).toEqual(["``a", "b``"]);
    // Escaping keeps the pipe in the code span.
    expect(texts("| `a\\|b` | c |")).toEqual(["`a\\|b`", "c"]);
  });
});

describe("formatTable", () => {
  it("aligns columns with padded cells", () => {
    expect(formatTable(["|a|bb|", "|-|-|", "|ccc c|d|"])).toEqual([
      "| a     | bb  |",
      "| ----- | --- |",
      "| ccc c | d   |",
    ]);
  });

  it("keeps alignment markers and pads accordingly", () => {
    expect(
      formatTable(["| l | r | c | n |", "|:-|-:|:-:|-|", "| left | right | mid | x |"]),
    ).toEqual([
      "| l    |     r |  c  | n   |",
      "| :--- | ----: | :-: | --- |",
      "| left | right | mid | x   |",
    ]);
    expect(formatTable(["| c |", "|:-:|", "| abcdef |"])).toEqual([
      "|   c    |",
      "| :----: |",
      "| abcdef |",
    ]);
  });

  it("pads short rows and keeps extra cells as columns", () => {
    expect(formatTable(["| a | b |", "|---|---|", "| 1 |", "| 1 | 2 | 3 |"])).toEqual([
      "| a   | b   |     |",
      "| --- | --- | --- |",
      "| 1   |     |     |",
      "| 1   | 2   | 3   |",
    ]);
  });

  it("keeps escaped pipes, also in code spans", () => {
    expect(formatTable(["|a|b|", "|-|-|", "|`x\\|y`|\\|"])).toEqual([
      "| a      | b   |",
      "| ------ | --- |",
      "| `x\\|y` | \\|  |",
    ]);
  });

  it("splits a code span with a bare pipe into two cells", () => {
    expect(formatTable(["|a|b|", "|-|-|", "|`x|y`|"])).toEqual([
      "| a   | b   |",
      "| --- | --- |",
      "| `x  | y`  |",
    ]);
  });

  it("measures by code point", () => {
    expect(formatTable(["| a | b |", "|-|-|", "| 🐕🐕🐕🐕 | é |"])).toEqual([
      "| a    | b   |",
      "| ---- | --- |",
      "| 🐕🐕🐕🐕 | é   |",
    ]);
  });

  it("formats rows without outer pipes", () => {
    expect(formatTable(["a | b", "- | -", "c"])).toEqual([
      "| a   | b   |",
      "| --- | --- |",
      "| c   |     |",
    ]);
  });

  it("is stable on an aligned table", () => {
    const table = ["| a   |   b |", "| :-- | --: |", "| 1   |   2 |"];
    expect(formatTable(table)).toEqual(table);
  });

  it("rejects text that is not a table", () => {
    expect(formatTable([])).toBeNull();
    expect(formatTable(["| a |"])).toBeNull();
    expect(formatTable(["| a |", "| b |"])).toBeNull();
    expect(formatTable(["| a |", "|:|"])).toBeNull();
  });
});

describe("nextCell", () => {
  const table = ["|a|bb|", "|-|-:|", "|c|d|"];

  it("formats and moves to the next cell in the row", () => {
    expect(nextCell(table, { line: 0, column: 1 })).toEqual({
      lines: ["| a   |  bb |", "| --- | --: |", "| c   |   d |"],
      // The second column is right-aligned.
      cursor: { line: 0, column: 9 },
    });
  });

  it("moves from the end of a row to the next row, skipping the delimiter", () => {
    expect(nextCell(table, { line: 0, column: 5 })?.cursor).toEqual({ line: 2, column: 2 });
    // Right before the trailing pipe still counts as the last cell.
    expect(nextCell(table, { line: 0, column: 4 })?.cursor).toEqual({ line: 2, column: 2 });
    // Past the trailing pipe too.
    expect(nextCell(table, { line: 0, column: 6 })?.cursor).toEqual({ line: 2, column: 2 });
  });

  it("moves from the delimiter row to the first body cell", () => {
    expect(nextCell(table, { line: 1, column: 3 })?.cursor).toEqual({ line: 2, column: 2 });
  });

  it("enters right-aligned cells where the text starts", () => {
    expect(nextCell(table, { line: 2, column: 0 })?.cursor).toEqual({ line: 2, column: 10 });
  });

  it("adds a row after the last cell of the last row", () => {
    expect(nextCell(table, { line: 2, column: 4 })).toEqual({
      lines: ["| a   |  bb |", "| --- | --: |", "| c   |   d |", "|     |     |"],
      cursor: { line: 3, column: 2 },
    });
  });

  it("adds the first body row from the header or the delimiter row", () => {
    const empty = ["| a | b |", "|---|---|"];
    const added = ["| a   | b   |", "| --- | --- |", "|     |     |"];
    expect(nextCell(empty, { line: 0, column: 7 })).toEqual({
      lines: added,
      cursor: { line: 2, column: 2 },
    });
    expect(nextCell(empty, { line: 1, column: 0 })).toEqual({
      lines: added,
      cursor: { line: 2, column: 2 },
    });
  });

  it("walks into padded and extra columns", () => {
    const ragged = ["| a | b | c |", "|---|---|---|", "| 1 |"];
    expect(nextCell(ragged, { line: 2, column: 2 })?.cursor).toEqual({ line: 2, column: 8 });
    const wide = ["| a |", "|---|", "| 1 | 2 |"];
    const edit = nextCell(wide, { line: 0, column: 2 });
    expect(edit).toEqual({
      lines: ["| a   |     |", "| --- | --- |", "| 1   | 2   |"],
      cursor: { line: 0, column: 8 },
    });
  });

  it("maps the cursor by UTF-16 offset after wide characters", () => {
    const edit = nextCell(["| 🐕 | b |", "|---|---|"], { line: 0, column: 1 });
    expect(edit?.lines[0]).toBe("| 🐕   | b   |");
    // The dog takes two UTF-16 units.
    expect(edit?.cursor).toEqual({ line: 0, column: 9 });
    expect(edit?.lines[0]?.slice(edit.cursor.column)).toBe("b   |");
  });

  it("clamps a cursor outside the table", () => {
    expect(nextCell(table, { line: -1, column: 0 })?.cursor).toEqual({ line: 0, column: 9 });
    expect(nextCell(table, { line: 9, column: 0 })?.cursor).toEqual({ line: 2, column: 10 });
  });

  it("ignores text that is not a table", () => {
    expect(nextCell(["a", "b"], { line: 0, column: 0 })).toBeNull();
  });
});

describe("previousCell", () => {
  const table = ["| a | b |", "|---|---|", "|  c |   |", "|x|y|"];

  it("moves to the previous cell in the row", () => {
    expect(previousCell(table, { line: 0, column: 6 })).toEqual({ line: 0, column: 2 });
    expect(previousCell(table, { line: 3, column: 3 })).toEqual({ line: 3, column: 1 });
  });

  it("moves to the end of the previous row, skipping the delimiter", () => {
    expect(previousCell(table, { line: 3, column: 1 })).toEqual({ line: 2, column: 7 });
    expect(previousCell(table, { line: 2, column: 1 })).toEqual({ line: 0, column: 6 });
    expect(previousCell(table, { line: 1, column: 5 })).toEqual({ line: 0, column: 6 });
  });

  it("enters a cell at its content, or past one space when it is empty", () => {
    expect(previousCell(table, { line: 2, column: 9 })).toEqual({ line: 2, column: 3 });
    expect(previousCell(["|a|b|", "|-|-|", "||x|"], { line: 2, column: 2 })).toEqual({
      line: 2,
      column: 1,
    });
  });

  it("stops in the first header cell", () => {
    expect(previousCell(table, { line: 0, column: 2 })).toBeNull();
    expect(previousCell(table, { line: 0, column: 0 })).toBeNull();
  });

  it("does not change the text and ignores text that is not a table", () => {
    expect(previousCell(["a"], { line: 0, column: 0 })).toBeNull();
  });
});
