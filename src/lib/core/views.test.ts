import { parseTaskDocument } from "./taskDocument";
import { describe, expect, it } from "vitest";
import {
  ALL_TASKS,
  ALL_TASKS_LABEL,
  fallbackSummary,
  isConflictCopy,
  MAX_SUMMARY_BYTES,
  PathQueue,
  summarizeFile,
  SummaryStore,
  listItems,
  listSummary,
  listTitle,
  NO_SUMMARIES,
  pathsToSummarize,
  sidebarEntries,
  splitPath,
  totalOpen,
  updateSummaries,
  type FileSummary,
} from "./views";
import { buildWorkspace, type Workspace } from "./workspace";

function workspace(paths: string[]): Workspace {
  return buildWorkspace(
    paths.map((path) => ({ path, size: 1, modified: 5 })),
    { ignore: [] },
  );
}

const ws = workspace([
  "inbox/tasks.md",
  "api/tasks.md",
  "api/deploy.md",
  "api/sub/auth.md",
  "empty/tasks.md",
  "notes-only/a.md",
]);

const summaries = new Map<string, FileSummary>([
  ["inbox/tasks.md", { title: "tasks", openTasks: 2 }],
  ["api/tasks.md", { title: "tasks", openTasks: 3 }],
  ["api/deploy.md", { title: "Deploy", openTasks: 1 }],
  ["empty/tasks.md", { title: "tasks", openTasks: 0 }],
]);

describe("sidebarEntries and totalOpen", () => {
  it("counts open tasks per project, with zero for projects without a list", () => {
    const entries = sidebarEntries(ws, summaries);
    expect(entries).toEqual([
      { name: "inbox", openCount: 2 },
      { name: "api", openCount: 3 },
      { name: "empty", openCount: 0 },
      { name: "notes-only", openCount: 0 },
    ]);
    expect(totalOpen(entries)).toBe(5);
  });

  it("reports unknown counts while files are loading", () => {
    const entries = sidebarEntries(ws, new Map());
    expect(entries[0]).toEqual({ name: "inbox", openCount: null });
    expect(totalOpen(entries)).toBeNull();
  });
});

describe("listItems", () => {
  it("lists the task file first, then notes with titles when known", () => {
    expect(listItems(ws, "api", summaries)).toEqual([
      { kind: "tasks", id: "api/tasks.md", label: "tasks.md", openCount: 3 },
      { kind: "note", id: "api/deploy.md", name: "deploy.md", title: "Deploy", modified: 5 },
      { kind: "note", id: "api/sub/auth.md", name: "sub/auth.md", title: null, modified: 5 },
    ]);
  });

  it("omits the task list for projects without one", () => {
    expect(listItems(ws, "notes-only", summaries).map((item) => item.kind)).toEqual(["note"]);
  });

  it("returns nothing for an unknown selection", () => {
    expect(listItems(ws, "missing", summaries)).toEqual([]);
  });

  it("lists the combined view, then task files with open or unknown counts in all tasks", () => {
    expect(listItems(ws, ALL_TASKS, summaries).map((item) => item.id)).toEqual([
      ALL_TASKS,
      "inbox/tasks.md",
      "api/tasks.md",
    ]);
    expect(listItems(ws, ALL_TASKS, new Map()).map((item) => item.id)).toEqual([
      ALL_TASKS,
      "inbox/tasks.md",
      "api/tasks.md",
      "empty/tasks.md",
    ]);
    expect(listItems(ws, ALL_TASKS, summaries)[0]).toMatchObject({
      kind: "tasks",
      label: ALL_TASKS_LABEL,
      openCount: 5,
    });
    expect(listItems(ws, ALL_TASKS, new Map())[0]).toMatchObject({ openCount: null });
    expect(listItems(ws, ALL_TASKS, summaries)[1]).toMatchObject({ label: "inbox/tasks.md" });
  });
});

describe("listTitle", () => {
  it("formats titles like paths", () => {
    expect(listTitle("inbox")).toBe("~/inbox");
    expect(listTitle("api")).toBe("api/");
    expect(listTitle(ALL_TASKS)).toBe("all-tasks");
  });
});

