import { describe, expect, it } from "vitest";
import {
  blockOf,
  cleanTaskText,
  deleteTask as deleteAt,
  editTaskText as editAt,
  insertTask as insertAt,
  joinLines,
  lineSeparator,
  locateTask,
  moveTask as moveAt,
  openTaskCount,
  parseTaskDocument,
  refAt,
  restoreLines,
  setTaskDetail,
  taskDetail,
  splitLines,
  taskAt,
  toggleTask as toggleAt,
  type InsertPosition,
  type RemovedLines,
  type TaskDocument,
} from "./taskDocument";

const doc = (lines: string[] | string, separator = "\n"): TaskDocument =>
  parseTaskDocument(typeof lines === "string" ? lines : lines.join(separator));

// Most cases address tasks by the line they are on, in the text they were parsed from.
const toggleTask = (model: TaskDocument, line: number) => toggleAt(model, refAt(model, line));
const editTaskText = (model: TaskDocument, line: number, input: string) =>
  editAt(model, refAt(model, line), input);
const deleteTask = (model: TaskDocument, line: number) => deleteAt(model, refAt(model, line));
const moveTask = (model: TaskDocument, line: number, direction: -1 | 1) =>
  moveAt(model, refAt(model, line), direction);
const insertTask = (
  model: TaskDocument,
  input: string,
  position: { after: number } | Exclude<InsertPosition, { after: unknown }>,
) =>
  insertAt(
    model,
    input,
    typeof position === "object" && "after" in position
      ? { after: refAt(model, position.after) }
      : position,
  );
const removedAt = (index: number, lines: RemovedLines["lines"]): RemovedLines => ({
  index,
  lines,
  textAfter: "",
  previous: null,
  next: null,
});

