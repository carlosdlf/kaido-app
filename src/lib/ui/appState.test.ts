import { describe, expect, it, vi } from "vitest";
import { ALL_TASKS } from "$lib/core/views";
import { MemoryStorage, StorageError } from "$lib/storage";
import { AppState } from "./appState.svelte";

const ROOT = "/notes";

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] one\n- [x] two\n- [ ] three\n",
  "inbox/idea.md": "# Idea\nbody",
  "api/tasks.md": "- [ ] ship\n",
  "api/deploy.md": "# Deploy\n\nSteps.",
  "api/sub/auth.md": "no heading",
  "empty/readme.txt": "not markdown",
  "docs/guide.md": "# Guide",
};

function setup(
  options: {
    files?: Record<string, string>;
    settings?: string | null;
    pick?: string | null;
  } = {},
) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...(options.files ?? files) } },
    settings:
      options.settings === undefined
        ? JSON.stringify({ version: 1, workspace: ROOT })
        : options.settings,
    pick: options.pick ?? null,
    now: () => 1000,
  });
  const app = new AppState(storage, { defer: (task) => task(), concurrency: 2 });
  return { storage, app };
}

async function started(options: Parameters<typeof setup>[0] = {}) {
  const context = setup(options);
  await context.app.start();
  await context.app.settled();
  return context;
}

describe("AppState startup", () => {
  it("asks for a workspace when none is configured", async () => {
    const { app } = await started({ settings: null });
    expect(app.phase).toEqual({ kind: "no-workspace" });
    expect(app.warnings).toEqual([]);
  });

  it("reopens the last workspace and selects the inbox task list", async () => {
    const { app } = await started();
    expect(app.phase).toEqual({ kind: "ready", root: ROOT });
    expect(app.workspace.projects.map((project) => project.name)).toEqual(["inbox", "api", "docs"]);
    expect(app.folder).toBe("inbox");
    expect(app.item).toBe("inbox/tasks.md");
    expect(app.document).toMatchObject({ status: "ready", path: "inbox/tasks.md" });
  });

  it("loads titles and task counts in the background", async () => {
    const { app } = await started();
    expect(app.summaries.get("inbox/tasks.md")).toEqual({ title: "tasks", openTasks: 2 });
    expect(app.summaries.get("api/deploy.md")?.title).toBe("Deploy");
    expect(app.summaries.get("api/sub/auth.md")?.title).toBe("auth");
    expect(app.summaries.size).toBe(6);
  });

  it("renders from the listing before any background read", async () => {
    let deferred: (() => void) | undefined;
    const storage = new MemoryStorage({
      folders: { [ROOT]: files },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
    });
    const app = new AppState(storage, { defer: (task) => (deferred = task) });
    await app.start();
    expect(app.phase.kind).toBe("ready");
    expect(app.summaries.has("api/deploy.md")).toBe(false);
    deferred?.();
    await app.settled();
    expect(app.summaries.has("api/deploy.md")).toBe(true);
  });

  it("shows an error when the last workspace is gone", async () => {
    const { app } = await started({ settings: JSON.stringify({ version: 1, workspace: "/gone" }) });
    expect(app.phase).toEqual({
      kind: "error",
      message: "The folder /gone could not be found. It may have been moved or deleted.",
    });
  });

  it.each([
    ["NotADirectory", "/notes is not a folder."],
    ["PermissionDenied", "Kaido does not have permission to open /notes."],
    ["Io", "The workspace could not be opened: disk on fire"],
  ] as const)("explains a %s error", async (kind, message) => {
    const { storage, app } = setup();
    vi.spyOn(storage, "openWorkspace").mockRejectedValue(new StorageError(kind, "disk on fire"));
    await app.start();
    expect(app.phase).toEqual({ kind: "error", message });
  });

  it("reports invalid settings and keeps going", async () => {
    const { app } = await started({ settings: "{ broken" });
    expect(app.phase.kind).toBe("no-workspace");
    expect(app.warnings[0]?.message).toMatch(/not valid JSON/);
  });

  it("starts fresh without overwriting settings it cannot read", async () => {
    const { storage, app } = setup({ pick: ROOT });
    vi.spyOn(storage, "readSettings").mockRejectedValue(new StorageError("Io", "locked"));
    const write = vi.spyOn(storage, "writeSettings");
    await app.start();
    expect(app.phase.kind).toBe("no-workspace");
    expect(app.warnings).toEqual([{ field: "", message: "settings.json: locked" }]);
    await app.pickWorkspace();
    expect(app.phase.kind).toBe("ready");
    expect(write).not.toHaveBeenCalled();
  });

  it("applies the workspace ignore patterns and reports config problems", async () => {
    const { app } = await started({
      files: { ...files, ".kaido/config.json": '{ "version": 1, "ignore": ["docs"], "x": 1 }' },
    });
    expect(app.workspace.projects.map((project) => project.name)).toEqual(["inbox", "api"]);

    const invalid = await started({
      files: { ...files, ".kaido/config.json": '{ "version": 1, "ignore": "docs" }' },
    });
    expect(invalid.app.workspace.projects).toHaveLength(3);
    expect(invalid.app.warnings[0]?.message).toMatch(/ignore: expected a list of strings/);
  });

  it("treats an unreadable workspace config as a warning", async () => {
    const { storage, app } = setup();
    const read = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation((path) =>
      path === ".kaido/config.json"
        ? Promise.reject(new StorageError("PermissionDenied", "no access"))
        : read(path),
    );
    await app.start();
    expect(app.phase.kind).toBe("ready");
    expect(app.warnings).toEqual([{ field: "", message: ".kaido/config.json: no access" }]);
  });
});

