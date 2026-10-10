import { describe, expect, it } from "vitest";
import { parseTaskDocument, splitLines, appendLines } from "./taskDocument";
import { TaskIndex } from "./taskIndex";
import { SearchIndex } from "./searchIndex";
import { archivedEntries, listItems, listSummary, listTitle, SummaryStore } from "./views";
import {
  buildWorkspace,
  findProjectByKey,
  isArchivedKey,
  projectKey,
  projectKeyOf,
  projectNameOf,
} from "./workspace";

const workspace = buildWorkspace(
  ["inbox/a.md", "api/tasks.md", "_archive/old/tasks.md", "_archive/old/n.md", "loose.md"].map(
    (path) => ({ path, size: 1, modified: 1 }),
  ),
  { ignore: [] },
);

describe("project keys", () => {
  it("names active and archived projects by folder", () => {
    expect(projectKey("api", false)).toBe("api");
    expect(projectKey("old", true)).toBe("_archive/old");
    expect(isArchivedKey("_archive/old")).toBe(true);
    expect(isArchivedKey("api")).toBe(false);
    expect(projectNameOf("_archive/old")).toBe("old");
    expect(projectNameOf("api")).toBe("api");
    expect(projectKeyOf("_archive/old/n.md")).toBe("_archive/old");
    expect(projectKeyOf("api/s/x.md")).toBe("api");
    expect(projectKeyOf("loose.md")).toBe("inbox");
    expect(projectKeyOf("image.png")).toBe("inbox");
  });

  it("finds archived projects by key and lists them", () => {
    expect(findProjectByKey(workspace, "_archive/old")?.notes.map((note) => note.path)).toEqual([
      "_archive/old/n.md",
    ]);
    expect(findProjectByKey(workspace, "api")?.name).toBe("api");
    expect(findProjectByKey(workspace, "_archive/api")).toBeUndefined();
    expect(archivedEntries(workspace)).toEqual([{ name: "old", key: "_archive/old" }]);
    expect(listItems(workspace, "_archive/old", new Map()).map((item) => item.id)).toEqual([
      "_archive/old/tasks.md",
      "_archive/old/n.md",
    ]);
    expect(listSummary(workspace, "_archive/old", new Map())).toBe("1 note · … tasks");
    expect(listTitle("_archive/old")).toBe("_archive/old/");
  });
});

describe("renames in indexes", () => {
  it("moves task lists, summaries and recent paths", () => {
    const tasks = new TaskIndex();
    tasks.set("a/tasks.md", "- [ ] x", "h");
    expect(tasks.rename("a/tasks.md", "b/tasks.md")).toBe(true);
    expect(tasks.rename("a/tasks.md", "c/tasks.md")).toBe(false);
    expect(tasks.rename("b/tasks.md", "b/tasks.md")).toBe(false);
    expect(tasks.paths()).toEqual(["b/tasks.md"]);

    const store = new SummaryStore();
    store.set("a/x.md", { title: "X", openTasks: 0 });
    expect(store.rename("a/x.md", "b/x.md")).toBe(true);
    expect(store.rename("a/x.md", "b/x.md")).toBe(false);
    expect(store.view().get("b/x.md")?.title).toBe("X");

    const search = new SearchIndex();
    search.touch("a/x.md");
    search.touch("c/y.md");
    search.renameRecent((path) => (path.startsWith("a/") ? `b/${path.slice(2)}` : null));
    expect(search.recent).toEqual(["c/y.md", "b/x.md"]);
  });
});

describe("appendLines", () => {
  const block = splitLines("- [ ] moved\r\n  detail\r\n");

  it("adds a block at the end with the list's line separator", () => {
    expect(appendLines(parseTaskDocument("- [ ] a\n"), block)).toEqual({
      text: "- [ ] a\n- [ ] moved\n  detail\n",
      focus: 1,
    });
    expect(appendLines(parseTaskDocument(""), block)).toEqual({
      text: "- [ ] moved\n  detail\n",
      focus: 0,
    });
  });

  it("keeps a last line without a line break so, and stays out of an open fence", () => {
    expect(appendLines(parseTaskDocument("- [ ] a"), block)?.text).toBe(
      "- [ ] a\n- [ ] moved\n  detail",
    );
    expect(appendLines(parseTaskDocument("- [ ] a\n```\ncode\n"), block)?.text).toBe(
      "- [ ] a\n- [ ] moved\n  detail\n```\ncode\n",
    );
    expect(appendLines(parseTaskDocument("- [ ] a\n"), [])).toBeNull();
  });
});
