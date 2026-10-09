import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage, StorageError } from "$lib/storage";
import {
  AppState,
  conflictMessage,
  UNSAVED_ON_CLOSE,
  unsavedOnSwitchMessage,
} from "./appState.svelte";

const ROOT = "/notes";
const OTHER = "/other";
const NOW = new Date(2026, 9, 8, 9, 5).getTime();

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] one\n",
  "inbox/idea.md": "# Idea\nbody",
  "api/deploy.md": "# Deploy\n",
};

function setup(options: { closeTimeout?: number } = {}) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...files }, [OTHER]: { "inbox/other.md": "# Other" } },
    settings: JSON.stringify({ version: 1, workspace: ROOT }),
  });
  const app = new AppState(storage, {
    defer: (task) => task(),
    schedule: (task) => task(),
    ...options,
  });
  return { storage, app };
}

async function started(options: Parameters<typeof setup>[0] = {}) {
  const context = setup(options);
  await context.app.start();
  await context.app.settled();
  return context;
}

/** Lets timers fire and all resulting work finish. */
async function wait(app: AppState, ms = 500) {
  await vi.advanceTimersByTimeAsync(ms);
  await app.settled();
  await vi.advanceTimersByTimeAsync(0);
}

const read = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;
const type = (app: AppState, text: string, path = app.item) => app.edit(path, () => text);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AppState autosave", () => {
  it("saves 500 ms after the last edit and reports the status", async () => {
    const { storage, app } = await started();
    expect(app.saveStatus).toEqual({ kind: "saved", at: NOW });
    type(app, "- [ ] one\n- [ ] two\n");
    expect(app.saveStatus).toEqual({ kind: "unsaved" });
    await vi.advanceTimersByTimeAsync(499);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n");
    await wait(app, 1);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n- [ ] two\n");
    expect(app.saveStatus).toEqual({ kind: "saved", at: NOW + 500 });
    // The summary follows the saved text; the echo does not reload the editor.
    expect(app.summaries.get("inbox/tasks.md")?.openTasks).toBe(2);
    expect(app.document).toMatchObject({ text: "- [ ] one\n" });
  });

  it("ignores edits for a note without a session", async () => {
    const { storage, app } = await started();
    type(app, "nope", "api/deploy.md");
    await wait(app);
    expect(await read(storage, "api/deploy.md")).toBe("# Deploy\n");
  });

  it("saves right away when another note is selected, then drops the session", async () => {
    const { storage, app } = await started();
    type(app, "changed");
    app.selectItem("inbox/idea.md");
    await vi.advanceTimersByTimeAsync(0);
    expect(await read(storage, "inbox/tasks.md")).toBe("changed");
    await app.settled();
    expect(app.document).toMatchObject({ path: "inbox/idea.md", status: "ready" });

    // Back again: read from disk, because nothing was pending.
    const spy = vi.spyOn(storage, "readFile");
    app.selectItem("inbox/tasks.md");
    await app.settled();
    expect(spy).toHaveBeenCalledWith("inbox/tasks.md");
    expect(app.document).toMatchObject({ text: "changed" });
  });

  it("saves a last edit reported for the note being left", async () => {
    const { storage, app } = await started();
    app.selectItem("inbox/idea.md");
    type(app, "late", "inbox/tasks.md");
    await wait(app);
    expect(await read(storage, "inbox/tasks.md")).toBe("late");
    expect(app.item).toBe("inbox/idea.md");
    expect(app.saveStatus).toEqual({ kind: "saved", at: NOW });
  });

  it("flushes when the folder changes", async () => {
    const { storage, app } = await started();
    type(app, "changed");
    app.selectFolder("api");
    await vi.advanceTimersByTimeAsync(0);
    expect(await read(storage, "inbox/tasks.md")).toBe("changed");
    expect(app.item).toBe("api/deploy.md");
  });

  it("shows the unsaved buffer when returning to a note whose save failed", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValue(new StorageError("PermissionDenied", "no"));
    type(app, "mine");
    app.selectItem("inbox/idea.md");
    await wait(app, 0);
    app.selectItem("inbox/tasks.md");
    expect(app.document).toMatchObject({ status: "ready", text: "mine" });
    expect(app.saveStatus).toEqual({ kind: "failed", message: "no" });

    // A later retry succeeds while another note is open and drops the session.
    vi.mocked(storage.writeFile).mockRestore();
    app.selectItem("inbox/idea.md");
    await wait(app, 2_000);
    expect(await read(storage, "inbox/tasks.md")).toBe("mine");
    const spy = vi.spyOn(storage, "readFile");
    app.selectItem("inbox/tasks.md");
    await app.settled();
    expect(spy).toHaveBeenCalledWith("inbox/tasks.md");
  });

  it("retries failed background saves until they land", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "busy"));
    type(app, "mine");
    app.selectItem("inbox/idea.md");
    await wait(app, 0);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n");
    await wait(app, 2_000);
    expect(await read(storage, "inbox/tasks.md")).toBe("mine");
  });

  it("flushes every pending note on demand", async () => {
    const { storage, app } = await started();
    type(app, "now");
    await app.flush();
    expect(await read(storage, "inbox/tasks.md")).toBe("now");
  });
});

