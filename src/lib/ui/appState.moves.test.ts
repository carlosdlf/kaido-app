import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_TASKS } from "$lib/core/views";
import { findProject, findProjectByKey } from "$lib/core/workspace";
import { MemoryStorage, StorageError } from "$lib/storage";
import {
  AppState,
  archivedExistsMessage,
  archivedProjectMessage,
  MOVE_IGNORED,
  movedNoteMessage,
  movedTaskMessage,
  noteExistsThereMessage,
  projectActionFailedMessage,
  projectExistsMessage,
  projectTrashedMessage,
  renamedProjectMessage,
  TASK_CHANGED,
  TASKS_RESERVED,
  unarchivedProjectMessage,
  unarchiveTakenMessage,
  unsavedMoveMessage,
} from "./appState.svelte";

const ROOT = "/notes";
const NOW = new Date(2026, 9, 9, 9, 5).getTime();

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] read [spec](../api/spec.md)\n- [ ] other\n",
  "inbox/idea.md": "# Idea\n",
  "api/tasks.md":
    "- [ ] ship [spec](spec.md)\n  detail [d](docs/deep.md)\n  - [ ] sub\n- [ ] [i](../inbox/idea.md)\n",
  "api/spec.md": "# Spec\nbody",
  "api/docs/deep.md": "# Deep\n",
  "web/tasks.md": "- [ ] w\n",
  "_archive/old/tasks.md": "- [ ] [s](../../api/spec.md)\n",
  "_archive/old/n.md": "# Old note\n",
};

async function started(extra: Record<string, string> = {}, settings: object = {}) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...files, ...extra } },
    settings: JSON.stringify({ version: 1, workspace: ROOT, ...settings }),
  });
  const app = new AppState(storage, { defer: (task) => task(), schedule: (task) => task() });
  await app.start();
  await app.settled();
  return { storage, app };
}

async function wait(app: AppState, ms = 600) {
  await vi.advanceTimersByTimeAsync(ms);
  await app.settled();
  await vi.advanceTimersByTimeAsync(0);
}

const read = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;
const exists = (storage: MemoryStorage, path: string) =>
  storage.folders.get(ROOT)?.has(path) ?? false;
const messages = (app: AppState) => app.toasts.map((toast) => toast.message);
const conflictCopies = (storage: MemoryStorage) =>
  [...(storage.folders.get(ROOT)?.keys() ?? [])].filter((path) => path.includes("(conflict"));
const lastToast = (app: AppState) => app.toasts.at(-1)?.id ?? -1;