describe("splitLines and joinLines", () => {
  it("keeps each line's own break, so joining gives the text back", () => {
    for (const text of ["", "a", "a\n", "a\r\nb\r\n", "a\rb", "a\n\r\nb\rc", "\n\n", "x\r"]) {
      expect(joinLines(splitLines(text))).toBe(text);
    }
    expect(splitLines("a\r\nb")).toEqual([
      { text: "a", eol: "\r\n" },
      { text: "b", eol: "" },
    ]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\n")).toEqual([{ text: "a", eol: "\n" }]);
  });

  it("detects the separator from the first line break", () => {
    expect(lineSeparator("a\r\nb\nc")).toBe("\r\n");
    expect(lineSeparator("a\rb")).toBe("\r");
    expect(lineSeparator("a\nb\r\n")).toBe("\n");
    expect(lineSeparator("no breaks")).toBe("\n");
  });
});

describe("parseTaskDocument", () => {
  it("parses top-level tasks with any bullet and state", () => {
    const model = doc(["- [ ] a", "* [x] b", "+ [X] c", "- [ ]", "-  [ ] not a task", "-[ ] no"]);
    expect(model.blocks.map(({ line, done, text }) => ({ line, done, text }))).toEqual([
      { line: 0, done: false, text: "a" },
      { line: 1, done: true, text: "b" },
      { line: 2, done: true, text: "c" },
      { line: 3, done: false, text: "" },
    ]);
    expect(openTaskCount(model)).toBe(2);
  });

  it("requires whitespace or the end after the checkbox", () => {
    expect(doc("- [ ]x").blocks).toEqual([]);
    expect(doc("- [ ]\tx").blocks[0]?.text).toBe("x");
  });

  it("groups indented lines into the block, with nested tasks at any depth", () => {
    const model = doc([
      "- [ ] parent",
      "  - [x] child",
      "    more text",
      "      - [ ] grandchild",
      "\t- [ ] tabbed",
      "   ",
      "  continued after a whitespace-only line",
      "- [ ] next",
      "",
      "  - [ ] after a blank line",
      "",
      "",
      "- [ ] last",
      "",
      "not indented",
    ]);
    expect(model.blocks).toHaveLength(3);
    expect(model.blocks[0]).toMatchObject({ line: 0, end: 7 });
    expect(model.blocks[0]?.subtasks).toEqual([
      { line: 1, done: true, text: "child", raw: "  - [x] child" },
      { line: 3, done: false, text: "grandchild", raw: "      - [ ] grandchild" },
      { line: 4, done: false, text: "tabbed", raw: "\t- [ ] tabbed" },
    ]);
    // A loose item: indented lines after a blank line stay in the block; trailing blanks do not.
    expect(model.blocks[1]).toMatchObject({ line: 7, end: 10 });
    expect(model.blocks[1]?.subtasks.map((task) => task.text)).toEqual(["after a blank line"]);
    expect(model.blocks[2]).toMatchObject({ line: 12, end: 13 });
  });

  it("moves loose blocks with all their lines", () => {
    expect(moveTask(doc("- [ ] a\n  note\n\n  more of a\n- [ ] b\n"), 4, -1)?.text).toBe(
      "- [ ] b\n- [ ] a\n  note\n\n  more of a\n",
    );
  });

  it("treats underlined paragraphs as headings, and other rules as breaks", () => {
    const model = doc([
      "- [ ] a",
      "",
      "Title",
      "spanning two lines",
      "=====",
      "- [ ] b",
      "",
      "Sub",
      "---",
      "- [ ] c",
      "",
      "---",
      "- [ ] d",
      "* item",
      "---",
      "- [ ] e",
      "    code",
      "---",
      "- [ ] f",
    ]);
    expect(model.sections).toEqual([
      { line: 2, level: 1, title: "Title spanning two lines" },
      { line: 7, level: 2, title: "Sub" },
    ]);
    expect(model.blocks.map((block) => [block.text, block.section])).toEqual([
      ["a", -1],
      ["b", 0],
      ["c", 1],
      ["d", 1],
      ["e", 1],
      ["f", 1],
    ]);
    // Moves never cross a setext heading.
    expect(moveTask(model, 5, -1)).toBeNull();
    expect(moveTask(model, 9, -1)).toBeNull();
    expect(moveTask(model, 12, -1)?.text).toContain("- [ ] d\n\n---\n- [ ] c");
  });

  it("does not underline a line that lazily continues a task", () => {
    expect(doc("- [ ] a\ncontinued\n---\n- [ ] b").sections).toEqual([]);
    expect(doc("- [ ] a\n\nTitle\n---\n- [ ] b").sections).toEqual([
      { line: 2, level: 2, title: "Title" },
    ]);
  });

  it("ends a fence opened inside a block with the block", () => {
    const model = doc("- [ ] a\n  ```\n  - [ ] code\nafter\n- [ ] b\n");
    expect(model.blocks.map((block) => block.text)).toEqual(["a", "b"]);
    expect(model.blocks[0]?.subtasks).toEqual([]);
    expect(model.openFence).toBeNull();
    expect(doc("- [ ] a\n  ```\n  x\n  ```\n  - [ ] sub\n").blocks[0]?.subtasks).toHaveLength(1);
  });

  it("adds before a fence that is never closed, so the task is visible", () => {
    const model = doc("- [ ] a\n```\n- [ ] code\n");
    expect(model.openFence).toBe(1);
    const edit = insertTask(model, "new", "end");
    expect(edit).toEqual({ text: "- [ ] a\n- [ ] new\n```\n- [ ] code\n", focus: 1 });
    expect(doc(edit?.text ?? "").blocks.map((block) => block.text)).toEqual(["a", "new"]);
    expect(insertTask(doc("```\nx"), "t", { section: -1 })?.text).toBe("- [ ] t\n```\nx");
    expect(doc("```\nx\n```\n").openFence).toBeNull();
  });

  it("finds a task again by its text after lines moved", () => {
    const before = doc("- [ ] one\n- [ ] two\n");
    const ref = refAt(before, 1);
    const after = doc("- [ ] zero\n- [ ] one\n- [ ] two\n");
    expect(locateTask(after, ref)).toBe(2);
    expect(toggleAt(after, ref)?.text).toBe("- [ ] zero\n- [ ] one\n- [x] two\n");
    expect(editAt(after, ref, "2")?.text).toBe("- [ ] zero\n- [ ] one\n- [ ] 2\n");
    expect(deleteAt(after, ref)?.text).toBe("- [ ] zero\n- [ ] one\n");
    expect(moveAt(after, ref, -1)?.text).toBe("- [ ] zero\n- [ ] two\n- [ ] one\n");
    expect(insertAt(after, "x", { after: ref })?.text).toBe(
      "- [ ] zero\n- [ ] one\n- [ ] two\n- [ ] x\n",
    );
  });

  it("refuses a task that is gone, changed or no longer unique", () => {
    const ref = refAt(doc("- [ ] one\n- [ ] two\n"), 1);
    const gone = doc("- [ ] one\n");
    const changed = doc("- [x] two\n- [ ] one\n");
    const twice = doc("- [ ] zero\n- [ ] one\n- [ ] x\n- [ ] two\n- [ ] two\n");
    for (const model of [gone, changed, twice]) {
      expect(locateTask(model, ref)).toBeNull();
      expect(toggleAt(model, ref)).toBeNull();
      expect(editAt(model, ref, "x")).toBeNull();
      expect(deleteAt(model, ref)).toBeNull();
      expect(moveAt(model, ref, 1)).toBeNull();
      expect(insertAt(model, "x", { after: ref })).toBeNull();
    }
    // A line that is not a task is never matched by its text.
    expect(locateTask(doc("text"), { line: 0, raw: "text" })).toBeNull();
  });

  it("does not take indented tasks without a parent", () => {
    expect(doc("text\n  - [ ] orphan").blocks).toEqual([]);
  });

  it("records headings as sections and the section of each block", () => {
    const model = doc([
      "- [ ] loose",
      "# Today ##",
      "- [ ] a",
      "## Later",
      "text",
      "- [x] b",
      "#notaheading",
      "   ### Deep",
      "#",
    ]);
    expect(model.sections).toEqual([
      { line: 1, level: 1, title: "Today" },
      { line: 3, level: 2, title: "Later" },
      { line: 7, level: 3, title: "Deep" },
      { line: 8, level: 1, title: "" },
    ]);
    expect(model.blocks.map((block) => block.section)).toEqual([-1, 0, 1]);
  });

  it("ignores tasks and headings in front matter and fenced code", () => {
    const model = doc([
      "---",
      "- [ ] meta",
      "---",
      "```md",
      "- [ ] code",
      "# not a heading",
      "````",
      "~~~",
      "- [ ] tilde code",
      "~~~",
      "- [ ] real",
    ]);
    expect(model.blocks.map((block) => block.text)).toEqual(["real"]);
    expect(model.sections).toEqual([]);
  });

  it("treats unclosed front matter as text", () => {
    expect(doc("---\n- [ ] a").blocks.map((block) => block.text)).toEqual(["a"]);
    expect(doc("---\ntitle: x\n...\n- [ ] b").blocks.map((block) => block.line)).toEqual([3]);
  });

  it("keeps fenced code inside a block in the block, without tasks", () => {
    const model = doc(["- [ ] a", "  ```", "  - [ ] code", "  ```", "  - [ ] real child"]);
    expect(model.blocks[0]).toMatchObject({ end: 5 });
    expect(model.blocks[0]?.subtasks.map((task) => task.text)).toEqual(["real child"]);
  });

  it("handles CRLF, CR, empty files and files with only text", () => {
    const crlf = doc("- [ ] a\r\n  - [ ] b\r\n- [x] c\r\n");
    expect(crlf.separator).toBe("\r\n");
    expect(crlf.blocks.map((block) => [block.line, block.end, block.text])).toEqual([
      [0, 2, "a"],
      [2, 3, "c"],
    ]);
    expect(doc("- [ ] a\r- [ ] b").blocks).toHaveLength(2);
    expect(doc("")).toMatchObject({ lines: [], blocks: [], sections: [], separator: "\n" });
    expect(doc("Just some notes.\nNo tasks.").blocks).toEqual([]);
  });

  it("finds tasks and blocks by line", () => {
    const model = doc(["- [ ] a", "  - [ ] b", "text", "- [ ] c"]);
    expect(blockOf(model, 1)?.line).toBe(0);
    expect(blockOf(model, 2)).toBeNull();
    expect(taskAt(model, 1)?.text).toBe("b");
    expect(taskAt(model, 3)?.text).toBe("c");
    expect(taskAt(model, 2)).toBeNull();
  });

  it("parses long lines in linear time", () => {
    const line = `- [ ] a${" ".repeat(100_000)}b`;
    const started = Date.now();
    expect(doc(line).blocks[0]?.text).toMatch(/^a +b$/);
    expect(editTaskText(doc(line), 0, "c")?.text).toBe("- [ ] c");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("toggleTask", () => {
  it("flips only the state character", () => {
    const model = doc(["# Head", "* [ ]  spaced  ", "+ [X] upper", "- [x] lower", ""]);
    expect(toggleTask(model, 1)).toEqual({
      text: "# Head\n* [x]  spaced  \n+ [X] upper\n- [x] lower\n",
      focus: 1,
    });
    expect(toggleTask(model, 2)?.text).toBe("# Head\n* [ ]  spaced  \n+ [ ] upper\n- [x] lower\n");
    expect(toggleTask(model, 3)?.text).toBe("# Head\n* [ ]  spaced  \n+ [X] upper\n- [ ] lower\n");
  });

  it("toggles nested tasks and keeps CRLF and a missing final break", () => {
    const model = doc("- [ ] a\r\n\t  - [ ] b\r\n- [ ] c");
    expect(toggleTask(model, 1)?.text).toBe("- [ ] a\r\n\t  - [x] b\r\n- [ ] c");
    expect(toggleTask(model, 2)?.text).toBe("- [ ] a\r\n\t  - [ ] b\r\n- [x] c");
  });

  it("refuses lines that are not shown tasks", () => {
    const model = doc(["text", "```", "- [ ] code", "```"]);
    expect(toggleTask(model, 0)).toBeNull();
    expect(toggleTask(model, 2)).toBeNull();
    expect(toggleTask(model, 9)).toBeNull();
  });
});

describe("editTaskText", () => {
  it("replaces only the text, keeping bullet, state, spacing and trailing whitespace", () => {
    const model = doc(["* [X]\t\told text  ", "  + [ ]   nested", "- [ ]", "- [ ]   "]);
    expect(editTaskText(model, 0, "  new\ntext ")).toEqual({
      text: "* [X]\t\tnew text  \n  + [ ]   nested\n- [ ]\n- [ ]   ",
      focus: 0,
    });
    expect(editTaskText(model, 1, "renamed")?.text).toContain("  + [ ]   renamed\n");
    expect(editTaskText(model, 2, "filled")?.text).toContain("- [ ] filled\n");
    expect(editTaskText(model, 3, "x")?.text.endsWith("- [ ]   x")).toBe(true);
  });

  it("is no edit for empty or unchanged text or a line that is not a task", () => {
    const model = doc(["- [ ] same", "text"]);
    expect(editTaskText(model, 0, "   ")).toBeNull();
    expect(editTaskText(model, 0, " same ")).toBeNull();
    expect(editTaskText(model, 1, "x")).toBeNull();
  });

  it("keeps CRLF", () => {
    expect(editTaskText(doc("- [ ] a\r\n- [ ] b\r\n"), 1, "c")?.text).toBe(
      "- [ ] a\r\n- [ ] c\r\n",
    );
  });
});

describe("cleanTaskText", () => {
  it("collapses line breaks and trims", () => {
    expect(cleanTaskText(" a\r\n\nb\u2028c ")).toBe("a b c");
  });
});

describe("insertTask", () => {
  it("inserts after the whole block of a task, with the file's separator", () => {
    const model = doc("- [ ] a\r\n  - [ ] sub\r\n  note\r\n- [ ] b\r\n");
    expect(insertTask(model, "new", { after: 0 })).toEqual({
      text: "- [ ] a\r\n  - [ ] sub\r\n  note\r\n- [ ] new\r\n- [ ] b\r\n",
      focus: 3,
    });
    // From a subtask, the new task still goes after the block.
    expect(insertTask(model, "new", { after: 1 })?.focus).toBe(3);
  });

  it("appends at the end, adding a break to a last line without one", () => {
    expect(insertTask(doc("- [ ] a"), "b", { after: 0 })).toEqual({
      text: "- [ ] a\n- [ ] b",
      focus: 1,
    });
    expect(insertTask(doc("intro\n"), "b", "end")?.text).toBe("intro\n- [ ] b\n");
    expect(insertTask(doc("intro\r\n\r\n"), "b", "end")?.text).toBe("intro\r\n\r\n- [ ] b\r\n");
    expect(insertTask(doc("intro"), "b", "end")?.text).toBe("intro\n- [ ] b");
    expect(insertTask(doc(""), "first", "end")).toEqual({ text: "- [ ] first\n", focus: 0 });
  });

  it("inserts at the end of a section, before the blank lines above the next heading", () => {
    const model = doc(["# A", "- [ ] a", "text", "", "# B", "", "# C"]);
    expect(insertTask(model, "x", { section: 0 })?.text).toBe(
      "# A\n- [ ] a\ntext\n- [ ] x\n\n# B\n\n# C",
    );
    expect(insertTask(model, "x", { section: 1 })?.text).toBe(
      "# A\n- [ ] a\ntext\n\n# B\n- [ ] x\n\n# C",
    );
    expect(insertTask(model, "x", { section: 2 })?.text).toBe(
      "# A\n- [ ] a\ntext\n\n# B\n\n# C\n- [ ] x",
    );
    expect(insertTask(doc("intro\n\n# A\n"), "x", { section: -1 })?.text).toBe(
      "intro\n- [ ] x\n\n# A\n",
    );
    expect(insertTask(doc("intro\n"), "x", { section: -1 })?.text).toBe("intro\n- [ ] x\n");
  });

  it("collapses line breaks and refuses empty text and unknown positions", () => {
    expect(insertTask(doc(""), "a\nb", "end")?.text).toBe("- [ ] a b\n");
    expect(insertTask(doc(""), " \n ", "end")).toBeNull();
    expect(insertTask(doc("text"), "a", { after: 0 })).toBeNull();
    expect(insertTask(doc("# A"), "a", { section: 1 })).toBeNull();
    expect(insertTask(doc("# A"), "a", { section: -2 })).toBeNull();
  });
});

describe("deleteTask and restoreLines", () => {
  const roundTrip = (text: string, line: number, expected: string) => {
    const model = doc(text);
    const deletion = deleteTask(model, line);
    expect(deletion?.text).toBe(expected);
    if (!deletion) return;
    expect(restoreLines(doc(deletion.text), deletion.removed)?.text).toBe(text);
  };

  it("removes the whole block and restores it exactly", () => {
    roundTrip("- [ ] a\n  - [ ] sub\n  more\n- [ ] b\n", 0, "- [ ] b\n");
    roundTrip("# H\r\n- [ ] a\r\n- [x] b\r\ntext\r\n", 2, "# H\r\n- [ ] a\r\ntext\r\n");
    roundTrip("intro\n- [ ] a", 1, "intro\n");
    roundTrip("- [ ] only", 0, "");
    roundTrip("- [ ] a\n- [ ] b", 1, "- [ ] a\n");
  });

  it("removes a subtask with the lines indented deeper below it", () => {
    roundTrip(
      "- [ ] a\n  - [ ] sub\n    detail\n   \n    - [ ] deeper\n  - [ ] sibling\n",
      1,
      "- [ ] a\n  - [ ] sibling\n",
    );
  });

  it("focuses the task that takes the place, else the one before", () => {
    expect(deleteTask(doc("- [ ] a\n- [ ] b\n- [ ] c"), 1)?.focus).toBe(1);
    expect(deleteTask(doc("- [ ] a\n  - [ ] s\n- [ ] c"), 1)?.focus).toBe(1);
    expect(deleteTask(doc("- [ ] a\n  - [ ] s\n- [ ] c"), 2)?.focus).toBe(1);
    expect(deleteTask(doc("- [ ] a"), 0)?.focus).toBeNull();
    expect(deleteTask(doc("- [ ] a\n- [ ] b"), 1)?.removed).toEqual({
      index: 1,
      lines: [{ text: "- [ ] b", eol: "" }],
      textAfter: "- [ ] a\n",
      previous: "- [ ] a",
      next: null,
    });
  });

  it("refuses lines that are not tasks", () => {
    expect(deleteTask(doc("text"), 0)).toBeNull();
  });

  it("restores at the old index when no neighbour is found, keeping lines apart", () => {
    const removed = { ...removedAt(5, [{ text: "- [ ] back", eol: "" }]), previous: "gone" };
    expect(restoreLines(doc("- [ ] a"), removed)).toEqual({
      text: "- [ ] a\n- [ ] back",
      focus: 1,
    });
    const first = removedAt(0, [{ text: "- [ ] back", eol: "" }]);
    expect(restoreLines(doc("- [ ] a\r\n"), first)?.text).toBe("- [ ] back\r\n- [ ] a\r\n");
    expect(restoreLines(doc("x"), removedAt(0, []))).toBeNull();
  });

  it("re-anchors after the line that preceded the deleted block when the text changed", () => {
    const original = doc("- [ ] a\n- [ ] b\n  - [ ] b1\n- [ ] c\n");
    const deletion = deleteTask(original, 3);
    if (!deletion) throw new Error("not deleted");
    // A task added after a: the old index would now be inside b's block.
    const added = insertTask(doc(deletion.text), "new", { after: 0 });
    expect(restoreLines(doc(added?.text ?? ""), deletion.removed)?.text).toBe(
      "- [ ] a\n- [ ] new\n- [ ] b\n  - [ ] b1\n- [ ] c\n",
    );
    // Moved: c follows its old neighbour wherever that went.
    const moved = moveTask(doc(deletion.text), 1, -1);
    expect(restoreLines(doc(moved?.text ?? ""), deletion.removed)?.text).toBe(
      "- [ ] b\n  - [ ] b1\n- [ ] c\n- [ ] a\n",
    );
  });

  it("falls back to the line that followed, and never lands inside a block", () => {
    const original = doc("- [ ] a\n- [ ] b\n- [ ] c\n");
    const deletion = deleteTask(original, 1);
    if (!deletion) throw new Error("not deleted");
    // The previous line is gone; c is still there.
    const external = doc("- [ ] zero\n- [ ] c\n- [ ] a2\n");
    expect(restoreLines(external, deletion.removed)?.text).toBe(
      "- [ ] zero\n- [ ] b\n- [ ] c\n- [ ] a2\n",
    );
    // Neither neighbour is unique: the old index, moved past the block it falls in.
    const crowded = doc("- [ ] p\n  - [ ] x\n- [ ] q\n");
    expect(restoreLines(crowded, deletion.removed)?.text).toBe(
      "- [ ] p\n  - [ ] x\n- [ ] b\n- [ ] q\n",
    );
    // A block that was first goes back to the top.
    const head = deleteTask(original, 0);
    expect(head && restoreLines(doc("- [ ] x\n"), head.removed)?.text).toBe("- [ ] a\n- [ ] x\n");
  });

  it("puts a deleted subtask back under its old neighbour", () => {
    const original = doc("- [ ] a\n  - [ ] a1\n  - [ ] a2\n- [ ] b\n");
    const deletion = deleteTask(original, 2);
    if (!deletion) throw new Error("not deleted");
    const changed = doc("- [ ] zero\n- [ ] a\n  - [ ] a1\n- [ ] b\n");
    expect(restoreLines(changed, deletion.removed)?.text).toBe(
      "- [ ] zero\n- [ ] a\n  - [ ] a1\n  - [ ] a2\n- [ ] b\n",
    );
  });
});

describe("moveTask", () => {
  it("swaps with the previous or next open block, skipping done blocks and text", () => {
    const text = ["- [ ] a", "  - [ ] a1", "- [x] done", "text", "- [ ] b", ""].join("\n");
    const model = doc(text);
    expect(moveTask(model, 4, -1)).toEqual({
      text: ["- [ ] b", "- [x] done", "text", "- [ ] a", "  - [ ] a1", ""].join("\n"),
      focus: 0,
    });
    expect(moveTask(model, 0, 1)).toEqual({
      text: ["- [ ] b", "- [x] done", "text", "- [ ] a", "  - [ ] a1", ""].join("\n"),
      focus: 3,
    });
  });

  it("stays within its section and at the ends", () => {
    const model = doc(["- [ ] a", "# H", "- [ ] b", "- [ ] c", "## I", "- [ ] d"]);
    expect(moveTask(model, 2, -1)).toBeNull();
    expect(moveTask(model, 3, 1)).toBeNull();
    expect(moveTask(model, 0, -1)).toBeNull();
    expect(moveTask(model, 5, 1)).toBeNull();
    expect(moveTask(model, 3, -1)?.text).toBe("- [ ] a\n# H\n- [ ] c\n- [ ] b\n## I\n- [ ] d");
  });

  it("never moves done tasks or subtasks", () => {
    const model = doc(["- [ ] a", "- [x] b", "  - [ ] sub", "- [ ] c"]);
    expect(moveTask(model, 1, -1)).toBeNull();
    expect(moveTask(model, 2, -1)).toBeNull();
    expect(moveTask(doc("- [ ] a\n- [x] b"), 0, 1)).toBeNull();
  });

  it("keeps the file's final line break or its absence", () => {
    expect(moveTask(doc("- [ ] a\r\n- [ ] b"), 1, -1)?.text).toBe("- [ ] b\r\n- [ ] a");
    expect(moveTask(doc("- [ ] a\n- [ ] b\n"), 0, 1)?.text).toBe("- [ ] b\n- [ ] a\n");
  });
});

describe("taskDetail and setTaskDetail", () => {
  const detailOf = (model: TaskDocument, index = 0) => {
    const block = model.blocks[index];
    return block ? taskDetail(model, block) : null;
  };

  it("reads the non-task indented lines of a block, without their indentation", () => {
    const model = doc([
      "- [ ] a",
      "    first line",
      "      deeper",
      "  - [ ] sub",
      "    under the sub",
      "",
      "  after a blank",
      "- [ ] b",
    ]);
    // "under the sub" belongs to the subtask; the rest keeps its relative indentation.
    expect(detailOf(model)).toBe("  first line\n    deeper\n\nafter a blank");
    expect(detailOf(model, 1)).toBe("");
  });

  it("writes detail right after the task line, keeping subtasks and their lines in order", () => {
    const model = doc("- [ ] a\n  - [ ] s1\n    s1 note\n  old\n  - [x] s2\n- [ ] b\n");
    expect(setTaskDetail(model, refAt(model, 0), "new\n\n  indented \n")).toEqual({
      text: "- [ ] a\n  new\n\n    indented \n  - [ ] s1\n    s1 note\n  - [x] s2\n- [ ] b\n",
      focus: 0,
    });
    // Removing the detail keeps the subtasks.
    expect(setTaskDetail(model, refAt(model, 0), " \n")?.text).toBe(
      "- [ ] a\n  - [ ] s1\n    s1 note\n  - [x] s2\n- [ ] b\n",
    );
  });

  it("keeps the block's indentation, defaults to two spaces and keeps line endings", () => {
    const tabbed = doc("- [ ] a\r\n\tnote\r\n- [ ] b");
    expect(setTaskDetail(tabbed, refAt(tabbed, 0), "x\ny")?.text).toBe(
      "- [ ] a\r\n\tx\r\n\ty\r\n- [ ] b",
    );
    const bare = doc("- [ ] a");
    expect(setTaskDetail(bare, refAt(bare, 0), "x")?.text).toBe("- [ ] a\n  x");
    const withSub = doc("- [ ] a\n    - [ ] s\n");
    expect(setTaskDetail(withSub, refAt(withSub, 0), "x")?.text).toBe(
      "- [ ] a\n    x\n    - [ ] s\n",
    );
  });

  it("leaves other blocks untouched and refuses no-ops, subtasks and missing tasks", () => {
    const model = doc("- [ ] a\n  note\n* [x] b\n   odd  indent\n");
    expect(setTaskDetail(model, refAt(model, 0), "changed")?.text).toBe(
      "- [ ] a\n  changed\n* [x] b\n   odd  indent\n",
    );
    expect(setTaskDetail(model, refAt(model, 0), "\nnote\n")).toBeNull();
    const nested = doc("- [ ] a\n  - [ ] s\n");
    expect(setTaskDetail(nested, refAt(nested, 1), "x")).toBeNull();
    expect(setTaskDetail(model, { line: 0, raw: "- [ ] gone" }, "x")).toBeNull();
  });
});

describe("insertTask as a subtask", () => {
  it("appends to the end of the block with its subtask indentation", () => {
    const model = doc("- [ ] a\n    - [ ] s\n  note? no\n- [ ] b\n");
    expect(insertAt(model, "new", { after: refAt(model, 0), nested: true })).toEqual({
      text: "- [ ] a\n    - [ ] s\n  note? no\n    - [ ] new\n- [ ] b\n",
      focus: 3,
    });
    const bare = doc("- [ ] a");
    expect(insertAt(bare, "new", { after: refAt(bare, 0), nested: true })?.text).toBe(
      "- [ ] a\n  - [ ] new",
    );
    // From a subtask, the new one goes at the end of the same block.
    const sub = doc("- [ ] a\n  - [ ] s\n");
    const edit = insertAt(sub, "t", { after: refAt(sub, 1), nested: true });
    expect(edit?.text).toBe("- [ ] a\n  - [ ] s\n  - [ ] t\n");
    expect(doc(edit?.text ?? "").blocks[0]?.subtasks.map((task) => task.text)).toEqual(["s", "t"]);
  });
});

describe("detail edits keep bytes", () => {
  it("keeps unchanged lines exactly, hard breaks and tabs included", () => {
    const model = doc("- [ ] a\n  line one  \n  \ttabbed\n   \n  two\n");
    const block = model.blocks[0];
    const current = block ? taskDetail(model, block) : "";
    expect(current).toBe("line one  \n\ttabbed\n\ntwo");
    expect(setTaskDetail(model, refAt(model, 0), current)).toBeNull();
    // Only the changed line is rewritten; the others keep their bytes.
    expect(setTaskDetail(model, refAt(model, 0), "line one  \n\ttabbed\n\ntwo x")?.text).toBe(
      "- [ ] a\n  line one  \n  \ttabbed\n   \n  two x\n",
    );
    // A typed hard break is kept too.
    expect(setTaskDetail(model, refAt(model, 0), "new  ")?.text).toBe("- [ ] a\n  new  \n");
  });

  it("indents new lines with the prefix of the least indented line", () => {
    const model = doc("- [ ] a\n      deep\n\t\tshallow\n");
    expect(setTaskDetail(model, refAt(model, 0), "    deep\nshallow\nadded")?.text).toBe(
      "- [ ] a\n      deep\n\t\tshallow\n\t\tadded\n",
    );
  });

  it("closes a code block left open, so the subtasks after it stay tasks", () => {
    const model = doc("- [ ] a\n  - [ ] s\n");
    const edit = setTaskDetail(model, refAt(model, 0), "~~~~ sh\ncode");
    expect(edit?.text).toBe("- [ ] a\n  ~~~~ sh\n  code\n  ~~~~\n  - [ ] s\n");
    expect(doc(edit?.text ?? "").blocks[0]?.subtasks.map((task) => task.text)).toEqual(["s"]);
  });

  it("adds a subtask before a code block left open in the block", () => {
    const model = doc("- [ ] a\n  ```\n  code\n");
    const edit = insertAt(model, "n", { after: refAt(model, 0), nested: true });
    expect(edit?.text).toBe("- [ ] a\n  - [ ] n\n  ```\n  code\n");
    expect(doc(edit?.text ?? "").blocks[0]?.subtasks.map((task) => task.text)).toEqual(["n"]);
    const closed = doc("- [ ] a\n  ```\n  code\n  ```\n");
    expect(insertAt(closed, "n", { after: refAt(closed, 0), nested: true })?.text).toBe(
      "- [ ] a\n  ```\n  code\n  ```\n  - [ ] n\n",
    );
  });
});