describe("AppState workspace picking", () => {
  it("opens the picked folder and remembers it, keeping unknown settings", async () => {
    const { storage, app } = await started({
      settings: '{ "version": 1, "theme": "dark" }',
      pick: ROOT,
    });
    await app.pickWorkspace();
    expect(app.phase.kind).toBe("ready");
    expect(JSON.parse(storage.settings ?? "")).toEqual({
      version: 1,
      workspace: ROOT,
      theme: "dark",
    });
  });

  it("does not rewrite settings that already point to the workspace", async () => {
    const { storage, app } = setup();
    const write = vi.spyOn(storage, "writeSettings");
    await app.start();
    expect(write).not.toHaveBeenCalled();
  });

  it("never overwrites settings it could not parse, and says why", async () => {
    const broken = '{ "version": 1, "workspace": ';
    const { storage, app } = await started({ settings: broken, pick: ROOT });
    const write = vi.spyOn(storage, "writeSettings");
    await app.pickWorkspace();
    expect(app.phase.kind).toBe("ready");
    expect(write).not.toHaveBeenCalled();
    expect(storage.settings).toBe(broken);
    expect(app.warnings.map((warning) => warning.message)).toEqual([
      "settings.json: not valid JSON; using defaults and leaving the file unchanged",
      "settings.json was left unchanged, so this workspace will not be reopened next time. Fix or remove the file to let Kaido save it.",
    ]);
  });

  it("keeps invalid settings fields when remembering the workspace", async () => {
    const { storage, app } = await started({
      settings: '{ "version": 1, "workspace": 42, "theme": "dark" }',
      pick: ROOT,
    });
    await app.pickWorkspace();
    expect(JSON.parse(storage.settings ?? "")).toEqual({
      version: 1,
      workspace: ROOT,
      theme: "dark",
    });
  });

  it("never overwrites settings from a newer version", async () => {
    const newer = '{ "version": 9, "workspace": "/elsewhere" }';
    const { storage, app } = await started({ settings: newer, pick: ROOT });
    expect(app.phase.kind).toBe("no-workspace");
    await app.pickWorkspace();
    expect(app.phase.kind).toBe("ready");
    expect(storage.settings).toBe(newer);
  });

  it("keeps the current state when the picker is cancelled", async () => {
    const { app } = await started({ settings: null });
    await app.pickWorkspace();
    expect(app.phase).toEqual({ kind: "no-workspace" });
  });

  it("shows picker failures", async () => {
    const { storage, app } = await started({ settings: null });
    vi.spyOn(storage, "pickWorkspaceFolder").mockRejectedValue({
      kind: "Io",
      message: "no dialog",
    });
    await app.pickWorkspace();
    expect(app.phase).toEqual({ kind: "error", message: "no dialog" });
  });

  it("reports a failure to save settings without blocking", async () => {
    const { storage, app } = await started({ settings: null, pick: ROOT });
    vi.spyOn(storage, "writeSettings").mockRejectedValue(new StorageError("Io", "read-only disk"));
    await app.pickWorkspace();
    expect(app.phase.kind).toBe("ready");
    await vi.waitFor(() =>
      expect(app.warnings).toEqual([{ field: "", message: "settings.json: read-only disk" }]),
    );
  });

  it("only applies the most recent of overlapping opens", async () => {
    const { storage, app } = setup({ settings: null });
    storage.addFolder("/other", { "other/a.md": "# A" });
    await app.start();
    const first = app.openWorkspace(ROOT);
    const second = app.openWorkspace("/other");
    await Promise.all([first, second]);
    await app.settled();
    expect(app.phase).toEqual({ kind: "ready", root: "/other" });
    expect(app.workspace.projects.map((project) => project.name)).toEqual(["inbox", "other"]);
    expect(storage.listenerCount).toBe(1);
  });

  it("ignores a failure from an outdated open", async () => {
    const { storage, app } = setup({ settings: null });
    await app.start();
    const first = app.openWorkspace("/missing");
    const second = app.openWorkspace(ROOT);
    await Promise.all([first, second]);
    expect(app.phase.kind).toBe("ready");
    expect(storage.listenerCount).toBe(1);
  });

  it("drops a listing that arrives after a newer open started", async () => {
    const { storage, app } = setup({ settings: null });
    storage.addFolder("/other", {});
    await app.start();
    const list = storage.listFiles.bind(storage);
    let release: () => void = () => undefined;
    vi.spyOn(storage, "listFiles").mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(list()))),
    );
    const first = app.openWorkspace(ROOT);
    await vi.waitFor(() => expect(storage.listFiles).toHaveBeenCalled());
    await app.openWorkspace("/other");
    release();
    await first;
    expect(app.phase).toEqual({ kind: "ready", root: "/other" });
  });
});