async function open(app: AppState, path: string) {
  app.selectItem(path);
  await app.settled();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AppState.moveNote", () => {
  it("moves the open note with its edits, updates links and keeps it open", async () => {
    const { storage, app } = await started();
    app.selectFolder("api");
    await open(app, "api/spec.md");
    app.edit("api/spec.md", () => "# Spec\nedited");
    const document = app.document;

    await expect(app.moveNote("api/spec.md", "web")).resolves.toEqual({
      kind: "moved",
      path: "web/spec.md",
    });
    expect(await read(storage, "web/spec.md")).toBe("# Spec\nedited");
    expect(exists(storage, "api/spec.md")).toBe(false);
    expect(app.item).toBe("web/spec.md");
    expect(app.folder).toBe("web");
    expect(app.document).not.toBe(document);
    expect(app.document).toMatchObject({ path: "web/spec.md", text: "# Spec\nedited" });
    expect(app.editorChanges.at(-1)).toEqual({
      kind: "rename",
      from: "api/spec.md",
      to: "web/spec.md",
    });
    expect(messages(app)).toEqual([movedNoteMessage("spec.md", "web")]);

    // Links from every list point at the new place, the rest of each list unchanged.
    await wait(app);
    expect(await read(storage, "inbox/tasks.md")).toBe(
      "- [ ] read [spec](../web/spec.md)\n- [ ] other\n",
    );
    expect(await read(storage, "api/tasks.md")).toBe(
      files["api/tasks.md"]?.replace("[spec](spec.md)", "[spec](../web/spec.md)"),
    );
    expect(await read(storage, "_archive/old/tasks.md")).toBe("- [ ] [s](../../web/spec.md)\n");

    // The watcher's report changes nothing.
    storage.emitChange({ paths: ["api/spec.md", "web/spec.md"] });
    await wait(app);
    expect(app.document).toMatchObject({ path: "web/spec.md", text: "# Spec\nedited" });
    expect(conflictCopies(storage)).toEqual([]);
  });

  it("undoes the move and the link edits", async () => {
    const { storage, app } = await started();
    await app.moveNote("api/spec.md", "inbox");
    await wait(app);
    expect(await read(storage, "inbox/tasks.md")).toContain("[spec](spec.md)");
    expect(app.latestUndo).toBe(lastToast(app));
    await expect(app.undoDelete(lastToast(app))).resolves.toBe("note");
    await wait(app);
    expect(exists(storage, "api/spec.md")).toBe(true);
    expect(exists(storage, "inbox/spec.md")).toBe(false);
    expect(await read(storage, "inbox/tasks.md")).toBe(files["inbox/tasks.md"]);
    expect(await read(storage, "api/tasks.md")).toBe(files["api/tasks.md"]);
    expect(app.toasts).toEqual([]);
  });

  it("moves into subfolders and the workspace root", async () => {
    const { storage, app } = await started();
    await expect(app.moveNote("inbox/idea.md", "api/docs")).resolves.toMatchObject({
      path: "api/docs/idea.md",
    });
    expect(app.item).toBe("inbox/tasks.md");
    expect(app.folder).toBe("inbox");
    await expect(app.moveNote("api/docs/idea.md", "")).resolves.toMatchObject({
      path: "idea.md",
    });
    expect(exists(storage, "idea.md")).toBe(true);
    await wait(app);
    expect(await read(storage, "api/tasks.md")).toContain("[i](../idea.md)");
    await expect(app.moveNote("idea.md", "")).resolves.toEqual({ kind: "moved", path: "idea.md" });
  });

  it("refuses names taken there, ignored folders and reserved names", async () => {
    const { storage, app } = await started({
      "web/Idea.md": "",
      ".kaido/config.json": '{ "version": 1, "ignore": ["hidden"] }',
    });
    await expect(app.moveNote("inbox/idea.md", "web")).resolves.toEqual({
      kind: "invalid",
      reason: noteExistsThereMessage("idea.md"),
    });
    await expect(app.moveNote("inbox/idea.md", "hidden")).resolves.toEqual({
      kind: "invalid",
      reason: MOVE_IGNORED,
    });
    await expect(app.moveNote("inbox/gone.md", "web")).resolves.toMatchObject({
      kind: "invalid",
    });
    storage.setExternal("api/idea.md", "taken", false);
    await expect(app.moveNote("inbox/idea.md", "api")).resolves.toEqual({
      kind: "invalid",
      reason: noteExistsThereMessage("idea.md"),
    });
    vi.spyOn(storage, "moveFile").mockRejectedValueOnce(new StorageError("Io", "disk full"));
    await expect(app.moveNote("inbox/idea.md", "api/docs")).resolves.toEqual({ kind: "failed" });
    expect(messages(app)).toContain("idea.md could not be moved: disk full");
    expect(TASKS_RESERVED).toContain("tasks.md");
  });

  it("refuses a move to tasks.md of a project", async () => {
    const { app } = await started({ "api/notes/tasks.md": "", "empty/n.md": "" });
    await expect(app.moveNote("api/notes/tasks.md", "web")).resolves.toMatchObject({
      kind: "invalid",
    });
    await expect(app.moveNote("api/notes/tasks.md", "empty")).resolves.toEqual({
      kind: "invalid",
      reason: TASKS_RESERVED,
    });
  });
});

describe("link updates after a note rename", () => {
  it("rewrites links to the renamed note", async () => {
    const { storage, app } = await started();
    await app.renameNote("api/spec.md", "design");
    await wait(app);
    expect(await read(storage, "inbox/tasks.md")).toContain("[spec](../api/design.md)");
    expect(await read(storage, "api/tasks.md")).toContain("[spec](design.md)");
  });
});