describe("listSummary", () => {
  it("summarizes a project", () => {
    expect(listSummary(ws, "api", summaries)).toBe("2 notes · 3 tasks");
    expect(listSummary(ws, "notes-only", summaries)).toBe("1 note · 0 tasks");
    expect(listSummary(ws, "inbox", new Map())).toBe("0 notes · … tasks");
    expect(
      listSummary(
        workspace(["p/tasks.md"]),
        "p",
        new Map([["p/tasks.md", { title: "", openTasks: 1 }]]),
      ),
    ).toBe("0 notes · 1 task");
  });

  it("summarizes all tasks", () => {
    expect(listSummary(ws, ALL_TASKS, summaries)).toBe("5 open · 2 lists");
    expect(listSummary(ws, ALL_TASKS, new Map())).toBe("… open · 3 lists");
    expect(
      listSummary(
        workspace(["p/tasks.md"]),
        ALL_TASKS,
        new Map([["p/tasks.md", { title: "", openTasks: 1 }]]),
      ),
    ).toBe("1 open · 1 list");
  });

  it("is empty for an unknown selection", () => {
    expect(listSummary(ws, "missing", summaries)).toBe("");
  });
});

describe("splitPath", () => {
  it("splits folder and file name", () => {
    expect(splitPath("api/sub/auth.md")).toEqual({ folder: "api/sub/", file: "auth.md" });
    expect(splitPath("loose.md")).toEqual({ folder: "", file: "loose.md" });
  });
});

describe("updateSummaries", () => {
  it("returns a new map with entries set and removed", () => {
    const before = new Map([["a.md", { title: "A", openTasks: 0 }]]);
    const after = updateSummaries(before, [["b.md", { title: "B", openTasks: 1 }]], ["a.md"]);
    expect([...after.keys()]).toEqual(["b.md"]);
    expect([...before.keys()]).toEqual(["a.md"]);
    expect(updateSummaries(NO_SUMMARIES, [])).not.toBe(NO_SUMMARIES);
  });
});

describe("pathsToSummarize", () => {
  it("returns updated paths and paths without a summary, in shown order", () => {
    const summaries = new Map([
      ["a.md", { title: "A", openTasks: 0 }],
      ["b.md", { title: "B", openTasks: 0 }],
    ]);
    expect(pathsToSummarize(["a.md", "b.md", "c.md"], ["b.md", "gone.md"], summaries)).toEqual([
      "b.md",
      "c.md",
    ]);
  });
});

describe("summarizeFile", () => {
  it("counts tasks only in task lists", () => {
    expect(summarizeFile("api/tasks.md", "- [ ] a\n- [ ] b")).toEqual({
      title: "tasks",
      openTasks: 2,
    });
    expect(summarizeFile("api/deploy.md", "# Deploy\n- [ ] a")).toEqual({
      title: "Deploy",
      openTasks: 0,
    });
    expect(summarizeFile("api/sub/tasks.md", "- [ ] a").openTasks).toBe(0);
  });

  it("counts open top-level tasks outside code and front matter, like the task view", () => {
    const text = "---\n- [ ] meta\n---\n```\n- [ ] code\n```\n- [ ] real\n  - [ ] sub\n- [X] done";
    expect(summarizeFile("api/tasks.md", text).openTasks).toBe(1);
    expect(summarizeFile("api/tasks.md", "- [ ] a\r- [ ] b").openTasks).toBe(2);
  });

  it("reuses a parsed list for the same text only", () => {
    const doc = parseTaskDocument("- [ ] a\n- [ ] b");
    expect(summarizeFile("api/tasks.md", "- [ ] a\n- [ ] b", doc).openTasks).toBe(2);
    expect(summarizeFile("api/tasks.md", "- [ ] a", doc).openTasks).toBe(1);
  });

  it("falls back to the file name for skipped files", () => {
    expect(fallbackSummary("api/big-log.md")).toEqual({ title: "big-log", openTasks: 0 });
    expect(MAX_SUMMARY_BYTES).toBe(1024 * 1024);
  });
});

