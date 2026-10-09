import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findProject } from "$lib/core/workspace";
import { MemoryStorage, StorageError } from "$lib/storage";
import {
  AppState,
  deleteConflictMessage,
  deletedMessage,
  deleteFailedMessage,
  NAME_IGNORED,
  nameTakenMessage,
  NOTE_GONE,
  renameFailedMessage,
  restoreFailedMessage,
  restoreTakenMessage,
} from "./appState.svelte";

const ROOT = "/notes";
const OTHER = "/other";
const NOW = new Date(2026, 9, 8, 9, 5).getTime();

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] one\n",
  "inbox/alpha.md": "# Alpha\nbody",
  "inbox/beta.md": "# Beta\n",
  "inbox/gamma.md": "no heading",
  "api/deploy.md": "# Deploy\n",
};

async function started(extra: Record<string, string> = {}) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...files, ...extra }, [OTHER]: { "inbox/other.md": "# Other" } },
    settings: JSON.stringify({ version: 1, workspace: ROOT }),
  });
  const app = new AppState(storage, { defer: (task) => task(), schedule: (task) => task() });
  await app.start();
  await app.settled();
  return { storage, app };
}

/** Lets timers fire and all resulting work finish. */
async function wait(app: AppState, ms = 500) {
  await vi.advanceTimersByTimeAsync(ms);
  await app.settled();
  await vi.advanceTimersByTimeAsync(0);
}

const notePaths = (app: AppState, project = "inbox") =>
  findProject(app.workspace, project)?.notes.map((note) => note.path) ?? [];
const read = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;
const exists = (storage: MemoryStorage, path: string) =>
  storage.folders.get(ROOT)?.has(path) ?? false;
const messages = (app: AppState) => app.toasts.map((toast) => toast.message);
const conflictCopies = (storage: MemoryStorage) =>
  [...(storage.folders.get(ROOT)?.keys() ?? [])].filter((path) => path.includes("(conflict"));

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