describe("AppState.moveTaskToProject", () => {
  it("moves the whole block with rewritten links, and undo restores both lists", async () => {
    const { storage, app } = await started();
    const ref = { line: 0, raw: "- [ ] ship [spec](spec.md)" };
    await expect(app.moveTaskToProject("api/tasks.md", ref, "web")).resolves.toEqual({
      kind: "moved",
      path: "web/tasks.md",
    });
    expect(messages(app)).toEqual([movedTaskMessage("web")]);
    await wait(app);
    expect(await read(storage, "web/tasks.md")).toBe(
      "- [ ] w\n- [ ] ship [spec](../api/spec.md)\n  detail [d](../api/docs/deep.md)\n  - [ ] sub\n",
    );
    expect(await read(storage, "api/tasks.md")).toBe("- [ ] [i](../inbox/idea.md)\n");

    expect(app.latestUndo).toBe(lastToast(app));
    await expect(app.undoDelete(lastToast(app))).resolves.toBe("task");
    await wait(app);
    expect(await read(storage, "web/tasks.md")).toBe("- [ ] w\n");
    expect(await read(storage, "api/tasks.md")).toBe(files["api/tasks.md"]);
    expect(app.taskFocus).toMatchObject({ path: "api/tasks.md", line: 0 });
  });

  it("creates the target list when the project has none", async () => {
    const { storage, app } = await started({ "docs/readme.md": "# Readme\n" });
    app.selectItem(ALL_TASKS);
    await app.moveTaskToProject("inbox/tasks.md", { line: 1, raw: "- [ ] other" }, "docs");
    await wait(app);
    expect(await read(storage, "docs/tasks.md")).toBe("- [ ] other\n");
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] read [spec](../api/spec.md)\n");
  });

  it("refuses changed tasks, subtasks, missing projects and its own list", async () => {
    const { app } = await started();
    await expect(
      app.moveTaskToProject("api/tasks.md", { line: 0, raw: "- [ ] gone" }, "web"),
    ).resolves.toEqual({ kind: "failed" });
    expect(messages(app)).toEqual([TASK_CHANGED]);
    await expect(
      app.moveTaskToProject("api/tasks.md", { line: 2, raw: "  - [ ] sub" }, "web"),
    ).resolves.toEqual({ kind: "failed" });
    await expect(
      app.moveTaskToProject("api/tasks.md", { line: 0, raw: "x" }, "nowhere"),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      app.moveTaskToProject("api/tasks.md", { line: 0, raw: "x" }, "api"),
    ).resolves.toEqual({ kind: "moved", path: "api/tasks.md" });
  });

  it("does not undo when the moved task changed in its new list", async () => {
    const { app } = await started();
    await app.moveTaskToProject("inbox/tasks.md", { line: 1, raw: "- [ ] other" }, "web");
    const id = lastToast(app);
    app.editTask("web/tasks.md", { line: 1, raw: "- [ ] other" }, "changed");
    await app.undoDelete(id);
    expect(messages(app)).toContain(TASK_CHANGED);
  });
});