describe("SummaryStore", () => {
  it("publishes new views over the same data", () => {
    const store = new SummaryStore();
    const first = store.view();
    store.set("a.md", { title: "A", openTasks: 0 });
    store.set("b.md", { title: "B", openTasks: 1 });
    const second = store.view();
    expect(second).not.toBe(first);
    expect(store.size).toBe(2);
    expect(store.has("a.md")).toBe(true);
    expect(second.size).toBe(2);
    expect(second.get("b.md")).toEqual({ title: "B", openTasks: 1 });
    expect(second.has("c.md")).toBe(false);
    expect([...second.keys()]).toEqual(["a.md", "b.md"]);
    expect([...second.values()].map((summary) => summary.title)).toEqual(["A", "B"]);
    expect([...second.entries()].map(([path]) => path)).toEqual(["a.md", "b.md"]);
    expect([...second].length).toBe(2);
    const seen: string[] = [];
    second.forEach((_, key, map) => {
      seen.push(key);
      expect(map).toBe(second);
    });
    expect(seen).toEqual(["a.md", "b.md"]);
  });

  it("retains and clears entries", () => {
    const store = new SummaryStore();
    store.set("a.md", { title: "A", openTasks: 0 });
    store.set("b.md", { title: "B", openTasks: 0 });
    expect(store.retain((path) => path === "a.md")).toBe(true);
    expect(store.retain(() => true)).toBe(false);
    expect([...store.view().keys()]).toEqual(["a.md"]);
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("PathQueue", () => {
  const rank = (path: string) => (path.endsWith("tasks.md") ? 0 : path.startsWith("cur/") ? 1 : 2);

  it("takes higher priorities first and keeps insertion order within a level", () => {
    const queue = new PathQueue();
    queue.add(["x/a.md", "cur/b.md", "x/tasks.md", "cur/c.md", "y/tasks.md"], rank);
    expect(queue.size).toBe(5);
    expect(queue.take(3)).toEqual(["x/tasks.md", "y/tasks.md", "cur/b.md"]);
    expect(queue.take(10)).toEqual(["cur/c.md", "x/a.md"]);
    expect(queue.take(10)).toEqual([]);
  });

  it("de-duplicates waiting paths and allows re-adding taken ones", () => {
    const queue = new PathQueue();
    queue.add(["a.md", "a.md"], () => 2);
    expect(queue.size).toBe(1);
    expect(queue.take(5)).toEqual(["a.md"]);
    queue.add(["a.md"], () => 2);
    expect(queue.take(5)).toEqual(["a.md"]);
  });

  it("clamps ranks, drops deleted paths and clears", () => {
    const queue = new PathQueue(2);
    queue.add(["a.md"], () => -5);
    queue.add(["b.md", "c.md"], () => 9);
    queue.delete("b.md");
    expect(queue.take(1)).toEqual(["a.md"]);
    expect(queue.take(5)).toEqual(["c.md"]);
    queue.add(["d.md"], () => 1);
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.take(5)).toEqual([]);
  });

  it("resumes a partly taken level", () => {
    const queue = new PathQueue(1);
    queue.add(["a.md", "b.md", "c.md"], () => 0);
    expect(queue.take(1)).toEqual(["a.md"]);
    queue.add(["d.md"], () => 0);
    expect(queue.take(5)).toEqual(["b.md", "c.md", "d.md"]);
  });
});

describe("isConflictCopy", () => {
  it("recognizes conflict copies by name", () => {
    expect(isConflictCopy("tasks (conflict 2026-10-08 0905).md")).toBe(true);
    expect(isConflictCopy("api/plan (conflict 2026-10-08 0905) 2.md")).toBe(true);
    expect(isConflictCopy("conflict notes.md")).toBe(false);
    expect(isConflictCopy("a (conflict notes).md")).toBe(false);
    expect(isConflictCopy("a (conflict 2026-10-08 0905).txt")).toBe(false);
  });
});
