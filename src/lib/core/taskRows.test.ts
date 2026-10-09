import { describe, expect, it } from "vitest";
import { parseTaskDocument } from "./taskDocument";
import { allTaskRows, taskRows, type RowOptions, type TaskRow } from "./taskRows";

const doc = (lines: string[]) => parseTaskDocument(lines.join("\n"));
const notes = new Set(["p/plan.md", "other/x.md"]);
const shown: RowOptions = { hideDone: false, exists: (path) => notes.has(path) };
const hidden: RowOptions = { ...shown, hideDone: true };
const describeRow = (row: TaskRow) =>
  row.kind === "task" ? `${row.nested ? "  " : ""}${row.done ? "x " : ""}${row.display}` : row.kind;

describe("taskRows", () => {
  const model = doc([
    "- [x] early done",
    "- [ ] loose",
    "# Empty",
    "- [x] only done here",
    "## Work",
    "- [ ] a [note](plan.md)",
    "  some detail",
    "  - [x] a1",
    "  - [ ] a2",
    "- [x] b",
    "  - [ ] b1",
  ]);

  it("shows every task in file order, done ones in place, under their headings", () => {
    const rows = taskRows("p/tasks.md", model, shown);
    expect(rows.map(describeRow)).toEqual([
      "x early done",
      "loose",
      "heading",
      "x only done here",
      "heading",
      "a",
      "  x a1",
      "  a2",
      "x b",
      "  b1",
    ]);
    expect(rows[2]).toEqual({ kind: "heading", key: "p/tasks.md#2", title: "Empty", level: 1 });
  });

  it("describes detail, subtask progress and the linked note", () => {
    const a = taskRows("p/tasks.md", model, shown).find(
      (row) => row.kind === "task" && row.line === 5,
    );
    expect(a).toMatchObject({
      key: "p/tasks.md:5",
      raw: "- [ ] a [note](plan.md)",
      text: "a [note](plan.md)",
      display: "a",
      detail: "some detail",
      progress: { done: 1, total: 2 },
      link: { path: "p/plan.md", exists: true, label: "note" },
    });
    const sub = taskRows("p/tasks.md", model, shown).find(
      (row) => row.kind === "task" && row.line === 7,
    );
    expect(sub).toMatchObject({ nested: true, detail: null, progress: null, link: null });
  });

  it("hides done tasks, done subtasks and headings left empty", () => {
    expect(taskRows("p/tasks.md", model, hidden).map(describeRow)).toEqual([
      "loose",
      "heading",
      "a",
      "  a2",
    ]);
  });

  it("is empty for a list without tasks", () => {
    expect(taskRows("p/tasks.md", doc(["# Only a heading"]), shown)).toEqual([]);
  });
});

describe("allTaskRows", () => {
  it("groups each list under a header with its open count", () => {
    const groups = [
      { project: "inbox", path: "inbox/tasks.md", doc: doc(["- [ ] a", "  - [ ] a1", "- [x] b"]) },
      { project: "empty", path: "empty/tasks.md", doc: doc(["- [x] done"]) },
      { project: "none", path: "none/tasks.md", doc: doc(["text"]) },
      { project: "api", path: "api/tasks.md", doc: doc(["# H", "- [ ] c", "- [ ] d"]) },
    ];
    const rows = allTaskRows(groups, shown);
    expect(rows.map((row) => [row.kind, row.key])).toEqual([
      ["project", "inbox/tasks.md#project"],
      ["task", "inbox/tasks.md:0"],
      ["task", "inbox/tasks.md:1"],
      ["task", "inbox/tasks.md:2"],
      ["project", "empty/tasks.md#project"],
      ["task", "empty/tasks.md:0"],
      ["project", "api/tasks.md#project"],
      ["task", "api/tasks.md:1"],
      ["task", "api/tasks.md:2"],
    ]);
    expect(rows[0]).toMatchObject({ project: "inbox", count: 1 });
    expect(rows[4]).toMatchObject({ project: "empty", count: 0 });
    expect(allTaskRows(groups, hidden).map((row) => row.key)).toEqual([
      "inbox/tasks.md#project",
      "inbox/tasks.md:0",
      "inbox/tasks.md:1",
      "api/tasks.md#project",
      "api/tasks.md:1",
      "api/tasks.md:2",
    ]);
  });
});