describe("AppState project rename", () => {
  it("saves first, then remaps sessions, selection, search, hide done and links", async () => {
    const { storage, app } = await started({}, { hideDone: { [ROOT]: ["api/tasks.md"] } });
    app.selectFolder("api");
    await open(app, "api/spec.md");
    app.edit("api/spec.md", () => "# Spec\nunsaved");
    app.search("");

    await expect(app.renameProject("api", " backend ")).resolves.toEqual({
      kind: "renamed",
      path: "backend",
    });
    expect(await read(storage, "backend/spec.md")).toBe("# Spec\nunsaved");
    expect(app.folder).toBe("backend");
    expect(app.item).toBe("backend/spec.md");
    expect(app.document).toMatchObject({ path: "backend/spec.md", text: "# Spec\nunsaved" });
    expect(app.saveStatus?.kind).toBe("saved");
    expect(app.editorChanges).toContainEqual({
      kind: "rename",
      from: "api/spec.md",
      to: "backend/spec.md",
    });
    expect([...app.hideDone]).toEqual(["backend/tasks.md"]);
    expect(findProject(app.workspace, "api")).toBeUndefined();
    expect(app.summaries.get("backend/spec.md")?.title).toBe("Spec");
    expect(app.taskDocs.has("backend/tasks.md")).toBe(true);
    expect(app.search("spec").map((result) => result.path)).toContain("backend/spec.md");
    expect(app.search("").map((result) => result.path)).toContain("backend/spec.md");
    expect(messages(app)).toEqual([renamedProjectMessage("api", "backend")]);

    // The watcher's rescan finds the app's own move: no reload, no conflict copy.
    const document = app.document;
    await wait(app);
    expect(app.document).toBe(document);
    expect(conflictCopies(storage)).toEqual([]);
    expect(await read(storage, "inbox/tasks.md")).toContain("[spec](../backend/spec.md)");
    // The project's own list keeps its relative links.
    expect(await read(storage, "backend/tasks.md")).toBe(files["api/tasks.md"]);
    await app.settingsSaved();
    expect(JSON.parse(storage.settings ?? "{}").hideDone).toEqual({
      [ROOT]: ["backend/tasks.md"],
    });

    // Later edits go to the new path.
    app.edit("backend/spec.md", () => "# Spec\nlater");
    await wait(app);
    expect(await read(storage, "backend/spec.md")).toBe("# Spec\nlater");
    expect(exists(storage, "api/spec.md")).toBe(false);
  });

  it("undoes a rename from the toast", async () => {
    const { storage, app } = await started();
    await app.renameProject("api", "backend");
    await wait(app);
    expect(app.latestProjectUndo).toBe(lastToast(app));
    expect(app.latestUndo).toBeNull();
    await expect(app.runToastAction(lastToast(app))).resolves.toBe("project");
    await wait(app);
    expect(exists(storage, "api/spec.md")).toBe(true);
    expect(await read(storage, "inbox/tasks.md")).toBe(files["inbox/tasks.md"]);
    expect(app.latestProjectUndo).toBeNull();
  });

  it("refuses invalid and taken names, and an unchanged name does nothing", async () => {
    const { storage, app } = await started();
    const rename = vi.spyOn(storage, "renameFolder");
    await expect(app.renameProject("api", "api")).resolves.toEqual({
      kind: "renamed",
      path: "api",
    });
    await expect(app.renameProject("api", "WEB")).resolves.toMatchObject({ kind: "invalid" });
    await expect(app.renameProject("api", "_x")).resolves.toMatchObject({ kind: "invalid" });
    expect(rename).not.toHaveBeenCalled();
    storage.setExternal("taken/x.png", "", false);
    await expect(app.renameProject("api", "taken")).resolves.toEqual({
      kind: "invalid",
      reason: projectExistsMessage("taken"),
    });
    rename.mockRejectedValueOnce(new StorageError("PermissionDenied", "denied"));
    await expect(app.renameProject("api", "b")).resolves.toEqual({ kind: "failed" });
    expect(messages(app)).toEqual([projectActionFailedMessage("api", "renamed", "denied")]);
  });

  it("allows a case-only rename and renames archived projects", async () => {
    const { storage, app } = await started();
    await expect(app.renameProject("api", "API")).resolves.toEqual({
      kind: "renamed",
      path: "API",
    });
    await expect(app.renameProject("_archive/old", "older")).resolves.toEqual({
      kind: "renamed",
      path: "_archive/older",
    });
    expect(exists(storage, "_archive/older/n.md")).toBe(true);
  });

  it("refuses names hidden by the ignore patterns", async () => {
    const { app } = await started({
      ".kaido/config.json": '{ "version": 1, "ignore": ["secret"] }',
    });
    await expect(app.renameProject("api", "secret")).resolves.toMatchObject({ kind: "invalid" });
  });

  it("aborts when pending edits cannot be saved", async () => {
    const { storage, app } = await started();
    app.selectFolder("api");
    await open(app, "api/spec.md");
    storage.setReadOnly("api/spec.md");
    app.edit("api/spec.md", () => "stuck");
    await expect(app.renameProject("api", "backend")).resolves.toEqual({ kind: "failed" });
    expect(messages(app)).toContain(unsavedMoveMessage(["api/spec.md"]));
    expect(exists(storage, "api/spec.md")).toBe(true);
    expect(app.item).toBe("api/spec.md");
  });
});