describe("AppState.renameNote", () => {
  it("renames a note that is not open and keeps the selection", async () => {
    const { storage, app } = await started();
    expect(app.item).toBe("inbox/tasks.md");
    await expect(app.renameNote("inbox/gamma.md", "  zeta ")).resolves.toEqual({
      kind: "renamed",
      path: "inbox/zeta.md",
    });
    expect(exists(storage, "inbox/gamma.md")).toBe(false);
    expect(await read(storage, "inbox/zeta.md")).toBe("no heading");
    expect(notePaths(app)).toEqual(["inbox/alpha.md", "inbox/beta.md", "inbox/zeta.md"]);
    expect(app.item).toBe("inbox/tasks.md");
    await app.settled();
    // The title came from the file name and is read again.
    expect(app.summaries.get("inbox/zeta.md")?.title).toBe("zeta");
    expect(app.summaries.has("inbox/gamma.md")).toBe(false);
    expect(app.editorChanges).toEqual([
      { kind: "rename", from: "inbox/gamma.md", to: "inbox/zeta.md" },
    ]);
    expect(app.toasts).toEqual([]);
  });

  it("rebinds the open note with pending edits, without a reload or conflict copy", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/alpha.md");
    app.edit("inbox/alpha.md", () => "# Alpha\nedited");
    expect(app.saveStatus).toEqual({ kind: "unsaved" });
    const document = app.document;

    const result = await app.renameNote("inbox/alpha.md", "omega.md");
    expect(result).toEqual({ kind: "renamed", path: "inbox/omega.md" });
    // Saved to the old name first, then moved.
    expect(await read(storage, "inbox/omega.md")).toBe("# Alpha\nedited");
    expect(exists(storage, "inbox/alpha.md")).toBe(false);
    expect(app.item).toBe("inbox/omega.md");
    expect(app.document).not.toBe(document);
    expect(app.document).toMatchObject({
      status: "ready",
      path: "inbox/omega.md",
      text: "# Alpha\nedited",
    });
    expect(app.saveStatus).toEqual({ kind: "saved", at: NOW });
    expect(app.editorChanges.at(-1)).toEqual({
      kind: "rename",
      from: "inbox/alpha.md",
      to: "inbox/omega.md",
    });

    // The watcher's report of the rename and a full rescan change nothing.
    await wait(app);
    storage.emitChange({ paths: ["inbox/alpha.md", "inbox/omega.md"] });
    await app.settled();
    storage.emitChange({ paths: [], rescan: true });
    await wait(app);
    expect(notePaths(app)).toEqual(["inbox/beta.md", "inbox/gamma.md", "inbox/omega.md"]);
    expect(app.item).toBe("inbox/omega.md");
    expect(app.document).toMatchObject({ path: "inbox/omega.md", text: "# Alpha\nedited" });
    expect(conflictCopies(storage)).toEqual([]);
    expect(app.toasts).toEqual([]);

    // Later edits are saved under the new name.
    app.edit("inbox/omega.md", () => "# Alpha\nedited again");
    await wait(app);
    expect(await read(storage, "inbox/omega.md")).toBe("# Alpha\nedited again");
    expect(exists(storage, "inbox/alpha.md")).toBe(false);
    expect(app.saveStatus?.kind).toBe("saved");
    expect(app.summaries.get("inbox/omega.md")?.title).toBe("Alpha");
  });

  it("saves edits typed while the rename runs to the new name", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/alpha.md");
    let finish: () => void = () => undefined;
    const original = storage.renameFile.bind(storage);
    vi.spyOn(storage, "renameFile").mockImplementationOnce(async (from, to) => {
      await new Promise<void>((resolve) => (finish = resolve));
      return original(from, to);
    });
    const renaming = app.renameNote("inbox/alpha.md", "omega");
    await vi.advanceTimersByTimeAsync(0);
    app.edit("inbox/alpha.md", () => "typed during rename");
    await vi.advanceTimersByTimeAsync(600);
    expect(await read(storage, "inbox/alpha.md")).toBe("# Alpha\nbody");
    finish();
    await renaming;
    await wait(app);
    expect(await read(storage, "inbox/omega.md")).toBe("typed during rename");
    expect(exists(storage, "inbox/alpha.md")).toBe(false);
    expect(conflictCopies(storage)).toEqual([]);
  });

  it("renames a note that is still being saved in the background", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/alpha.md");
    storage.setReadOnly("inbox/alpha.md");
    app.edit("inbox/alpha.md", () => "unsaved");
    await open(app, "inbox/beta.md");
    await app.settled();
    storage.setReadOnly("inbox/alpha.md", false);
    await expect(app.renameNote("inbox/alpha.md", "kept")).resolves.toMatchObject({
      kind: "renamed",
    });
    await app.settled();
    expect(await read(storage, "inbox/kept.md")).toBe("unsaved");
    expect(app.item).toBe("inbox/beta.md");
    // Switching back shows the buffer of the moved session.
    await open(app, "inbox/kept.md");
    expect(app.document).toMatchObject({ path: "inbox/kept.md", text: "unsaved" });
  });

  it("allows a case-only rename", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/beta.md");
    await expect(app.renameNote("inbox/beta.md", "Beta")).resolves.toEqual({
      kind: "renamed",
      path: "inbox/Beta.md",
    });
    expect(await read(storage, "inbox/Beta.md")).toBe("# Beta\n");
    expect(notePaths(app)).toEqual(["inbox/alpha.md", "inbox/Beta.md", "inbox/gamma.md"]);
  });

  it("does nothing when the name is unchanged", async () => {
    const { storage, app } = await started();
    const rename = vi.spyOn(storage, "renameFile");
    await expect(app.renameNote("inbox/beta.md", "beta")).resolves.toEqual({
      kind: "renamed",
      path: "inbox/beta.md",
    });
    expect(rename).not.toHaveBeenCalled();
  });

  it.each([
    ["", "Enter a name."],
    ["a/b", "Names cannot contain / or \\."],
    ["tasks", "tasks.md is reserved for task lists."],
  ])("refuses the invalid name %j", async (input, reason) => {
    const { storage, app } = await started();
    const rename = vi.spyOn(storage, "renameFile");
    await expect(app.renameNote("inbox/beta.md", input)).resolves.toEqual({
      kind: "invalid",
      reason,
    });
    expect(rename).not.toHaveBeenCalled();
  });

  it("refuses names of other notes, ignoring case", async () => {
    const { storage, app } = await started();
    const rename = vi.spyOn(storage, "renameFile");
    await expect(app.renameNote("inbox/beta.md", "ALPHA")).resolves.toEqual({
      kind: "invalid",
      reason: nameTakenMessage("ALPHA.md"),
    });
    expect(rename).not.toHaveBeenCalled();
  });

  it.each(["a:b.md", "con.md", "tasks.MD.md"])(
    "ends editing an unchanged name made outside the app: %j",
    async (name) => {
      const { storage, app } = await started({ [`inbox/${name}`]: "outside" });
      const rename = vi.spyOn(storage, "renameFile");
      const path = `inbox/${name}`;
      await expect(app.renameNote(path, ` ${name} `)).resolves.toEqual({ kind: "renamed", path });
      await expect(app.renameNote(path, name.slice(0, -3))).resolves.toEqual({
        kind: "renamed",
        path,
      });
      expect(rename).not.toHaveBeenCalled();
      expect(app.toasts).toEqual([]);
    },
  );

  it("refuses the name of the selected note shown as missing", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/beta.md");
    storage.setExternal("inbox/beta.md", null);
    await wait(app, 0);
    expect(app.document).toEqual({ status: "missing", path: "inbox/beta.md" });
    const rename = vi.spyOn(storage, "renameFile");
    await expect(app.renameNote("inbox/alpha.md", "BETA")).resolves.toEqual({
      kind: "invalid",
      reason: nameTakenMessage("BETA.md"),
    });
    expect(rename).not.toHaveBeenCalled();
    expect(app.item).toBe("inbox/beta.md");
    expect(app.document).toEqual({ status: "missing", path: "inbox/beta.md" });
  });

  it("refuses the name of a deleted note whose unsaved edits are kept", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/beta.md");
    app.edit("inbox/beta.md", () => "# Beta\nunsaved");
    // The note is deleted elsewhere and re-creating it keeps failing.
    const write = vi.spyOn(storage, "writeFile").mockRejectedValue(new StorageError("Io", "busy"));
    storage.setExternal("inbox/beta.md", null);
    await wait(app, 0);
    await open(app, "inbox/alpha.md");
    expect(notePaths(app)).not.toContain("inbox/beta.md");

    const rename = vi.spyOn(storage, "renameFile");
    await expect(app.renameNote("inbox/alpha.md", "beta")).resolves.toEqual({
      kind: "invalid",
      reason: nameTakenMessage("beta.md"),
    });
    expect(rename).not.toHaveBeenCalled();

    // The kept edits are still saved once writing works again.
    write.mockRestore();
    await wait(app, 30_000);
    expect(await read(storage, "inbox/beta.md")).toBe("# Beta\nunsaved");
  });

  it("refuses a name taken on disk but not reported yet", async () => {
    const { storage, app } = await started();
    storage.setExternal("inbox/new.md", "someone else", false);
    await expect(app.renameNote("inbox/beta.md", "new")).resolves.toEqual({
      kind: "invalid",
      reason: nameTakenMessage("new.md"),
    });
    expect(await read(storage, "inbox/beta.md")).toBe("# Beta\n");
    expect(notePaths(app)).toContain("inbox/beta.md");
  });

  it("refuses names hidden by the ignore patterns", async () => {
    const { app } = await started({
      ".kaido/config.json": JSON.stringify({ version: 1, ignore: ["*.draft.md"] }),
    });
    await expect(app.renameNote("inbox/beta.md", "beta.draft")).resolves.toEqual({
      kind: "invalid",
      reason: NAME_IGNORED,
    });
  });

  it("refuses task lists and unknown notes", async () => {
    const { app } = await started();
    await expect(app.renameNote("inbox/tasks.md", "list")).resolves.toEqual({
      kind: "invalid",
      reason: NOTE_GONE,
    });
    await expect(app.renameNote("inbox/missing.md", "x")).resolves.toEqual({
      kind: "invalid",
      reason: NOTE_GONE,
    });
  });

  it("shows a toast and changes nothing when the rename fails", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/alpha.md");
    const workspace = app.workspace;
    vi.spyOn(storage, "renameFile").mockRejectedValue(
      new StorageError("PermissionDenied", "inbox is read-only."),
    );
    await expect(app.renameNote("inbox/alpha.md", "omega")).resolves.toEqual({ kind: "failed" });
    expect(messages(app)).toEqual([renameFailedMessage("alpha.md", "inbox is read-only.")]);
    expect(app.workspace).toBe(workspace);
    expect(app.item).toBe("inbox/alpha.md");
    expect(app.editorChanges).toEqual([]);
    // The session still saves to the old name.
    app.edit("inbox/alpha.md", () => "still here");
    await wait(app);
    expect(await read(storage, "inbox/alpha.md")).toBe("still here");
  });

  it("reloads a note whose read was still running", async () => {
    const { storage, app } = await started();
    let release: () => void = () => undefined;
    const original = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementationOnce(async (path) => {
      await new Promise<void>((resolve) => (release = resolve));
      return original(path);
    });
    app.selectItem("inbox/gamma.md");
    expect(app.document).toEqual({ status: "loading", path: "inbox/gamma.md" });
    await app.renameNote("inbox/gamma.md", "zeta");
    release();
    await app.settled();
    expect(app.item).toBe("inbox/zeta.md");
    expect(app.document).toMatchObject({ status: "ready", path: "inbox/zeta.md" });
  });

  it("keeps the state of a note shown as too large", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "readFile").mockRejectedValueOnce(new StorageError("TooLarge", "big"));
    await open(app, "inbox/gamma.md");
    expect(app.document).toEqual({ status: "too-large", path: "inbox/gamma.md" });
    await app.renameNote("inbox/gamma.md", "zeta");
    expect(app.document).toEqual({ status: "too-large", path: "inbox/zeta.md" });
  });

  it("does nothing before a workspace is open", async () => {
    const storage = new MemoryStorage({ folders: { [ROOT]: {} } });
    const app = new AppState(storage);
    await app.start();
    await expect(app.renameNote("inbox/a.md", "b")).resolves.toEqual({ kind: "failed" });
  });

  it("drops the result when another workspace opened meanwhile", async () => {
    const { storage, app } = await started();
    let release: () => void = () => undefined;
    const original = storage.renameFile.bind(storage);
    vi.spyOn(storage, "renameFile").mockImplementationOnce(async (from, to) => {
      const written = await original(from, to);
      await new Promise<void>((resolve) => (release = resolve));
      return written;
    });
    const renaming = app.renameNote("inbox/beta.md", "moved");
    await vi.advanceTimersByTimeAsync(0);
    await app.openWorkspace(OTHER);
    release();
    await expect(renaming).resolves.toEqual({ kind: "failed" });
    await app.settled();
    expect(app.phase).toEqual({ kind: "ready", root: OTHER });
    expect(app.editorChanges).toEqual([]);
  });

  it("drops a failure when another workspace opened meanwhile", async () => {
    const { storage, app } = await started();
    let fail: () => void = () => undefined;
    vi.spyOn(storage, "renameFile").mockImplementationOnce(
      () => new Promise((_, reject) => (fail = () => reject(new StorageError("Io", "disk")))),
    );
    const renaming = app.renameNote("inbox/beta.md", "moved");
    await vi.advanceTimersByTimeAsync(0);
    await app.openWorkspace(OTHER);
    fail();
    await expect(renaming).resolves.toEqual({ kind: "failed" });
    expect(app.toasts).toEqual([]);
  });
});