describe("AppState selection", () => {
  it("selects a project and its first item", async () => {
    const { app } = await started();
    app.selectFolder("docs");
    expect(app.item).toBe("docs/guide.md");
    await app.settled();
    await vi.waitFor(() =>
      expect(app.document).toMatchObject({ status: "ready", text: "# Guide" }),
    );
  });

  it("keeps the selection when the same folder is chosen", async () => {
    const { app } = await started();
    app.selectItem("inbox/idea.md");
    app.selectFolder("inbox");
    expect(app.item).toBe("inbox/idea.md");
  });

  it("selects the first task list in all tasks", async () => {
    const { app } = await started();
    app.selectFolder(ALL_TASKS);
    expect(app.item).toBe("inbox/tasks.md");
  });

  it("clears the selection for an empty view", async () => {
    const { app } = await started({ files: { "notes/a.md": "x" } });
    expect(app.item).toBe("");
    expect(app.document).toBeNull();
    app.selectFolder(ALL_TASKS);
    expect(app.item).toBe("");
  });

  it("shows a loading state, then the contents", async () => {
    const { app } = await started();
    app.selectItem("api/deploy.md");
    expect(app.document).toEqual({ status: "loading", path: "api/deploy.md" });
    await vi.waitFor(() =>
      expect(app.document).toEqual({
        status: "ready",
        path: "api/deploy.md",
        text: "# Deploy\n\nSteps.",
        modified: 1000,
      }),
    );
  });

  it("reports missing and unreadable files, and retries after an error", async () => {
    const { storage, app } = await started();
    storage.setExternal("api/deploy.md", null, false);
    app.selectItem("api/deploy.md");
    await vi.waitFor(() => expect(app.document?.status).toBe("missing"));

    const read = vi
      .spyOn(storage, "readFile")
      .mockRejectedValueOnce(new StorageError("InvalidUtf8", "bad bytes"));
    app.selectItem("inbox/idea.md");
    await vi.waitFor(() =>
      expect(app.document).toEqual({
        status: "error",
        path: "inbox/idea.md",
        message: "bad bytes",
      }),
    );
    app.selectItem("inbox/idea.md");
    await vi.waitFor(() => expect(app.document?.status).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("ignores a read that finishes after the selection moved on", async () => {
    const { storage, app } = await started();
    let release: () => void = () => undefined;
    vi.spyOn(storage, "readFile").mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ contents: "late", hash: "x" }))),
    );
    app.selectItem("api/deploy.md");
    app.selectItem("inbox/idea.md");
    await vi.waitFor(() => expect(app.document?.status).toBe("ready"));
    release();
    await Promise.resolve();
    expect(app.document).toMatchObject({ path: "inbox/idea.md", text: "# Idea\nbody" });
  });

  it("ignores a failed read after the selection moved on", async () => {
    const { storage, app } = await started();
    let fail: () => void = () => undefined;
    vi.spyOn(storage, "readFile").mockImplementationOnce(
      () => new Promise((_, reject) => (fail = () => reject(new StorageError("Io", "x")))),
    );
    app.selectItem("api/deploy.md");
    app.selectItem("inbox/idea.md");
    await vi.waitFor(() => expect(app.document?.status).toBe("ready"));
    fail();
    await Promise.resolve();
    expect(app.document?.status).toBe("ready");
  });
});