describe("AppState external changes while editing", () => {
  it("reloads a clean note silently", async () => {
    const { storage, app } = await started();
    storage.setExternal("inbox/tasks.md", "- [ ] theirs\n");
    await wait(app, 0);
    expect(app.document).toMatchObject({ text: "- [ ] theirs\n" });
    expect(app.toasts).toEqual([]);
  });

  it("keeps both versions when the note has unsaved edits", async () => {
    const { storage, app } = await started();
    type(app, "mine");
    storage.setExternal("inbox/tasks.md", "theirs");
    await wait(app, 0);
    const copy = "inbox/tasks (conflict 2026-10-08 0905).md";
    expect(await read(storage, copy)).toBe("theirs");
    expect(await read(storage, "inbox/tasks.md")).toBe("mine");
    expect(app.toasts).toEqual([{ id: 1, message: conflictMessage(copy) }]);
    expect(app.toasts[0]?.message).toBe(
      "Changed outside Kaido — the other version was saved as tasks (conflict 2026-10-08 0905).md",
    );
    // The copy shows up as a note.
    await wait(app, 0);
    expect(app.workspace.projects[0]?.notes.map((note) => note.path)).toContain(copy);
    app.dismissToast(1);
    expect(app.toasts).toEqual([]);
  });

  it("checks notes still saving in the background", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "busy"));
    type(app, "mine");
    app.selectItem("inbox/idea.md");
    await wait(app, 0);
    storage.setExternal("inbox/tasks.md", "theirs");
    await wait(app, 0);
    expect(await read(storage, "inbox/tasks.md")).toBe("mine");
    expect(app.toasts).toHaveLength(1);
  });

  it("re-creates a deleted note that has unsaved edits", async () => {
    const { storage, app } = await started();
    type(app, "mine");
    storage.setExternal("inbox/tasks.md", null);
    await wait(app, 0);
    expect(app.document).toMatchObject({ status: "ready" });
    await wait(app, 500);
    expect(await read(storage, "inbox/tasks.md")).toBe("mine");
  });

  it("shows a clean deleted note as missing", async () => {
    const { storage, app } = await started();
    storage.setExternal("inbox/tasks.md", null);
    await wait(app, 0);
    expect(app.document).toEqual({ status: "missing", path: "inbox/tasks.md" });
    expect(app.saveStatus).toBeNull();
  });

  it("drops a background session whose clean note was deleted", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "busy"));
    type(app, "- [ ] one\n");
    type(app, "mine");
    app.selectItem("inbox/idea.md");
    await wait(app, 0);
    // The buffer goes back to the disk version, so the note is clean again.
    app.selectItem("inbox/tasks.md");
    type(app, "- [ ] one\n");
    app.selectItem("inbox/idea.md");
    await wait(app, 0);
    storage.setExternal("inbox/tasks.md", null);
    await wait(app, 0);
    storage.setExternal("inbox/tasks.md", "back");
    await wait(app, 0);
    app.selectItem("inbox/tasks.md");
    await app.settled();
    expect(app.document).toMatchObject({ text: "back" });
  });
});