describe("AppState.deleteNote", () => {
  it("deletes the open note, selects the next one and offers undo", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/alpha.md");
    await app.deleteNote("inbox/alpha.md");

    expect(exists(storage, "inbox/alpha.md")).toBe(false);
    expect(storage.trash).toEqual([{ path: "inbox/alpha.md", contents: "# Alpha\nbody" }]);
    expect(notePaths(app)).toEqual(["inbox/beta.md", "inbox/gamma.md"]);
    expect(app.item).toBe("inbox/beta.md");
    await app.settled();
    expect(app.document).toMatchObject({ status: "ready", path: "inbox/beta.md" });
    expect(app.summaries.has("inbox/alpha.md")).toBe(false);
    expect(app.editorChanges).toEqual([{ kind: "forget", path: "inbox/alpha.md" }]);
    expect(app.toasts).toEqual([
      { id: expect.any(Number), message: deletedMessage("alpha.md"), action: "Undo" },
    ]);

    // The watcher's report and a rescan change nothing.
    storage.emitChange({ paths: ["inbox/alpha.md"] });
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    expect(notePaths(app)).toEqual(["inbox/beta.md", "inbox/gamma.md"]);
    expect(app.item).toBe("inbox/beta.md");
  });

  it("selects the previous item after the last one, and nothing when the list empties", async () => {
    const { app } = await started();
    await open(app, "inbox/gamma.md");
    await app.deleteNote("inbox/gamma.md");
    expect(app.item).toBe("inbox/beta.md");

    app.selectFolder("api");
    await app.settled();
    expect(app.item).toBe("api/deploy.md");
    await app.deleteNote("api/deploy.md");
    expect(app.item).toBe("");
    expect(app.document).toBeNull();
    expect(app.saveStatus).toBeNull();
  });

  it("keeps the selection when another note is deleted", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/beta.md");
    await app.deleteNote("inbox/gamma.md");
    expect(storage.trash).toEqual([{ path: "inbox/gamma.md", contents: "no heading" }]);
    expect(app.item).toBe("inbox/beta.md");
    expect(notePaths(app)).toEqual(["inbox/alpha.md", "inbox/beta.md"]);
  });

  it("saves pending edits of the open note before deleting it", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/alpha.md");
    app.edit("inbox/alpha.md", () => "# Alpha\nlatest");
    await app.deleteNote("inbox/alpha.md");
    expect(storage.trash).toEqual([{ path: "inbox/alpha.md", contents: "# Alpha\nlatest" }]);
    // Nothing is written afterwards.
    await wait(app, 5_000);
    expect(exists(storage, "inbox/alpha.md")).toBe(false);
    expect(conflictCopies(storage)).toEqual([]);
  });

  it("restores the latest buffer even when it could not be saved", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/alpha.md");
    storage.setReadOnly("inbox/alpha.md");
    app.edit("inbox/alpha.md", () => "unsaved text");
    await wait(app);
    expect(app.saveStatus?.kind).toBe("failed");
    storage.setReadOnly("inbox/alpha.md", false);
    // The edit is retried first and fails again; the disk version is deleted.
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "disk full"));
    await app.deleteNote("inbox/alpha.md");
    expect(storage.trash).toEqual([{ path: "inbox/alpha.md", contents: "# Alpha\nbody" }]);
    const [toast] = app.toasts;
    await app.undoDelete(toast?.id ?? -1);
    expect(await read(storage, "inbox/alpha.md")).toBe("unsaved text");
  });

  it("undo re-creates the note, selects and opens it", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/alpha.md");
    await app.deleteNote("inbox/alpha.md");
    app.selectFolder("api");
    await app.settled();
    const write = vi.spyOn(storage, "writeFile");
    const [toast] = app.toasts;
    await app.undoDelete(toast?.id ?? -1);

    expect(write).toHaveBeenCalledWith("inbox/alpha.md", "# Alpha\nbody", { expectedHash: null });
    expect(app.toasts).toEqual([]);
    expect(app.folder).toBe("inbox");
    expect(app.item).toBe("inbox/alpha.md");
    expect(app.document).toMatchObject({
      status: "ready",
      path: "inbox/alpha.md",
      text: "# Alpha\nbody",
    });
    expect(notePaths(app)).toEqual(["inbox/alpha.md", "inbox/beta.md", "inbox/gamma.md"]);
    expect(app.summaries.get("inbox/alpha.md")?.title).toBe("Alpha");

    // Its echo changes nothing and later edits save normally.
    await app.settled();
    app.edit("inbox/alpha.md", () => "after undo");
    await wait(app);
    expect(await read(storage, "inbox/alpha.md")).toBe("after undo");
    expect(conflictCopies(storage)).toEqual([]);
  });

  it("undo does not replace a file that took the name", async () => {
    const { storage, app } = await started();
    await app.deleteNote("inbox/beta.md");
    storage.setExternal("inbox/beta.md", "new file");
    await app.settled();
    const [toast] = app.toasts;
    await app.undoDelete(toast?.id ?? -1);
    expect(await read(storage, "inbox/beta.md")).toBe("new file");
    expect(messages(app)).toEqual([restoreTakenMessage("beta.md")]);
  });

  it("undo reports other failures", async () => {
    const { storage, app } = await started();
    await app.deleteNote("inbox/beta.md");
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "disk full"));
    const [toast] = app.toasts;
    await app.undoDelete(toast?.id ?? -1);
    expect(messages(app)).toEqual([restoreFailedMessage("beta.md", "disk full")]);
    expect(notePaths(app)).not.toContain("inbox/beta.md");
  });

  it("undo restores but does not show a note hidden meanwhile", async () => {
    const { storage, app } = await started();
    await app.deleteNote("inbox/beta.md");
    storage.setExternal(".kaido/config.json", JSON.stringify({ version: 1, ignore: ["beta.md"] }));
    await app.settled();
    const [toast] = app.toasts;
    await app.undoDelete(toast?.id ?? -1);
    expect(await read(storage, "inbox/beta.md")).toBe("# Beta\n");
    expect(notePaths(app)).not.toContain("inbox/beta.md");
    expect(app.item).toBe("inbox/tasks.md");
  });

  it("knows the most recent delete that can still be undone", async () => {
    const { app } = await started();
    expect(app.latestUndo).toBeNull();
    app.notify("not undoable");
    await app.deleteNote("inbox/alpha.md");
    await app.deleteNote("inbox/beta.md");
    const [, first, second] = app.toasts;
    expect(app.latestUndo).toBe(second?.id);
    app.dismissToast(second?.id ?? -1);
    expect(app.latestUndo).toBe(first?.id);
    await app.undoDelete(first?.id ?? -1);
    expect(app.latestUndo).toBeNull();
  });

  it("undo does nothing once the toast is dismissed", async () => {
    const { storage, app } = await started();
    await app.deleteNote("inbox/beta.md");
    const [toast] = app.toasts;
    app.dismissToast(toast?.id ?? -1);
    await app.undoDelete(toast?.id ?? -1);
    expect(exists(storage, "inbox/beta.md")).toBe(false);
  });

  it("drops undo toasts when another workspace opens", async () => {
    const { storage, app } = await started();
    await app.deleteNote("inbox/beta.md");
    app.notify("kept");
    const [toast] = app.toasts;
    await app.openWorkspace(OTHER);
    expect(messages(app)).toEqual(["kept"]);
    await app.undoDelete(toast?.id ?? -1);
    expect(exists(storage, "inbox/beta.md")).toBe(false);
  });

  it("refuses to delete a version it has not seen", async () => {
    const { storage, app } = await started();
    await open(app, "inbox/alpha.md");
    storage.setExternal("inbox/alpha.md", "# Alpha\nchanged elsewhere", false);
    const workspace = app.workspace;
    await app.deleteNote("inbox/alpha.md");
    expect(await read(storage, "inbox/alpha.md")).toBe("# Alpha\nchanged elsewhere");
    expect(messages(app)).toEqual([deleteConflictMessage("alpha.md")]);
    expect(app.workspace).toBe(workspace);
    await app.settled();
    // The open note shows what is on disk now.
    expect(app.document).toMatchObject({ text: "# Alpha\nchanged elsewhere" });
  });

  it("reports a failure for a note that is not open", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "deleteFile").mockRejectedValueOnce(
      new StorageError("PermissionDenied", "denied"),
    );
    await app.deleteNote("inbox/gamma.md");
    expect(messages(app)).toEqual([deleteFailedMessage("gamma.md", "denied")]);
    expect(notePaths(app)).toContain("inbox/gamma.md");
  });

  it("ignores task lists, unknown notes and calls before a workspace is open", async () => {
    const { storage, app } = await started();
    const remove = vi.spyOn(storage, "deleteFile");
    await app.deleteNote("inbox/tasks.md");
    await app.deleteNote("inbox/missing.md");
    expect(remove).not.toHaveBeenCalled();

    const fresh = new AppState(new MemoryStorage({ folders: { [ROOT]: {} } }));
    await fresh.start();
    await fresh.deleteNote("inbox/a.md");
    expect(fresh.toasts).toEqual([]);
  });

  it("drops the result when another workspace opened meanwhile", async () => {
    const { storage, app } = await started();
    let fail: () => void = () => undefined;
    vi.spyOn(storage, "deleteFile").mockImplementationOnce(
      () => new Promise((_, reject) => (fail = () => reject(new StorageError("Io", "disk")))),
    );
    const deleting = app.deleteNote("inbox/gamma.md");
    await vi.advanceTimersByTimeAsync(0);
    await app.openWorkspace(OTHER);
    fail();
    await deleting;
    expect(app.toasts).toEqual([]);

    await app.openWorkspace(ROOT);
    await app.settled();
    let release: () => void = () => undefined;
    const original = storage.deleteFile.bind(storage);
    vi.spyOn(storage, "deleteFile").mockImplementationOnce(async (...args) => {
      await original(...args);
      await new Promise<void>((resolve) => (release = resolve));
    });
    const second = app.deleteNote("inbox/beta.md");
    await vi.advanceTimersByTimeAsync(0);
    await app.openWorkspace(OTHER);
    release();
    await second;
    expect(app.toasts).toEqual([]);
    expect(storage.trash.map((file) => file.path)).toEqual(["inbox/beta.md"]);
  });

  it("drops an undo whose workspace closed while it ran", async () => {
    const { storage, app } = await started();
    await app.deleteNote("inbox/beta.md");
    const [toast] = app.toasts;
    let release: () => void = () => undefined;
    const original = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementationOnce(async (...args) => {
      const written = await original(...args);
      await new Promise<void>((resolve) => (release = resolve));
      return written;
    });
    const undoing = app.undoDelete(toast?.id ?? -1);
    await vi.advanceTimersByTimeAsync(0);
    await app.openWorkspace(OTHER);
    release();
    await undoing;
    expect(app.item).toBe("inbox/other.md");

    let fail: () => void = () => undefined;
    await app.openWorkspace(ROOT);
    await app.settled();
    await app.deleteNote("inbox/gamma.md");
    const [second] = app.toasts;
    vi.spyOn(storage, "writeFile").mockImplementationOnce(
      () => new Promise((_, reject) => (fail = () => reject(new StorageError("Io", "disk")))),
    );
    const failing = app.undoDelete(second?.id ?? -1);
    await vi.advanceTimersByTimeAsync(0);
    await app.openWorkspace(OTHER);
    fail();
    await failing;
    expect(app.toasts).toEqual([]);
  });
});