describe("AppState archive and unarchive", () => {
  it("archives a project, fixing links into it and out of it, and undoes it", async () => {
    const { storage, app } = await started();
    await app.archiveProject("api");
    expect(messages(app)).toEqual([archivedProjectMessage("api")]);
    expect(findProjectByKey(app.workspace, "_archive/api")).toBeDefined();
    expect(app.search("spec").map((result) => result.path)).not.toContain("_archive/api/spec.md");
    await wait(app);
    expect(await read(storage, "inbox/tasks.md")).toContain("[spec](../_archive/api/spec.md)");
    expect(await read(storage, "_archive/api/tasks.md")).toContain("[i](../../inbox/idea.md)");
    expect(await read(storage, "_archive/api/tasks.md")).toContain("[spec](spec.md)");

    await app.undoDelete(lastToast(app));
    await wait(app);
    expect(await read(storage, "inbox/tasks.md")).toBe(files["inbox/tasks.md"]);
    expect(await read(storage, "api/tasks.md")).toBe(files["api/tasks.md"]);
    expect(app.search("spec").map((result) => result.path)).toContain("api/spec.md");
  });

  it("keeps the selection on an archived project and opens its notes", async () => {
    const { app } = await started();
    app.selectFolder("web");
    await app.archiveProject("web");
    expect(app.folder).toBe("_archive/web");
    expect(app.item).toBe("_archive/web/tasks.md");
    app.openNote("_archive/old/n.md");
    expect(app.folder).toBe("_archive/old");
    await wait(app);
    expect(app.folder).toBe("_archive/old");
  });

  it("refuses to archive over an archived project of the same name", async () => {
    const { storage, app } = await started({ "old/x.md": "" });
    await app.archiveProject("old");
    expect(messages(app)).toEqual([archivedExistsMessage("old")]);
    await app.archiveProject("inbox");
    await app.archiveProject("missing");
    vi.spyOn(storage, "renameFolder").mockRejectedValueOnce(new StorageError("Conflict", "x"));
    await app.archiveProject("web");
    expect(messages(app).at(-1)).toBe(archivedExistsMessage("web"));
  });

  it("unarchives, unless an active project has that name", async () => {
    const { storage, app } = await started({ "_archive/web/x.md": "" });
    await app.unarchiveProject("web");
    expect(messages(app)).toEqual([unarchiveTakenMessage("web", "web")]);
    await app.unarchiveProject("old");
    expect(messages(app).at(-1)).toBe(unarchivedProjectMessage("old"));
    await wait(app);
    expect(await read(storage, "old/tasks.md")).toBe("- [ ] [s](../api/spec.md)\n");
    expect(app.search("old note").map((result) => result.path)).toContain("old/n.md");
    await app.unarchiveProject("missing");
  });
});

describe("AppState.deleteProject", () => {
  it("moves the folder to the trash and selects the inbox", async () => {
    const { storage, app } = await started({}, { hideDone: { [ROOT]: ["web/tasks.md"] } });
    app.selectFolder("web");
    app.toggleTask("web/tasks.md", { line: 0, raw: "- [ ] w" });
    expect(app.projectContents("web")).toEqual({ notes: 0, tasks: 1 });
    await app.deleteProject("web");
    expect(storage.trash.map((entry) => entry.path)).toEqual(["web/tasks.md"]);
    expect(storage.trash[0]?.contents).toBe("- [x] w\n");
    expect(app.folder).toBe("inbox");
    expect([...app.hideDone]).toEqual([]);
    expect(app.editorChanges).toContainEqual({ kind: "forget", path: "web/tasks.md" });
    expect(messages(app)).toEqual([projectTrashedMessage("web")]);
    await wait(app);
    expect(findProject(app.workspace, "web")).toBeUndefined();
    expect(conflictCopies(storage)).toEqual([]);
    expect(exists(storage, "web/tasks.md")).toBe(false);
  });

  it("deletes archived projects and drops undo toasts inside", async () => {
    const { storage, app } = await started();
    await app.moveNote("inbox/idea.md", "web");
    await app.deleteProject("web");
    expect(app.latestUndo).toBeNull();
    await app.deleteProject("_archive/old");
    expect(exists(storage, "_archive/old/n.md")).toBe(false);
    expect(app.projectContents("_archive/old")).toEqual({ notes: 0, tasks: 0 });
  });

  it("reports failures and keeps everything", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "deleteFolder").mockRejectedValueOnce(new StorageError("Io", "no trash"));
    await app.deleteProject("api");
    expect(messages(app)).toEqual([projectActionFailedMessage("api", "deleted", "no trash")]);
    expect(findProject(app.workspace, "api")).toBeDefined();
    await app.deleteProject("inbox");
    expect(exists(storage, "inbox/tasks.md")).toBe(true);
  });

  it("refuses while edits inside cannot be saved", async () => {
    const { storage, app } = await started();
    app.selectFolder("api");
    await open(app, "api/spec.md");
    storage.setReadOnly("api/spec.md");
    app.edit("api/spec.md", () => "stuck");
    await app.deleteProject("api");
    expect(messages(app)).toContain(unsavedMoveMessage(["api/spec.md"]));
    expect(exists(storage, "api/spec.md")).toBe(true);
  });
});

