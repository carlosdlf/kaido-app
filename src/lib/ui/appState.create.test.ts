import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_TASKS } from "$lib/core/views";
import { findProject } from "$lib/core/workspace";
import { MemoryStorage, StorageError } from "$lib/storage";
import {
  AppState,
  createNoteFailedMessage,
  MAX_CREATE_ATTEMPTS,
  NO_FREE_NOTE_NAME,
} from "./appState.svelte";

const ROOT = "/notes";
const OTHER = "/other";
const NOW = new Date(2026, 9, 8, 9, 5).getTime();

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] one\n",
  "inbox/idea.md": "# Idea\nbody",
  "api/deploy.md": "# Deploy\n",
};

async function started(extra: Record<string, string> = {}) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...files, ...extra }, [OTHER]: {} },
    settings: JSON.stringify({ version: 1, workspace: ROOT }),
  });
  const app = new AppState(storage, { defer: (task) => task(), schedule: (task) => task() });
  await app.start();
  await app.settled();
  return { storage, app };
}

const notePaths = (app: AppState, project: string) =>
  findProject(app.workspace, project)?.notes.map((note) => note.path) ?? [];

const read = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AppState.createNote", () => {
  it("creates an empty note in the inbox, opens it and asks for focus", async () => {
    const { storage, app } = await started();
    const focus = app.editorFocusRequest;
    await app.createNote();

    expect(await read(storage, "inbox/untitled.md")).toBe("");
    expect(notePaths(app, "inbox")).toContain("inbox/untitled.md");
    expect(app.folder).toBe("inbox");
    expect(app.item).toBe("inbox/untitled.md");
    expect(app.document).toEqual({
      status: "ready",
      path: "inbox/untitled.md",
      text: "",
      modified: NOW,
    });
    expect(app.saveStatus).toEqual({ kind: "saved", at: NOW });
    expect(app.editorFocusRequest).toBe(focus + 1);
    expect(app.summaries.get("inbox/untitled.md")?.title).toBe("untitled");
  });

  it("autosaves the new note on top of the creation write", async () => {
    const { storage, app } = await started();
    await app.createNote();
    const write = vi.spyOn(storage, "writeFile");
    app.edit("inbox/untitled.md", () => "# Plan\n");
    await vi.advanceTimersByTimeAsync(500);
    await app.settled();
    expect(await read(storage, "inbox/untitled.md")).toBe("# Plan\n");
    // The base is the hash of the empty file, not a "must not exist" write.
    expect(write).toHaveBeenCalledWith("inbox/untitled.md", "# Plan\n", {
      expectedHash: expect.any(String),
    });
    expect(app.saveStatus?.kind).toBe("saved");
    expect(app.summaries.get("inbox/untitled.md")?.title).toBe("Plan");
  });

  it("creates the note in the selected project", async () => {
    const { storage, app } = await started();
    app.selectFolder("api");
    await app.settled();
    await app.createNote();
    expect(await read(storage, "api/untitled.md")).toBe("");
    expect(app.folder).toBe("api");
    expect(app.item).toBe("api/untitled.md");
    expect(notePaths(app, "api")).toEqual(["api/deploy.md", "api/untitled.md"]);
  });

  it("uses the inbox from All tasks and switches to it", async () => {
    const { app } = await started();
    app.selectFolder(ALL_TASKS);
    await app.settled();
    await app.createNote();
    expect(app.folder).toBe("inbox");
    expect(app.item).toBe("inbox/untitled.md");
  });

  it("skips names already in the workspace, ignoring case", async () => {
    const { app } = await started({
      "inbox/untitled.md": "taken",
      "inbox/Untitled 2.md": "taken too",
    });
    await app.createNote();
    expect(app.item).toBe("inbox/untitled 3.md");
  });

  it("numbers further notes", async () => {
    const { app } = await started();
    await app.createNote();
    await app.createNote();
    await app.settled();
    expect(app.item).toBe("inbox/untitled 2.md");
    expect(notePaths(app, "inbox")).toEqual([
      "inbox/idea.md",
      "inbox/untitled.md",
      "inbox/untitled 2.md",
    ]);
  });

  it("skips names hidden by the ignore patterns", async () => {
    const { app } = await started({
      ".kaido/config.json": JSON.stringify({ version: 1, ignore: ["untitled.md"] }),
    });
    await app.createNote();
    expect(app.item).toBe("inbox/untitled 2.md");
  });

  it("tries the next name when the file appeared on disk meanwhile", async () => {
    const { storage, app } = await started();
    // Created behind the app's back, not reported yet.
    storage.setExternal("inbox/untitled.md", "someone else", false);
    await app.createNote();
    expect(await read(storage, "inbox/untitled.md")).toBe("someone else");
    expect(await read(storage, "inbox/untitled 2.md")).toBe("");
    expect(app.item).toBe("inbox/untitled 2.md");
    expect(app.toasts).toEqual([]);
  });

  it("gives up after a bounded number of conflicts", async () => {
    const { storage, app } = await started();
    const write = vi
      .spyOn(storage, "writeFile")
      .mockRejectedValue(new StorageError("Conflict", "exists"));
    await app.createNote();
    expect(write).toHaveBeenCalledTimes(MAX_CREATE_ATTEMPTS);
    expect(app.toasts.map((toast) => toast.message)).toEqual([NO_FREE_NOTE_NAME]);
    expect(app.item).toBe("inbox/tasks.md");
  });

  it("shows a toast and changes nothing when the write fails", async () => {
    const { storage, app } = await started();
    const workspace = app.workspace;
    const document = app.document;
    vi.spyOn(storage, "writeFile").mockRejectedValue(
      new StorageError("PermissionDenied", "inbox is read-only."),
    );
    const focus = app.editorFocusRequest;
    await app.createNote();
    expect(app.toasts.map((toast) => toast.message)).toEqual([
      createNoteFailedMessage("inbox is read-only."),
    ]);
    expect(app.workspace).toBe(workspace);
    expect(app.document).toBe(document);
    expect(app.item).toBe("inbox/tasks.md");
    expect(app.editorFocusRequest).toBe(focus);
  });

  it("does not duplicate the note when the watcher reports it", async () => {
    const { storage, app } = await started();
    await app.createNote();
    await app.settled();
    // The echo of the creation write, then a full rescan.
    storage.emitChange({ paths: ["inbox/untitled.md"] });
    await app.settled();
    expect(notePaths(app, "inbox")).toEqual(["inbox/idea.md", "inbox/untitled.md"]);
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    expect(notePaths(app, "inbox")).toEqual(["inbox/idea.md", "inbox/untitled.md"]);
    expect(app.item).toBe("inbox/untitled.md");
    expect(app.document).toMatchObject({ status: "ready", text: "" });
    // The echo is recognized by its hash; nothing is reloaded into the editor.
    expect(app.saveStatus).toEqual({ kind: "saved", at: NOW });
  });

  it("keeps edits typed before the watcher reports the new note", async () => {
    const { storage, app } = await started();
    await app.createNote();
    app.edit("inbox/untitled.md", () => "typing");
    await app.settled();
    expect(app.saveStatus).toEqual({ kind: "unsaved" });
    await vi.advanceTimersByTimeAsync(500);
    await app.settled();
    expect(await read(storage, "inbox/untitled.md")).toBe("typing");
  });

  it("saves the note that was open before", async () => {
    const { storage, app } = await started();
    app.edit("inbox/tasks.md", () => "- [ ] changed\n");
    await app.createNote();
    await vi.advanceTimersByTimeAsync(0);
    await app.settled();
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] changed\n");
    expect(app.item).toBe("inbox/untitled.md");
  });

  it("does nothing before a workspace is open", async () => {
    const storage = new MemoryStorage({ folders: { [ROOT]: {} } });
    const app = new AppState(storage);
    await app.start();
    const write = vi.spyOn(storage, "writeFile");
    await app.createNote();
    expect(write).not.toHaveBeenCalled();
    expect(app.item).toBe("");
  });

  it("drops the result when another workspace opened meanwhile", async () => {
    const { storage, app } = await started();
    let release: () => void = () => undefined;
    const original = storage.writeFile.bind(storage);
    // The write lands in the old workspace; only its answer is late.
    vi.spyOn(storage, "writeFile").mockImplementationOnce(async (...args) => {
      const written = await original(...args);
      await new Promise<void>((resolve) => (release = resolve));
      return written;
    });
    const creating = app.createNote();
    await app.openWorkspace(OTHER);
    release();
    await creating;
    await app.settled();
    expect(app.phase).toEqual({ kind: "ready", root: OTHER });
    expect(storage.folders.get(ROOT)?.has("inbox/untitled.md")).toBe(true);
    expect(notePaths(app, "inbox")).toEqual([]);
    expect(app.item).toBe("");
    expect(app.toasts).toEqual([]);
  });

  it("drops a failure when another workspace opened meanwhile", async () => {
    const { storage, app } = await started();
    let fail: () => void = () => undefined;
    vi.spyOn(storage, "writeFile").mockImplementationOnce(
      () => new Promise((_, reject) => (fail = () => reject(new StorageError("Io", "disk error")))),
    );
    const creating = app.createNote();
    await app.openWorkspace(OTHER);
    fail();
    await creating;
    expect(app.toasts).toEqual([]);
  });
});