describe("AppState closing", () => {
  it("saves before the window closes", async () => {
    const { storage, app } = await started();
    type(app, "closing");
    await expect(storage.requestClose()).resolves.toBe(true);
    expect(await read(storage, "inbox/tasks.md")).toBe("closing");
  });

  it("keeps the window open once when changes could not be saved", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValue(new StorageError("PermissionDenied", "no"));
    type(app, "closing");
    await expect(storage.requestClose()).resolves.toBe(false);
    expect(app.toasts.map((toast) => toast.message)).toEqual([UNSAVED_ON_CLOSE]);
    await expect(storage.requestClose()).resolves.toBe(true);
  });

  it("asks again when saving fails again after it recovered", async () => {
    vi.setSystemTime(new Date(2026, 9, 8, 10, 0));
    const { storage, app } = await started();
    const failing = () =>
      vi.spyOn(storage, "writeFile").mockRejectedValue(new StorageError("Io", "busy"));
    failing();
    type(app, "morning");
    await expect(storage.requestClose()).resolves.toBe(false);

    // The retry succeeds.
    vi.mocked(storage.writeFile).mockRestore();
    await wait(app, 2_000);
    expect(await read(storage, "inbox/tasks.md")).toBe("morning");

    // Hours later saving fails again: closing is refused again first.
    vi.setSystemTime(new Date(2026, 9, 8, 15, 0));
    failing();
    type(app, "afternoon");
    await expect(storage.requestClose()).resolves.toBe(false);
    expect(app.toasts.map((toast) => toast.message)).toEqual([UNSAVED_ON_CLOSE, UNSAVED_ON_CLOSE]);
    await expect(storage.requestClose()).resolves.toBe(true);
  });

  it("asks again after an edit, or once nothing is unsaved", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValue(new StorageError("PermissionDenied", "no"));
    type(app, "one");
    await expect(storage.requestClose()).resolves.toBe(false);
    type(app, "two");
    await expect(storage.requestClose()).resolves.toBe(false);

    // Back to the disk version: nothing to save, so closing is fine and
    // the earlier refusal is forgotten.
    type(app, "- [ ] one\n");
    await expect(storage.requestClose()).resolves.toBe(true);
    type(app, "three");
    await expect(storage.requestClose()).resolves.toBe(false);
  });

  it("does not wait forever for a stuck save", async () => {
    const { storage, app } = await started({ closeTimeout: 100 });
    vi.spyOn(storage, "writeFile").mockReturnValue(new Promise(() => undefined));
    type(app, "stuck");
    const closing = storage.requestClose();
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toBe(false);
  });

  it("closes without a hook when it cannot be registered", async () => {
    const { storage, app } = setup();
    vi.spyOn(storage, "onCloseRequested").mockRejectedValue(new StorageError("Io", "no window"));
    await app.start();
    await expect(storage.requestClose()).resolves.toBe(true);
  });

  it("removes the hook on dispose, also when registration finishes later", async () => {
    const { storage, app } = await started();
    app.dispose();
    await expect(storage.requestClose()).resolves.toBe(true);

    const late = setup();
    let finish: (stop: () => void) => void = () => undefined;
    const stop = vi.fn();
    vi.spyOn(late.storage, "onCloseRequested").mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    void late.app.start();
    late.app.dispose();
    finish(stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalled();
  });

  it("registers the hook only once", async () => {
    const { storage, app } = setup();
    const register = vi.spyOn(storage, "onCloseRequested");
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    await app.start();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("saves pending edits on dispose", async () => {
    const { storage, app } = await started();
    type(app, "disposed");
    app.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(await read(storage, "inbox/tasks.md")).toBe("disposed");
  });
});

describe("AppState switching workspaces", () => {
  it("saves pending edits into the old workspace first", async () => {
    const { storage, app } = await started();
    type(app, "old workspace");
    await app.openWorkspace(OTHER);
    await app.settled();
    expect(storage.folders.get(ROOT)?.get("inbox/tasks.md")?.contents).toBe("old workspace");
    expect(storage.folders.get(OTHER)?.has("inbox/tasks.md")).toBe(false);
    expect(app.item).toBe("inbox/other.md");
  });

  it("keeps the workspace when edits cannot be saved, until the second attempt", async () => {
    const { storage, app } = await started();
    const write = vi
      .spyOn(storage, "writeFile")
      .mockRejectedValue(new StorageError("PermissionDenied", "no"));
    type(app, "unsaved");
    await app.openWorkspace(OTHER);

    // Nothing changed: same workspace, note and text, and a notice.
    expect(app.phase).toEqual({ kind: "ready", root: ROOT });
    expect(storage.root).toBe(ROOT);
    expect(app.item).toBe("inbox/tasks.md");
    expect(app.document).toMatchObject({ status: "ready", path: "inbox/tasks.md" });
    expect(app.saveStatus).toEqual({ kind: "failed", message: "no" });
    expect(app.toasts.map((toast) => toast.message)).toEqual([
      "Changes to inbox/tasks.md could not be saved. Open the folder again to switch without them.",
    ]);
    expect(unsavedOnSwitchMessage(["a.md", "b.md"])).toMatch(/^Changes to a\.md, b\.md could/);

    // Trying again switches without them and never writes them into the
    // next workspace.
    await app.openWorkspace(OTHER);
    expect(app.phase).toEqual({ kind: "ready", root: OTHER });
    const writes = write.mock.calls.length;
    await wait(app, 30_000);
    expect(write).toHaveBeenCalledTimes(writes);
    expect(storage.folders.get(OTHER)?.has("inbox/tasks.md")).toBe(false);
    expect(storage.folders.get(ROOT)?.get("inbox/tasks.md")?.contents).toBe("- [ ] one\n");
    expect(app.toasts).toHaveLength(1);
  });

  it("keeps saving in the current workspace after a refused switch", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "busy"));
    type(app, "kept");
    await app.openWorkspace(OTHER);
    expect(app.phase).toEqual({ kind: "ready", root: ROOT });
    // The retry lands, so the next switch is a fresh one with nothing unsaved.
    await wait(app, 2_000);
    expect(await read(storage, "inbox/tasks.md")).toBe("kept");
    await app.openWorkspace(OTHER);
    expect(app.phase).toEqual({ kind: "ready", root: OTHER });
    expect(storage.folders.get(ROOT)?.get("inbox/tasks.md")?.contents).toBe("kept");
  });

  it("refuses a switch again after an edit", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValue(new StorageError("PermissionDenied", "no"));
    type(app, "one");
    await app.openWorkspace(OTHER);
    type(app, "two");
    await app.openWorkspace(OTHER);
    expect(app.phase).toEqual({ kind: "ready", root: ROOT });
    expect(app.toasts).toHaveLength(2);
    // A refused close does not count as consent to switch, and vice versa.
    await expect(storage.requestClose()).resolves.toBe(false);
    await app.openWorkspace(OTHER);
    expect(app.phase).toEqual({ kind: "ready", root: ROOT });
  });

  it("stops a switch when the app is disposed meanwhile", async () => {
    const { storage, app } = await started();
    type(app, "pending");
    const opening = app.openWorkspace(OTHER);
    app.dispose();
    await opening;
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.root).toBe(ROOT);
    expect(await read(storage, "inbox/tasks.md")).toBe("pending");
  });

  it("waits for an earlier switch before opening the next workspace", async () => {
    const { storage, app } = await started();
    type(app, "first");
    const first = app.openWorkspace(OTHER);
    const second = app.openWorkspace(ROOT);
    await Promise.all([first, second]);
    await app.settled();
    expect(storage.root).toBe(ROOT);
    expect(await read(storage, "inbox/tasks.md")).toBe("first");
  });

  it("finishes a conflict in the old workspace before switching", async () => {
    const { storage, app } = await started();
    type(app, "mine");
    storage.setExternal("inbox/tasks.md", "theirs", false);
    await app.openWorkspace(OTHER);
    await app.settled();
    const old = storage.folders.get(ROOT);
    expect(old?.get("inbox/tasks.md")?.contents).toBe("mine");
    expect(old?.get("inbox/tasks (conflict 2026-10-08 0905).md")?.contents).toBe("theirs");
    expect(storage.folders.get(OTHER)?.size).toBe(1);
  });

  it("does not wait forever for a stuck save before switching", async () => {
    const { storage, app } = await started({ closeTimeout: 100 });
    let release: () => void = () => undefined;
    const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementationOnce(
      (path, contents, options) =>
        new Promise((resolve) => (release = () => resolve(write(path, contents, options)))),
    );
    type(app, "stuck");
    const refused = app.openWorkspace(OTHER);
    await vi.advanceTimersByTimeAsync(100);
    await refused;
    expect(app.phase).toEqual({ kind: "ready", root: ROOT });
    expect(app.toasts.map((toast) => toast.message)).toEqual([
      unsavedOnSwitchMessage(["inbox/tasks.md"]),
    ]);

    const opening = app.openWorkspace(OTHER);
    // Once for the check, once for the sessions being closed.
    await vi.advanceTimersByTimeAsync(200);
    await opening;
    expect(app.phase).toEqual({ kind: "ready", root: OTHER });
    // The dropped session does not retry or start a conflict flow afterwards.
    release();
    await wait(app, 30_000);
    expect(vi.mocked(storage.writeFile)).toHaveBeenCalledTimes(1);
  });

  it("counts saves of the previous workspace when the window closes", async () => {
    const { storage, app } = await started({ closeTimeout: 100 });
    vi.spyOn(storage, "writeFile").mockReturnValue(new Promise(() => undefined));
    type(app, "stuck");
    const refused = app.openWorkspace(OTHER);
    await vi.advanceTimersByTimeAsync(100);
    await refused;

    // Switching anyway: the check takes 100 ms, then the old sessions are
    // closed for up to 100 ms more. The window is closed in between.
    const opening = app.openWorkspace(OTHER);
    await vi.advanceTimersByTimeAsync(50);
    const closing = storage.requestClose();
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toBe(false);
    expect(app.toasts.at(-1)?.message).toBe(UNSAVED_ON_CLOSE);
    await vi.advanceTimersByTimeAsync(100);
    await opening;
    expect(app.phase).toEqual({ kind: "ready", root: OTHER });
    // Closing again goes ahead.
    await expect(storage.requestClose()).resolves.toBe(true);
  });
});