describe("moves: edge cases", () => {
  it("does nothing before a workspace is open", async () => {
    const app = new AppState(new MemoryStorage({ settings: null }));
    await app.start();
    await expect(app.moveNote("a/x.md", "b")).resolves.toEqual({ kind: "failed" });
    await expect(app.moveTaskToProject("a/tasks.md", { line: 0, raw: "x" }, "b")).resolves.toEqual({
      kind: "failed",
    });
    await expect(app.renameProject("a", "b")).resolves.toEqual({ kind: "failed" });
    await app.archiveProject("a");
    await app.unarchiveProject("a");
    await app.deleteProject("a");
    expect(app.projectContents("a")).toEqual({ notes: 0, tasks: 0 });
    expect(app.latestProjectUndo).toBeNull();
  });

  it("reads a target list that was not read yet, and reports lists it cannot use", async () => {
    const { storage, app } = await started({
      "big/tasks.md": `- [ ] x\n${"a".repeat(1024 * 1024)}`,
      ".kaido/config.json": '{ "version": 1, "ignore": ["hidden/tasks.md"] }',
      "hidden/n.md": "",
    });
    const ref = { line: 1, raw: "- [ ] other" };
    await expect(app.moveTaskToProject("inbox/tasks.md", ref, "big")).resolves.toMatchObject({
      kind: "invalid",
    });
    await expect(app.moveTaskToProject("inbox/tasks.md", ref, "hidden")).resolves.toMatchObject({
      kind: "invalid",
    });
    // A list changed on disk and not read again yet is read first.
    storage.setExternal("web/tasks.md", "- [ ] w2\n", false);
    await app.settled();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Conflict", "x"));
    await expect(app.moveTaskToProject("inbox/tasks.md", ref, "hidden2")).resolves.toMatchObject({
      kind: "invalid",
    });
  });

  it("reports a target list that appeared or cannot be created or read", async () => {
    const { storage, app } = await started({ "docs/n.md": "", "docs2/n.md": "" });
    const ref = { line: 1, raw: "- [ ] other" };
    const write = vi.spyOn(storage, "writeFile");
    write.mockRejectedValueOnce(new StorageError("Conflict", "exists"));
    await expect(app.moveTaskToProject("inbox/tasks.md", ref, "docs")).resolves.toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("just created on disk"),
    });
    write.mockRejectedValueOnce(new StorageError("PermissionDenied", "denied"));
    await expect(app.moveTaskToProject("inbox/tasks.md", ref, "docs2")).resolves.toMatchObject({
      reason: expect.stringContaining("denied"),
    });
  });

  it("reads a list not read yet before moving a task into it", async () => {
    const storage = new MemoryStorage({
      folders: { [ROOT]: { ...files } },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
    });
    // Background reads never run, so nothing is read before the move.
    const app = new AppState(storage, { defer: () => undefined, schedule: (task) => task() });
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    const reads = vi.spyOn(storage, "readFile");
    reads.mockRejectedValueOnce(new StorageError("Io", "unreadable"));
    const ref = { line: 1, raw: "- [ ] other" };
    await expect(app.moveTaskToProject("inbox/tasks.md", ref, "web")).resolves.toMatchObject({
      reason: expect.stringContaining("unreadable"),
    });
    await expect(app.moveTaskToProject("inbox/tasks.md", ref, "web")).resolves.toMatchObject({
      kind: "moved",
    });
    await app.flush();
    expect(await read(storage, "web/tasks.md")).toBe("- [ ] w\n- [ ] other\n");
  });

  it("drops undo toasts of another workspace", async () => {
    const { storage, app } = await started();
    storage.addFolder("/other", { "inbox/x.md": "" });
    await app.moveNote("inbox/idea.md", "web");
    const id = lastToast(app);
    await app.renameProject("api", "backend");
    await wait(app);
    await app.openWorkspace("/other");
    await app.settled();
    await expect(app.undoDelete(id)).resolves.toBeNull();
    expect(app.latestProjectUndo).toBeNull();
  });

  it("reports undo moves that are no longer possible", async () => {
    const { storage, app } = await started();
    await app.moveNote("inbox/idea.md", "web");
    const noteUndo = lastToast(app);
    storage.setExternal("inbox/idea.md", "taken");
    await app.settled();
    await app.undoDelete(noteUndo);
    expect(messages(app)).toContain(noteExistsThereMessage("idea.md"));

    await app.renameProject("web", "site");
    const folderUndo = lastToast(app);
    storage.setExternal("web/x.md", "");
    await app.settled();
    await app.undoDelete(folderUndo);
    expect(messages(app)).toContain(projectExistsMessage("web"));
  });

  it("keeps undo toasts and requests pointing at moved files", async () => {
    const { storage, app } = await started();
    app.selectFolder("api");
    await app.deleteNote("api/docs/deep.md");
    const noteUndo = lastToast(app);
    app.deleteTask("api/tasks.md", { line: 0, raw: "- [ ] ship [spec](spec.md)" });
    const taskUndo = lastToast(app);
    await app.moveTaskToProject("inbox/tasks.md", { line: 1, raw: "- [ ] other" }, "api");
    const moveUndo = lastToast(app);
    app.openSearchResult({
      kind: "task",
      id: "x",
      path: "api/tasks.md",
      title: "",
      titleRanges: [],
      line: 0,
      raw: "- [ ] [i](../inbox/idea.md)",
    });
    await app.renameProject("api", "backend");
    expect(app.taskFocus?.path).toBe("backend/tasks.md");
    await app.undoDelete(noteUndo);
    expect(exists(storage, "backend/docs/deep.md")).toBe(true);
    await app.undoDelete(moveUndo);
    await app.undoDelete(taskUndo);
    await wait(app);
    expect(await read(storage, "backend/tasks.md")).toContain("- [ ] ship");
    expect(await read(storage, "inbox/tasks.md")).toContain("- [ ] other");
  });

  it("drops undo toasts of files in a deleted project", async () => {
    const { app } = await started();
    await app.deleteNote("web/tasks.md").catch(() => undefined);
    app.deleteTask("web/tasks.md", { line: 0, raw: "- [ ] w" });
    await app.deleteNote("api/spec.md");
    await app.deleteProject("api");
    await app.deleteProject("web");
    expect(app.latestUndo).toBeNull();
  });

  it("moves the revealed line of the editor along with its note", async () => {
    const { app } = await started();
    app.openSearchResult({
      kind: "note",
      id: "api/spec.md",
      path: "api/spec.md",
      title: "Spec",
      titleRanges: [],
      line: 1,
    });
    expect(app.editorReveal?.path).toBe("api/spec.md");
    await app.archiveProject("api");
    expect(app.editorReveal?.path).toBe("_archive/api/spec.md");
  });

  it("does not undo a task move whose list went away", async () => {
    const { storage, app } = await started();
    await app.moveTaskToProject("inbox/tasks.md", { line: 1, raw: "- [ ] other" }, "web");
    const id = lastToast(app);
    await wait(app);
    storage.setExternal("inbox/tasks.md", null);
    await wait(app);
    await app.undoDelete(id);
    expect(messages(app).at(-1)).toMatch(/not restored|changed/);
  });
});
