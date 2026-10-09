import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchIndex, type SearchResult } from "$lib/core/searchIndex";
import { MemoryStorage } from "$lib/storage";
import { AppState, TASK_CHANGED } from "./appState.svelte";

const ROOT = "/notes";
const NOW = new Date(2026, 9, 8, 9, 5).getTime();

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] buy coffee beans\n- [x] grind coffee\n",
  "inbox/idea.md": "# Idea\nA place for coffee notes.\n",
  "api/tasks.md": "- [ ] deploy the gateway\n  - [ ] check gateway logs\n",
  "api/deploy.md": "# Deploy\nSteps\n\nRun the gateway build.\n",
  "web/readme.md": "plain text\n",
  "_archive/old/tasks.md": "- [ ] archived coffee\n",
  "_archive/old/coffee.md": "# Archived coffee\n",
};

async function started(extra: Record<string, string> = {}) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...files, ...extra } },
    settings: JSON.stringify({ version: 1, workspace: ROOT }),
  });
  const idle: (() => void)[] = [];
  const app = new AppState(storage, {
    defer: (task) => task(),
    schedule: (task) => task(),
    idle: (task) => idle.push(task),
    saveDelay: 10,
  });
  await app.start();
  await app.settled();
  const runIdle = () => {
    for (const task of idle.splice(0)) task();
  };
  return { storage, app, idle, runIdle };
}

const ids = (results: readonly SearchResult[]) => results.map((result) => result.id);
const paths = (results: readonly SearchResult[]) => results.map((result) => result.path);
const find = (app: AppState, query: string, kind: SearchResult["kind"]) => {
  const result = app.search(query).find((candidate) => candidate.kind === kind);
  if (!result) throw new Error(`no ${kind} for ${query}`);
  return result;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AppState.search", () => {
  it("finds notes, tasks and projects read in the background, without archived ones", async () => {
    const { app } = await started();
    const results = app.search("coffee");
    expect(results.map((result) => [result.kind, result.path])).toEqual(
      expect.arrayContaining([
        ["note", "inbox/idea.md"],
        ["task", "inbox/tasks.md"],
      ]),
    );
    expect(paths(results).some((path) => path.startsWith("_archive/"))).toBe(false);
    expect(ids(app.search("api"))).toContain("project:api");
    expect(paths(app.search("gateway"))).toEqual(
      expect.arrayContaining(["api/deploy.md", "api/tasks.md"]),
    );
  });

  it("finds nothing before a workspace is open", () => {
    const app = new AppState(new MemoryStorage());
    expect(app.search("coffee")).toEqual([]);
  });

  it("follows saves, renames and deletes", async () => {
    const { app } = await started();
    app.selectFolder("web");
    await app.settled();
    app.edit("web/readme.md", () => "# Readme\nmentions zebras\n");
    await vi.advanceTimersByTimeAsync(20);
    await app.settled();
    expect(paths(app.search("zebras"))).toEqual(["web/readme.md"]);

    await app.renameNote("web/readme.md", "intro");
    expect(paths(app.search("zebras"))).toEqual(["web/intro.md"]);

    await app.deleteNote("web/intro.md");
    expect(app.search("zebras")).toEqual([]);
  });

  it("indexes saved notes when idle, not while saving", async () => {
    const { app, idle, runIdle } = await started();
    app.selectFolder("web");
    await app.settled();
    const upsert = vi.spyOn(SearchIndex.prototype, "upsertNote");
    const flush = vi.spyOn(SearchIndex.prototype, "flushQueued");
    app.edit("web/readme.md", () => "# Readme\nmentions zebras\n");
    await vi.advanceTimersByTimeAsync(20);
    await app.settled();
    app.edit("web/readme.md", () => "# Readme\nmentions zebras and yaks\n");
    await vi.advanceTimersByTimeAsync(20);
    await app.settled();
    expect(upsert).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    // One idle task for both saves.
    expect(idle).toHaveLength(1);

    const revision = app.searchRevision;
    runIdle();
    expect(flush).toHaveBeenCalledOnce();
    expect(app.searchRevision).toBe(revision + 1);
    expect(paths(app.search("yaks"))).toEqual(["web/readme.md"]);
    // Nothing left to do: the idle task does not bump the revision again.
    flush.mockClear();
    app.edit("web/readme.md", () => "# Readme\nmentions owls\n");
    await vi.advanceTimersByTimeAsync(20);
    await app.settled();
    // A search indexes what is queued first.
    expect(paths(app.search("owls"))).toEqual(["web/readme.md"]);
    const before = app.searchRevision;
    runIdle();
    expect(app.searchRevision).toBe(before);
  });

  it("bumps the search revision when summaries are published", async () => {
    const { app } = await started();
    const revision = app.searchRevision;
    app.addTask("inbox/tasks.md", "new", "end");
    expect(app.searchRevision).toBeGreaterThan(revision);
  });

  it("follows task edits and changes on disk", async () => {
    const { storage, app } = await started();
    app.addTask("inbox/tasks.md", "call the plumber", "end");
    expect(find(app, "plumber", "task").title).toBe("call the plumber");

    storage.setExternal("inbox/idea.md", "# Idea\nnow about tea\n");
    await app.settled();
    expect(paths(app.search("tea"))).toEqual(["inbox/idea.md"]);

    storage.setExternal("inbox/idea.md", null);
    await app.settled();
    expect(app.search("tea")).toEqual([]);
  });

  it("lists recently opened notes and lists for an empty query", async () => {
    const { app } = await started();
    app.selectFolder("api");
    app.selectItem("api/deploy.md");
    await app.settled();
    const recent = app.search("");
    expect(recent.slice(0, 3).map((result) => [result.kind, result.path])).toEqual([
      ["note", "api/deploy.md"],
      ["list", "api/tasks.md"],
      ["list", "inbox/tasks.md"],
    ]);
    expect(recent.slice(3).map((result) => result.path)).toEqual(["inbox", "api", "web"]);
  });

  it("keeps the project list current", async () => {
    const { app } = await started();
    expect(ids(app.search("newproj"))).toEqual([]);
    await app.createProject("newproj");
    expect(ids(app.search("newproj"))).toEqual(["project:newproj"]);
  });
});

