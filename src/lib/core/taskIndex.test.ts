import { describe, expect, it } from "vitest";
import { NO_TASK_DOCS, TaskIndex, taskGroups } from "./taskIndex";
import { buildWorkspace } from "./workspace";

describe("TaskIndex", () => {
  it("parses each text once and keeps the hash of its disk version", () => {
    const index = new TaskIndex();
    const doc = index.set("a/tasks.md", "- [ ] a", "h1");
    expect(index.get("a/tasks.md")).toEqual({ doc, hash: "h1" });
    // Same text: the same model, with the new hash.
    expect(index.set("a/tasks.md", "- [ ] a", null)).toBe(doc);
    expect(index.get("a/tasks.md")?.hash).toBeNull();
    expect(index.set("a/tasks.md", "- [x] a", "h2")).not.toBe(doc);
    expect(index.size).toBe(1);
  });

  it("publishes snapshots and forgets paths", () => {
    const index = new TaskIndex();
    index.set("a/tasks.md", "- [ ] a", "h");
    index.set("b/tasks.md", "- [ ] b", "h");
    const view = index.view();
    expect([...view.keys()]).toEqual(["a/tasks.md", "b/tasks.md"]);
    expect(index.retain((path) => path !== "a/tasks.md")).toBe(true);
    expect(index.retain(() => true)).toBe(false);
    // Earlier snapshots do not change.
    expect(view.has("a/tasks.md")).toBe(true);
    expect(index.delete("b/tasks.md")).toBe(true);
    index.set("c/tasks.md", "", "h");
    index.clear();
    expect(index.view().size).toBe(0);
    expect(NO_TASK_DOCS.size).toBe(0);
  });
});

describe("taskGroups", () => {
  it("lists read task lists, inbox first, then projects in order, without archived ones", () => {
    const workspace = buildWorkspace(
      [
        { path: "zeta/tasks.md", size: 1, modified: 0 },
        { path: "alpha/tasks.md", size: 1, modified: 0 },
        { path: "inbox/tasks.md", size: 1, modified: 0 },
        { path: "notes-only/a.md", size: 1, modified: 0 },
        { path: "unread/tasks.md", size: 1, modified: 0 },
        { path: "_archive/old/tasks.md", size: 1, modified: 0 },
      ],
      { ignore: [] },
    );
    const index = new TaskIndex();
    for (const path of [
      "zeta/tasks.md",
      "alpha/tasks.md",
      "inbox/tasks.md",
      "_archive/old/tasks.md",
    ])
      index.set(path, "- [ ] x", "h");
    expect(taskGroups(workspace, index.view()).map((group) => [group.project, group.path])).toEqual(
      [
        ["inbox", "inbox/tasks.md"],
        ["alpha", "alpha/tasks.md"],
        ["zeta", "zeta/tasks.md"],
      ],
    );
  });
});