describe("AppState file changes", () => {
  it("updates the open note and its summary after an external edit", async () => {
    const { storage, app } = await started();
    storage.setExternal("inbox/tasks.md", "- [ ] only one\n");
    await app.settled();
    expect(app.document).toMatchObject({ status: "ready", text: "- [ ] only one\n" });
    expect(app.summaries.get("inbox/tasks.md")?.openTasks).toBe(1);
  });

  it("keeps the document object when a write echoes identical contents", async () => {
    const { storage, app } = await started();
    const before = app.document;
    await storage.writeFile("inbox/tasks.md", files["inbox/tasks.md"] ?? "");
    await Promise.resolve();
    await app.settled();
    expect(app.document).toBe(before);
  });

  it("updates other files without touching the open document", async () => {
    const { storage, app } = await started();
    const before = app.document;
    storage.setExternal("api/deploy.md", "# Shipping");
    await app.settled();
    expect(app.summaries.get("api/deploy.md")?.title).toBe("Shipping");
    expect(app.document).toBe(before);
  });

  it("adds new files through a fresh listing", async () => {
    const { storage, app } = await started();
    storage.setExternal("newproj/plan.md", "# Plan");
    await app.settled();
    expect(app.workspace.projects.map((project) => project.name)).toContain("newproj");
    expect(app.summaries.get("newproj/plan.md")?.title).toBe("Plan");
  });

  it("marks the open note as missing when it is deleted", async () => {
    const { storage, app } = await started();
    storage.setExternal("inbox/tasks.md", null);
    await app.settled();
    expect(app.document).toEqual({ status: "missing", path: "inbox/tasks.md" });
    expect(app.summaries.has("inbox/tasks.md")).toBe(false);
    expect(app.workspace.projects[0]?.tasks).toBeNull();
  });

  it("reloads the open note when a rescan shows it changed", async () => {
    let time = 1000;
    const storage = new MemoryStorage({
      folders: { [ROOT]: { ...files } },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
      now: () => time,
    });
    const app = new AppState(storage, { defer: (task) => task() });
    await app.start();
    await app.settled();
    time = 2000;
    storage.setExternal("inbox/tasks.md", "- [ ] changed\n", false);
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    await vi.waitFor(() =>
      expect(app.document).toMatchObject({ text: "- [ ] changed\n", modified: 2000 }),
    );
  });

  it("falls back to the inbox when the selected project disappears", async () => {
    const { storage, app } = await started();
    app.selectFolder("docs");
    storage.setExternal("docs/guide.md", null, false);
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    expect(app.folder).toBe("inbox");
    expect(app.item).toBe("inbox/tasks.md");
  });

  it("selects the first item when an empty view gets one", async () => {
    const { storage, app } = await started({ files: {} });
    expect(app.item).toBe("");
    storage.setExternal("inbox/first.md", "# First");
    await app.settled();
    expect(app.item).toBe("inbox/first.md");
  });

  it("ignores changes to files that are not shown", async () => {
    const { storage, app } = await started();
    const list = vi.spyOn(storage, "listFiles");
    const read = vi.spyOn(storage, "readFile");
    storage.emitChange({ paths: [".kaido/x.md", "node_modules/a.md"], rescan: false });
    await app.settled();
    expect(list).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("removes a deleted file without a new listing", async () => {
    const { storage, app } = await started();
    const list = vi.spyOn(storage, "listFiles");
    storage.setExternal("api/deploy.md", null);
    await app.settled();
    expect(app.workspace.projects[1]?.notes.map((note) => note.name)).toEqual(["sub/auth.md"]);
    expect(app.summaries.has("api/deploy.md")).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps the last state when reloading fails", async () => {
    const { storage, app } = await started();
    const before = app.workspace;
    vi.spyOn(storage, "listFiles").mockRejectedValue(new StorageError("NotFound", "gone"));
    vi.spyOn(storage, "readFile").mockRejectedValue(new StorageError("Io", "busy"));
    storage.emitChange({ paths: [], rescan: true });
    storage.emitChange({ paths: ["api/deploy.md"], rescan: false });
    await app.settled();
    expect(app.workspace).toBe(before);
    expect(app.phase.kind).toBe("ready");
  });

  it("keeps fallback titles for files that cannot be read in the background", async () => {
    const { storage, app } = setup();
    const read = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation((path) =>
      path === "api/deploy.md" ? Promise.reject(new StorageError("Io", "x")) : read(path),
    );
    await app.start();
    await app.settled();
    expect(app.summaries.has("api/deploy.md")).toBe(false);
    expect(app.summaries.has("api/sub/auth.md")).toBe(true);
  });

  it("stops reacting after dispose and after switching workspaces", async () => {
    const { storage, app } = await started();
    storage.addFolder("/other", {});
    const listener = storage.listenerCount;
    expect(listener).toBe(1);
    await app.openWorkspace("/other");
    expect(storage.listenerCount).toBe(1);
    app.dispose();
    expect(storage.listenerCount).toBe(0);
  });

  it("drops changes queued for a previous workspace", async () => {
    const { storage, app } = await started();
    const list = vi.spyOn(storage, "listFiles");
    storage.emitChange({ paths: [], rescan: true });
    app.dispose();
    await app.settled();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("AppState failures after subscribing", () => {
  it("stops watching when the listing fails", async () => {
    const { storage, app } = setup();
    vi.spyOn(storage, "listFiles").mockRejectedValueOnce(new StorageError("Io", "broken"));
    await app.start();
    expect(app.phase).toEqual({
      kind: "error",
      message: "The workspace could not be opened: broken",
    });
    expect(storage.listenerCount).toBe(0);
  });

  it("skips task lists without open tasks when selecting all tasks", async () => {
    const { app } = await started({
      files: { "inbox/tasks.md": "- [x] done", "api/tasks.md": "- [ ] open" },
    });
    app.selectFolder(ALL_TASKS);
    expect(app.item).toBe("api/tasks.md");
  });
});

describe("AppState change metadata", () => {
  function clocked() {
    let time = 1000;
    const storage = new MemoryStorage({
      folders: { [ROOT]: { ...files } },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
      now: () => time,
    });
    const app = new AppState(storage, { defer: (task) => task() });
    return { storage, app, tick: (ms: number) => (time += ms) };
  }

  it("refreshes modification times and sizes from the event without a listing", async () => {
    const { storage, app, tick } = clocked();
    await app.start();
    await app.settled();
    const list = vi.spyOn(storage, "listFiles");
    tick(60_000);
    storage.setExternal("api/deploy.md", "# Deploy v2");
    await app.settled();
    const note = app.workspace.projects[1]?.notes.find((entry) => entry.name === "deploy.md");
    expect(note).toMatchObject({ modified: 61_000, size: 11 });
    expect(app.summaries.get("api/deploy.md")?.title).toBe("Deploy v2");
    expect(list).not.toHaveBeenCalled();
  });

  it("adds new files from the event without a listing", async () => {
    const { storage, app } = await started();
    const list = vi.spyOn(storage, "listFiles");
    storage.setExternal("api/new.md", "# New");
    await app.settled();
    expect(app.workspace.projects[1]?.notes.map((note) => note.name)).toContain("new.md");
    expect(app.summaries.get("api/new.md")?.title).toBe("New");
    expect(list).not.toHaveBeenCalled();
  });

  it("updates the open note's age when it changes", async () => {
    const { storage, app, tick } = clocked();
    await app.start();
    await app.settled();
    tick(5000);
    storage.setExternal("inbox/tasks.md", "- [ ] new\n");
    await app.settled();
    await vi.waitFor(() =>
      expect(app.document).toMatchObject({ text: "- [ ] new\n", modified: 6000 }),
    );
  });

  it("skips events whose metadata did not change", async () => {
    const { storage, app } = await started();
    const read = vi.spyOn(storage, "readFile");
    storage.emitChange({ paths: ["api/deploy.md"] });
    await app.settled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("AppState workspace config reload", () => {
  it("re-applies ignore patterns when the config changes", async () => {
    const { storage, app } = await started();
    app.selectFolder("docs");
    await storage.writeFile(".kaido/config.json", '{ "version": 1, "ignore": ["docs"] }');
    await Promise.resolve();
    await app.settled();
    expect(app.workspace.projects.map((project) => project.name)).toEqual(["inbox", "api"]);
    expect(app.folder).toBe("inbox");
    expect(app.summaries.has("docs/guide.md")).toBe(false);
  });

  it("brings back files when patterns are removed and loads their summaries", async () => {
    const { storage, app } = await started({
      files: { ...files, ".kaido/config.json": '{ "version": 1, "ignore": ["docs"] }' },
    });
    expect(app.summaries.has("docs/guide.md")).toBe(false);
    storage.setExternal(".kaido/config.json", null);
    await app.settled();
    expect(app.workspace.projects.map((project) => project.name)).toContain("docs");
    expect(app.summaries.get("docs/guide.md")?.title).toBe("Guide");
  });

  it("reselects when the open note becomes ignored", async () => {
    const { storage, app } = await started();
    app.selectFolder("api");
    app.selectItem("api/sub/auth.md");
    storage.setExternal(".kaido/config.json", '{ "version": 1, "ignore": ["sub/"] }');
    await app.settled();
    expect(app.item).toBe("api/tasks.md");
  });

  it("surfaces warnings from an invalid config and clears them when fixed", async () => {
    const { storage, app } = await started();
    storage.setExternal(".kaido/config.json", '{ "version": 1, "ignore": "docs" }');
    await app.settled();
    expect(app.warnings[0]?.message).toMatch(/ignore: expected a list of strings/);
    expect(app.workspace.projects).toHaveLength(3);
    storage.setExternal(".kaido/config.json", '{ "version": 1, "ignore": [] }');
    await app.settled();
    expect(app.warnings).toEqual([]);
  });

  it("warns when the changed config cannot be read", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "readFile").mockRejectedValueOnce(new StorageError("PermissionDenied", "no"));
    storage.setExternal(".kaido/config.json", "{}");
    await app.settled();
    expect(app.warnings).toEqual([{ field: "", message: ".kaido/config.json: no" }]);
  });

  it("re-reads the config on a rescan", async () => {
    const { storage, app } = await started();
    storage.setExternal(".kaido/config.json", '{ "version": 1, "ignore": ["api"] }', false);
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    expect(app.workspace.projects.map((project) => project.name)).toEqual(["inbox", "docs"]);
  });

  it("drops a config reload for a previous workspace", async () => {
    const { storage, app } = await started();
    let release: () => void = () => undefined;
    const read = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementationOnce(
      (path) => new Promise((resolve) => (release = () => resolve(read(path)))),
    );
    storage.setExternal(".kaido/config.json", '{ "version": 1, "ignore": ["api"] }');
    await vi.waitFor(() => expect(storage.readFile).toHaveBeenCalled());
    app.dispose();
    release();
    await app.settled();
    expect(app.workspace.projects).toHaveLength(3);
  });
});

describe("AppState review fixes", () => {
  it("applies a change that arrives while the initial listing is pending", async () => {
    const { storage, app } = setup();
    const list = storage.listFiles.bind(storage);
    let release: () => void = () => undefined;
    vi.spyOn(storage, "listFiles").mockImplementationOnce(async () => {
      const files = await list();
      await new Promise<void>((resolve) => (release = resolve));
      return files;
    });
    const starting = app.start();
    await vi.waitFor(() => expect(storage.listFiles).toHaveBeenCalled());
    // The listing was taken before this file existed; the event must win.
    storage.setExternal("api/late.md", "# Late");
    release();
    await starting;
    await app.settled();
    expect(app.workspace.projects[1]?.notes.map((note) => note.name)).toContain("late.md");
    expect(app.summaries.get("api/late.md")?.title).toBe("Late");
  });

  it("queues a rescan behind the initial listing", async () => {
    const { storage, app } = setup();
    const list = storage.listFiles.bind(storage);
    let release: () => void = () => undefined;
    vi.spyOn(storage, "listFiles").mockImplementationOnce(async () => {
      const files = await list();
      await new Promise<void>((resolve) => (release = resolve));
      return files;
    });
    const starting = app.start();
    await vi.waitFor(() => expect(storage.listFiles).toHaveBeenCalledTimes(1));
    storage.setExternal("docs/guide.md", null, false);
    storage.emitChange({ paths: [], rescan: true });
    release();
    await starting;
    await app.settled();
    expect(app.workspace.projects.map((project) => project.name)).toEqual(["inbox", "api"]);
  });

  it("ignores an overtaken open without showing an error", async () => {
    const { storage, app } = setup({ settings: null });
    await app.start();
    vi.spyOn(storage, "openWorkspace").mockRejectedValueOnce(
      new StorageError("Superseded", "A newer workspace was opened."),
    );
    const phases: string[] = [];
    const first = app.openWorkspace("/slow").then(() => phases.push(app.phase.kind));
    await app.openWorkspace(ROOT);
    await first;
    expect(phases).not.toContain("error");
    expect(app.phase.kind).toBe("ready");
  });

  it("stays out of the error state when its own open is superseded", async () => {
    const { storage, app } = setup({ settings: null });
    await app.start();
    vi.spyOn(storage, "openWorkspace").mockRejectedValueOnce({
      kind: "Superseded",
      message: "A newer workspace was opened.",
    });
    await app.openWorkspace(ROOT);
    expect(app.phase.kind).not.toBe("error");
  });

  it("lets only the latest read of a document land", async () => {
    const { storage, app } = await started();
    const read = storage.readFile.bind(storage);
    let releaseOld: () => void = () => undefined;
    vi.spyOn(storage, "readFile").mockImplementationOnce(
      (path) =>
        new Promise(
          (resolve) =>
            (releaseOld = () => resolve(read(path).then(() => ({ contents: "old", hash: "x" })))),
        ),
    );
    app.selectItem("api/deploy.md");
    storage.setExternal("api/deploy.md", "# New");
    await app.settled();
    await vi.waitFor(() => expect(app.document).toMatchObject({ text: "# New" }));
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.document).toMatchObject({ text: "# New" });
  });

  it("re-reads the open note even when size and time did not change", async () => {
    const { storage, app } = await started();
    const before = files["inbox/tasks.md"] ?? "";
    const same = before.replace("one", "two");
    expect(same.length).toBe(before.length);
    storage.setExternal("inbox/tasks.md", same);
    await app.settled();
    await vi.waitFor(() => expect(app.document).toMatchObject({ text: same }));
  });

  it("shows when a note is too large to open", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "readFile").mockRejectedValueOnce(new StorageError("TooLarge", "big"));
    app.selectItem("api/deploy.md");
    await vi.waitFor(() =>
      expect(app.document).toEqual({ status: "too-large", path: "api/deploy.md" }),
    );
  });

  it.each([
    ["NotFound", "The workspace folder is no longer available. Changes on disk are not shown."],
    [
      "PermissionDenied",
      "Kaido can no longer read the workspace folder. Changes on disk are not shown.",
    ],
    ["Io", "The workspace could not be refreshed: boom"],
  ] as const)("reports a %s listing failure and clears it on success", async (kind, message) => {
    const { storage, app } = await started();
    vi.spyOn(storage, "listFiles").mockRejectedValueOnce(new StorageError(kind, "boom"));
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    expect(app.notice).toBe(message);
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    expect(app.notice).toBeNull();
  });

  it("reads the open note only once after an update", async () => {
    const { storage, app } = await started();
    const read = vi.spyOn(storage, "readFile");
    storage.setExternal("inbox/tasks.md", "- [ ] changed\n");
    await app.settled();
    expect(read.mock.calls.filter(([path]) => path === "inbox/tasks.md")).toHaveLength(1);
    expect(app.summaries.get("inbox/tasks.md")?.openTasks).toBe(1);
  });

  it("reads the open note only once on startup", async () => {
    const { storage, app } = setup();
    const read = vi.spyOn(storage, "readFile");
    await app.start();
    await app.settled();
    expect(read.mock.calls.filter(([path]) => path === "inbox/tasks.md")).toHaveLength(1);
  });
});

describe("AppState background summaries", () => {
  it("publishes summaries at most once per scheduled frame", async () => {
    const frames: (() => void)[] = [];
    const storage = new MemoryStorage({
      folders: { [ROOT]: { ...files } },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
    });
    const app = new AppState(storage, {
      defer: (task) => task(),
      schedule: (task) => frames.push(task),
      concurrency: 1,
    });
    await app.start();
    await vi.waitFor(() => expect(frames.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Several files were read, but only one publish is pending.
    expect(frames).toHaveLength(1);
    const before = app.summaries;
    frames.shift()?.();
    expect(app.summaries).not.toBe(before);
    expect(app.summaries.size).toBeGreaterThan(1);
  });

  it("counts tasks only in task lists", async () => {
    const { app } = await started();
    expect(app.summaries.get("api/deploy.md")?.openTasks).toBe(0);
    expect(app.summaries.get("api/tasks.md")?.openTasks).toBe(1);
  });

  it("skips reading files larger than 1 MiB", async () => {
    const big = `# Big\n${"x".repeat(1024 * 1024)}`;
    const { storage, app } = setup({ files: { ...files, "api/log.md": big } });
    const read = vi.spyOn(storage, "readFile");
    await app.start();
    await app.settled();
    expect(read.mock.calls.some(([path]) => path === "api/log.md")).toBe(false);
    expect(app.summaries.get("api/log.md")).toEqual({ title: "log", openTasks: 0 });
  });

  it("does not hold up change events while summaries load", async () => {
    const { storage, app } = setup();
    const read = storage.readFile.bind(storage);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(storage, "readFile").mockImplementation(async (path) => {
      if (path === "docs/guide.md") await gate;
      return read(path);
    });
    await app.start();
    storage.setExternal("api/new.md", "# New");
    await vi.waitFor(() =>
      expect(app.workspace.projects[1]?.notes.map((note) => note.name)).toContain("new.md"),
    );
    release();
    await app.settled();
    expect(app.summaries.get("docs/guide.md")?.title).toBe("Guide");
  });

  it("stops background reads for a previous workspace", async () => {
    const { storage, app } = setup();
    storage.addFolder("/other", { "other/a.md": "# A" });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (path) => {
      if (path === "api/deploy.md") await gate;
      return read(path);
    });
    await app.start();
    await app.openWorkspace("/other");
    release();
    await app.settled();
    expect(app.summaries.has("api/deploy.md")).toBe(false);
    expect(app.summaries.get("other/a.md")?.title).toBe("A");
  });
});

describe("AppState follow-up fixes", () => {
  it("retries a failed rescan on the next notification and only then clears the notice", async () => {
    const { storage, app } = await started();
    const list = storage.listFiles.bind(storage);
    const spy = vi
      .spyOn(storage, "listFiles")
      .mockRejectedValueOnce(new StorageError("PermissionDenied", "no"))
      .mockRejectedValueOnce(new StorageError("PermissionDenied", "no"));
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    expect(app.notice).toMatch(/can no longer read/);

    // Missed while the listing failed: only a rescan can find it.
    storage.setExternal("docs/missed.md", "# Missed", false);
    storage.setExternal("api/deploy.md", "# Deploy again");
    await app.settled();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(app.notice).toMatch(/can no longer read/);

    spy.mockImplementation(list);
    storage.setExternal("api/deploy.md", "# Deploy third");
    await app.settled();
    expect(app.notice).toBeNull();
    expect(app.workspace.projects[2]?.notes.map((note) => note.name)).toContain("missed.md");
    expect(app.summaries.get("api/deploy.md")?.title).toBe("Deploy third");

    // Back to normal: deltas no longer list the workspace.
    storage.setExternal("api/deploy.md", "# Deploy fourth");
    await app.settled();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("forgets a pending rescan when another workspace opens", async () => {
    const { storage, app } = await started();
    storage.addFolder("/other", { "other/a.md": "# A" });
    vi.spyOn(storage, "listFiles").mockRejectedValueOnce(new StorageError("NotFound", "gone"));
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    expect(app.notice).not.toBeNull();
    await app.openWorkspace("/other");
    await app.settled();
    expect(app.notice).toBeNull();
    const list = vi.spyOn(storage, "listFiles");
    list.mockClear();
    storage.setExternal("other/b.md", "# B");
    await app.settled();
    expect(list).not.toHaveBeenCalled();
  });

  it("warns once that settings cannot be saved, across workspace switches", async () => {
    const { storage, app } = await started({ settings: "not json", pick: ROOT });
    storage.addFolder("/other", {});
    await app.pickWorkspace();
    await app.openWorkspace("/other");
    await app.openWorkspace(ROOT);
    const notSaved = app.warnings.filter((warning) =>
      warning.message.startsWith("settings.json was left unchanged"),
    );
    expect(notSaved).toHaveLength(1);
  });
});