describe("AppState.openSearchResult", () => {
  it("opens a note and shows the first matching line of a text match", async () => {
    const { app } = await started();
    const focus = app.editorFocusRequest;
    app.openSearchResult(find(app, "gateway", "note"));
    expect(app.folder).toBe("api");
    expect(app.item).toBe("api/deploy.md");
    expect(app.editorFocusRequest).toBe(focus + 1);
    expect(app.editorReveal).toMatchObject({ path: "api/deploy.md", line: 3 });

    // A title match opens the note at the top.
    const before = app.editorReveal;
    app.openSearchResult(find(app, "idea", "note"));
    expect(app.item).toBe("inbox/idea.md");
    expect(app.editorReveal).toBe(before);
  });

  it("focuses a task in its list, showing done tasks when needed", async () => {
    const { app } = await started();
    app.toggleHideDone("inbox/tasks.md");
    const done = app.search("grind")[0];
    if (!done) throw new Error("no result");
    app.openSearchResult(done);
    expect(app.folder).toBe("inbox");
    expect(app.item).toBe("inbox/tasks.md");
    expect(app.hideDone.has("inbox/tasks.md")).toBe(false);
    expect(app.taskFocus).toMatchObject({ path: "inbox/tasks.md", line: 1 });

    app.openSearchResult(find(app, "logs", "task"));
    expect(app.item).toBe("api/tasks.md");
    expect(app.taskFocus).toMatchObject({ path: "api/tasks.md", line: 1 });
  });

  it("shows a task list as tasks when it was shown as text", async () => {
    const { app } = await started();
    app.selectItem("inbox/tasks.md");
    app.setTaskTextMode(true);
    app.openSearchResult(find(app, "beans", "task"));
    expect(app.taskTextMode).toBe(false);
    expect(app.taskFocus).toMatchObject({ path: "inbox/tasks.md", line: 0 });
  });

  it("finds a task again after its line moved, or says it changed", async () => {
    const { storage, app } = await started();
    const result = find(app, "gateway", "task");
    storage.setExternal("api/tasks.md", "- [ ] first\n- [ ] deploy the gateway\n");
    await app.settled();
    // The search index was updated, but an older result still finds its task.
    app.openSearchResult(result);
    expect(app.taskFocus).toMatchObject({ path: "api/tasks.md", line: 1 });

    app.openSearchResult({ ...result, raw: "- [ ] gone" });
    expect(app.toasts.at(-1)?.message).toBe(TASK_CHANGED);
  });

  it("opens a project's task list with its first open task focused", async () => {
    const { app } = await started();
    app.openSearchResult(find(app, "api", "project"));
    expect(app.folder).toBe("api");
    expect(app.item).toBe("api/tasks.md");
    expect(app.taskFocus).toMatchObject({ path: "api/tasks.md", line: 0 });

    app.openSearchResult(find(app, "web", "project"));
    expect(app.folder).toBe("web");
    expect(app.item).toBe("web/readme.md");
  });

  it("opens a recent task list", async () => {
    const { app } = await started({ "api/tasks.md": "- [x] all done\n" });
    app.selectFolder("api");
    app.selectFolder("inbox");
    await app.settled();
    const list = app.search("").find((result) => result.path === "api/tasks.md");
    if (!list) throw new Error("no list");
    app.openSearchResult(list);
    expect(app.item).toBe("api/tasks.md");
    expect(app.taskFocus).toMatchObject({ path: "api/tasks.md", line: 0 });
  });

  it("ignores results that no longer exist", async () => {
    const { app } = await started();
    const before = { folder: app.folder, item: app.item };
    app.openSearchResult({
      kind: "list",
      id: "gone/tasks.md",
      path: "gone/tasks.md",
      title: "gone/tasks.md",
      titleRanges: [],
    });
    app.openSearchResult({
      kind: "task",
      id: "x",
      path: "gone/tasks.md",
      title: "x",
      titleRanges: [],
    });
    app.openSearchResult({
      kind: "project",
      id: "project:gone",
      path: "gone",
      title: "gone",
      titleRanges: [],
    });
    expect({ folder: app.folder, item: app.item }).toEqual(before);
  });

  it("does nothing before a workspace is open", () => {
    const app = new AppState(new MemoryStorage());
    app.openSearchResult({ kind: "project", id: "p", path: "inbox", title: "", titleRanges: [] });
    expect(app.item).toBe("");
  });
});
