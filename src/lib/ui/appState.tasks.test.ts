import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refAt, type TaskRef } from "$lib/core/taskDocument";
import { taskRows } from "$lib/core/taskRows";
import { ALL_TASKS } from "$lib/core/views";
import { MemoryStorage, StorageError } from "$lib/storage";
import {
  AppState,
  conflictMessage,
  createProjectFailedMessage,
  PROJECT_IGNORED,
  projectExistsMessage,
  createNoteFailedMessage,
  missingNoteMessage,
  nameTakenMessage,
  NO_FREE_NOTE_NAME,
  NOTE_NOT_SHOWN,
  notLinkedMessage,
  SPACED_NAME,
  TASK_CHANGED,
  TASK_NOT_RESTORED,
  taskDeletedMessage,
} from "./appState.svelte";

const ROOT = "/notes";
const NOW = new Date(2026, 9, 8, 9, 5).getTime();

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] one\n- [ ] two\n",
  "inbox/idea.md": "# Idea\n",
  "api/tasks.md": "# Now\r\n- [ ] a\r\n  - [ ] a1\r\n- [x] b\r\n- [ ] c\r\n",
  "api/deploy.md": "# Deploy\n",
  "web/tasks.md": "- [ ] w",
  "_archive/old/tasks.md": "- [ ] archived\n",
};

function setup(extra: Record<string, string> = {}, config?: string) {
  const folder: Record<string, string> = { ...files, ...extra };
  if (config !== undefined) folder[".kaido/config.json"] = config;
  const storage = new MemoryStorage({
    folders: { [ROOT]: folder },
    settings: JSON.stringify({ version: 1, workspace: ROOT }),
  });
  const app = new AppState(storage, { defer: (task) => task(), schedule: (task) => task() });
  return { storage, app };
}

async function started(extra: Record<string, string> = {}, config?: string) {
  const context = setup(extra, config);
  await context.app.start();
  await context.app.settled();
  return context;
}

async function wait(app: AppState, ms = 500) {
  await vi.advanceTimersByTimeAsync(ms);
  await app.settled();
  await vi.advanceTimersByTimeAsync(0);
}

const read = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;
/** Points at the task on `line` as the list currently shows it. */
const ref = (app: AppState, path: string, line: number): TaskRef => {
  const doc = app.taskDocs.get(path);
  return doc ? refAt(doc, line) : { line, raw: "" };
};
const textOf = (app: AppState, path: string) => app.taskDocs.get(path)?.text;
const open = (app: AppState, path: string) => app.summaries.get(path)?.openTasks;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AppState task index", () => {
  it("parses every task list in the background", async () => {
    const { app } = await started();
    expect([...app.taskDocs.keys()].sort()).toEqual([
      "_archive/old/tasks.md",
      "api/tasks.md",
      "inbox/tasks.md",
      "web/tasks.md",
    ]);
    expect(open(app, "api/tasks.md")).toBe(2);
  });

  it("skips lists over 1 MiB", async () => {
    const { app } = await started({ "big/tasks.md": `- [ ] x\n${"a".repeat(1024 * 1024)}` });
    expect(app.taskDocs.has("big/tasks.md")).toBe(false);
    expect(open(app, "big/tasks.md")).toBe(0);
  });

  it("follows external changes of lists that are not open", async () => {
    const { storage, app } = await started();
    storage.setExternal("web/tasks.md", "- [ ] w\n- [ ] w2\n");
    await app.settled();
    expect(textOf(app, "web/tasks.md")).toBe("- [ ] w\n- [ ] w2\n");
    expect(open(app, "web/tasks.md")).toBe(2);
    storage.setExternal("web/tasks.md", null);
    await app.settled();
    expect(app.taskDocs.has("web/tasks.md")).toBe(false);
  });

  it("starts empty for another workspace", async () => {
    const { storage, app } = await started();
    storage.addFolder("/other", { "inbox/a.md": "x" });
    await app.openWorkspace("/other");
    await app.settled();
    expect(app.taskDocs.size).toBe(0);
  });
});

describe("AppState task edits in the open list", () => {
  it("toggles instantly and saves after the delay", async () => {
    const { storage, app } = await started();
    expect(app.item).toBe("inbox/tasks.md");
    app.toggleTask("inbox/tasks.md", ref(app, "inbox/tasks.md", 1));
    expect(textOf(app, "inbox/tasks.md")).toBe("- [ ] one\n- [x] two\n");
    expect(open(app, "inbox/tasks.md")).toBe(1);
    expect(app.saveStatus).toEqual({ kind: "unsaved" });
    await vi.advanceTimersByTimeAsync(499);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n- [ ] two\n");
    await wait(app, 1);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n- [x] two\n");
    expect(app.saveStatus).toEqual({ kind: "saved", at: NOW + 500 });
  });

  it("adds, edits and moves tasks, keeping the file's line breaks", async () => {
    const { storage, app } = await started();
    app.selectFolder("api");
    await app.settled();
    const path = "api/tasks.md";
    expect(app.addTask(path, "new", { after: ref(app, path, 1) })).toEqual({
      line: 3,
      raw: "- [ ] new",
    });
    app.editTask(path, ref(app, path, 3), "renamed");
    expect(app.moveTask(path, ref(app, path, 3), -1)).toBe(1);
    expect(app.moveTask(path, ref(app, path, 4), 1)).toBeNull();
    expect(textOf(app, path)).toBe(
      "# Now\r\n- [ ] renamed\r\n- [ ] a\r\n  - [ ] a1\r\n- [x] b\r\n- [ ] c\r\n",
    );
    await wait(app);
    expect(await read(storage, path)).toBe(textOf(app, path));
  });

  it("ignores edits that change nothing, unknown lines and paths that are not task lists", async () => {
    const { app } = await started();
    expect(app.addTask("inbox/tasks.md", "  ", "end")).toBeNull();
    app.toggleTask("inbox/tasks.md", ref(app, "inbox/tasks.md", 9));
    app.toggleTask("inbox/idea.md", ref(app, "inbox/idea.md", 0));
    app.toggleTask("_archive/old/tasks.md", ref(app, "_archive/old/tasks.md", 0));
    app.toggleTask("missing/tasks.md", ref(app, "missing/tasks.md", 0));
    expect(app.saveStatus).toEqual({ kind: "saved", at: NOW });
    expect(app.deleteTask("inbox/tasks.md", ref(app, "inbox/tasks.md", 9))).toBeNull();
    // A line that holds no task says the list changed; other no-ops are silent.
    expect(app.toasts.map((toast) => toast.message)).toEqual([TASK_CHANGED, TASK_CHANGED]);
    expect(app.moveTask("inbox/tasks.md", ref(app, "inbox/tasks.md", 0), -1)).toBeNull();
    expect(app.toasts).toHaveLength(2);
  });

  describe("after the list changed on disk", () => {
    const stale = { line: 1, raw: "- [ ] two" };

    async function reloaded(text: string) {
      const context = await started();
      context.storage.setExternal("inbox/tasks.md", text);
      await context.app.settled();
      expect(textOf(context.app, "inbox/tasks.md")).toBe(text);
      return context;
    }

    it("finds each task again by its text", async () => {
      const { app } = await reloaded("- [ ] zero\n- [ ] one\n- [ ] two\n");
      app.toggleTask("inbox/tasks.md", stale);
      expect(textOf(app, "inbox/tasks.md")).toBe("- [ ] zero\n- [ ] one\n- [x] two\n");
      app.toggleTask("inbox/tasks.md", { line: 2, raw: "- [x] two" });
      app.editTask("inbox/tasks.md", stale, "2");
      expect(app.moveTask("inbox/tasks.md", { line: 2, raw: "- [ ] 2" }, -1)).toBe(1);
      expect(
        app.addTask("inbox/tasks.md", "x", { after: { line: 0, raw: "- [ ] one" } })?.line,
      ).toBe(3);
      expect(app.deleteTask("inbox/tasks.md", { line: 0, raw: "- [ ] one" })).toBe(2);
      expect(textOf(app, "inbox/tasks.md")).toBe("- [ ] zero\n- [ ] 2\n- [ ] x\n");
      expect(app.toasts.map((toast) => toast.message)).toEqual([taskDeletedMessage("one")]);
    });

    it("changes nothing and says so when the task is gone or ambiguous", async () => {
      const { app } = await reloaded("- [ ] two\n- [ ] zero\n- [ ] two\n");
      const before = textOf(app, "inbox/tasks.md");
      app.toggleTask("inbox/tasks.md", { line: 0, raw: "- [ ] one" });
      app.editTask("inbox/tasks.md", stale, "x");
      app.moveTask("inbox/tasks.md", stale, -1);
      app.deleteTask("inbox/tasks.md", stale);
      app.addTask("inbox/tasks.md", "x", { after: stale });
      expect(textOf(app, "inbox/tasks.md")).toBe(before);
      expect(app.toasts.map((toast) => toast.message)).toEqual(Array(5).fill(TASK_CHANGED));
    });
  });

  it("deletes with an undo toast that restores the exact lines", async () => {
    const { storage, app } = await started();
    const path = "api/tasks.md";
    app.selectFolder("api");
    await app.settled();
    expect(app.deleteTask(path, ref(app, path, 1))).toBe(1);
    expect(textOf(app, path)).toBe("# Now\r\n- [x] b\r\n- [ ] c\r\n");
    expect(app.toasts).toEqual([{ id: 1, message: taskDeletedMessage("a"), action: "Undo" }]);
    expect(app.latestUndo).toBe(1);
    await wait(app);
    expect(await read(storage, path)).toBe("# Now\r\n- [x] b\r\n- [ ] c\r\n");

    expect(await app.undoDelete(1)).toBe("task");
    expect(app.toasts).toEqual([]);
    expect(app.taskFocus).toMatchObject({ path, line: 1 });
    expect(textOf(app, path)).toBe(files[path]);
    await wait(app);
    expect(await read(storage, path)).toBe(files[path]);
    expect(await app.undoDelete(1)).toBeNull();
  });

  it("undoes a delete next to its old neighbour after the list changed", async () => {
    const { storage, app } = await started({
      "nest/tasks.md": "- [ ] a\n- [ ] b\n  - [ ] b1\n- [ ] c\n",
    });
    const path = "nest/tasks.md";
    app.selectFolder("nest");
    await app.settled();
    app.deleteTask(path, ref(app, path, 3));
    app.addTask(path, "new", { after: ref(app, path, 0) });
    expect(await app.undoDelete(1)).toBe("task");
    expect(textOf(app, path)).toBe("- [ ] a\n- [ ] new\n- [ ] b\n  - [ ] b1\n- [ ] c\n");
    expect(app.taskFocus).toMatchObject({ line: 4 });

    // After a move.
    app.deleteTask(path, ref(app, path, 4));
    app.moveTask(path, ref(app, path, 1), 1);
    await app.undoDelete(app.latestUndo ?? 0);
    expect(textOf(app, path)).toBe("- [ ] a\n- [ ] b\n  - [ ] b1\n- [ ] c\n- [ ] new\n");

    // After an external change.
    await wait(app);
    app.deleteTask(path, ref(app, path, 3));
    await wait(app);
    storage.setExternal(path, "- [ ] top\n- [ ] a\n- [ ] b\n  - [ ] b1\n- [ ] new\n");
    await app.settled();
    await app.undoDelete(app.latestUndo ?? 0);
    expect(textOf(app, path)).toBe("- [ ] top\n- [ ] a\n- [ ] b\n  - [ ] b1\n- [ ] c\n- [ ] new\n");
  });

  it("shows an undo in the text editor without losing it to the next keystroke", async () => {
    const { storage, app } = await started();
    app.deleteTask("inbox/tasks.md", ref(app, "inbox/tasks.md", 0));
    app.setTaskTextMode(true);
    expect(app.document).toMatchObject({ text: "- [ ] two\n" });
    await app.undoDelete(1);
    // The editor is handed the restored text as a change from disk.
    expect(app.document).toMatchObject({ text: "- [ ] one\n- [ ] two\n" });
    app.edit("inbox/tasks.md", () => "- [ ] one\n- [ ] two\n- [ ] typed\n");
    await wait(app);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n- [ ] two\n- [ ] typed\n");
  });

  it("drops a focus request when another item is selected", async () => {
    const { app } = await started();
    app.deleteTask("inbox/tasks.md", ref(app, "inbox/tasks.md", 0));
    app.selectItem("inbox/idea.md");
    await app.undoDelete(1);
    expect(app.taskFocus).not.toBeNull();
    app.selectItem("inbox/tasks.md");
    expect(app.taskFocus).toBeNull();
    app.selectFolder("api");
    expect(app.taskFocus).toBeNull();
  });

  it("names an empty deleted task generically", () => {
    expect(taskDeletedMessage("")).toBe("Deleted a task");
  });

  it("drops task undo toasts with the workspace", async () => {
    const { storage, app } = await started();
    app.deleteTask("inbox/tasks.md", ref(app, "inbox/tasks.md", 0));
    storage.addFolder("/other", {});
    await app.openWorkspace("/other");
    expect(app.toasts).toEqual([]);
    expect(app.latestUndo).toBeNull();
  });

  it("explains when the list is gone before an undo", async () => {
    const { storage, app } = await started();
    app.selectFolder("api");
    app.deleteTask("web/tasks.md", ref(app, "web/tasks.md", 0));
    await wait(app);
    storage.setExternal("web/tasks.md", null);
    await app.settled();
    expect(await app.undoDelete(1)).toBe("task");
    expect(app.toasts.map((toast) => toast.message)).toEqual([TASK_NOT_RESTORED]);
  });

  it("keeps both versions when the list changed on disk with unsaved edits", async () => {
    const { storage, app } = await started();
    app.toggleTask("inbox/tasks.md", ref(app, "inbox/tasks.md", 0));
    storage.setExternal("inbox/tasks.md", "- [ ] one\n- [ ] two\n- [ ] three\n");
    await app.settled();
    await vi.advanceTimersByTimeAsync(0);
    await app.settled();
    expect(await read(storage, "inbox/tasks.md")).toBe("- [x] one\n- [ ] two\n");
    const copy = (await storage.listFiles()).find((file) => file.path.includes("conflict"));
    expect(copy).toBeDefined();
    expect(app.toasts.map((toast) => toast.message)).toEqual([conflictMessage(copy?.path ?? "")]);
    expect(textOf(app, "inbox/tasks.md")).toBe("- [x] one\n- [ ] two\n");
  });

  it("reloads the view after an external change without unsaved edits", async () => {
    const { storage, app } = await started();
    storage.setExternal("inbox/tasks.md", "- [x] one\n");
    await app.settled();
    expect(textOf(app, "inbox/tasks.md")).toBe("- [x] one\n");
    expect(open(app, "inbox/tasks.md")).toBe(0);
  });

  it("uses a session started by a task edit while the list was still loading", async () => {
    const { storage, app } = await started();
    app.selectFolder("web");
    // The list is in the index already, so it can be edited before the read lands.
    app.toggleTask("web/tasks.md", ref(app, "web/tasks.md", 0));
    await app.settled();
    expect(app.document).toMatchObject({ status: "ready", text: "- [x] w" });
    expect(app.saveStatus).toEqual({ kind: "unsaved" });
    await wait(app);
    expect(await read(storage, "web/tasks.md")).toBe("- [x] w");
  });
});

describe("AppState task list shown as text", () => {
  it("shows the buffer in the editor and the editor's edits in the view", async () => {
    const { storage, app } = await started();
    app.toggleTask("inbox/tasks.md", ref(app, "inbox/tasks.md", 0));
    app.setTaskTextMode(true);
    expect(app.taskTextMode).toBe(true);
    expect(app.document).toMatchObject({ text: "- [x] one\n- [ ] two\n" });
    app.edit("inbox/tasks.md", () => "- [x] one\n- [ ] two\n- [ ] typed\n");
    app.setTaskTextMode(true);
    app.setTaskTextMode(false);
    expect(app.taskTextMode).toBe(false);
    expect(textOf(app, "inbox/tasks.md")).toBe("- [x] one\n- [ ] two\n- [ ] typed\n");
    expect(open(app, "inbox/tasks.md")).toBe(2);
    await wait(app);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [x] one\n- [ ] two\n- [ ] typed\n");
  });

  it("counts typed tasks once they are saved", async () => {
    const { app } = await started();
    app.setTaskTextMode(true);
    app.edit("inbox/tasks.md", () => "- [ ] only\n");
    await wait(app);
    expect(open(app, "inbox/tasks.md")).toBe(1);
  });

  it("applies only to task lists and resets when another item is selected", async () => {
    const { app } = await started();
    app.setTaskTextMode(true);
    app.selectItem("inbox/idea.md");
    expect(app.taskTextMode).toBe(false);
    app.setTaskTextMode(true);
    expect(app.taskTextMode).toBe(false);
  });

  it("switches without a session while the list is not loaded", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "readFile").mockRejectedValueOnce(new StorageError("Io", "boom"));
    app.selectFolder("web");
    await app.settled();
    app.setTaskTextMode(true);
    expect(app.taskTextMode).toBe(true);
    app.setTaskTextMode(false);
    expect(app.taskTextMode).toBe(false);
  });
});

describe("AppState done tasks", () => {
  it("remembers which lists hide their done tasks, until another workspace opens", async () => {
    const { storage, app } = await started();
    app.toggleHideDone("api/tasks.md");
    app.toggleHideDone(ALL_TASKS);
    expect([...app.hideDone]).toEqual(["api/tasks.md", ALL_TASKS]);
    app.toggleHideDone("api/tasks.md");
    expect(app.hideDone.has("api/tasks.md")).toBe(false);
    storage.addFolder("/other", {});
    await app.openWorkspace("/other");
    expect(app.hideDone.size).toBe(0);
  });
});

describe("AppState task detail", () => {
  it("rewrites the detail lines of a task through its session", async () => {
    const { storage, app } = await started();
    app.setTaskDetail("inbox/tasks.md", ref(app, "inbox/tasks.md", 0), "why\n\nhow");
    expect(textOf(app, "inbox/tasks.md")).toBe("- [ ] one\n  why\n\n  how\n- [ ] two\n");
    await wait(app);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n  why\n\n  how\n- [ ] two\n");
    app.setTaskDetail("inbox/tasks.md", { line: 0, raw: "- [ ] gone" }, "x");
    expect(app.toasts.map((toast) => toast.message)).toEqual([TASK_CHANGED]);
  });

  it("adds subtasks with the block's indentation", async () => {
    const { app } = await started();
    const sub = app.addTask("api/tasks.md", "a2", {
      after: ref(app, "api/tasks.md", 1),
      nested: true,
    });
    expect(sub).toEqual({ line: 3, raw: "  - [ ] a2" });
    expect(textOf(app, "api/tasks.md")).toBe(
      "# Now\r\n- [ ] a\r\n  - [ ] a1\r\n  - [ ] a2\r\n- [x] b\r\n- [ ] c\r\n",
    );
  });
});

describe("AppState linked notes", () => {
  const linked = {
    "p/tasks.md": "- [ ] read [note](spec.md)\n- [ ] gone [note](missing%20one.md)\n- [ ] plain\n",
    "p/spec.md": "# Spec\n",
  };

  it("opens an existing linked note with editor focus", async () => {
    const { app } = await started(linked);
    expect(app.hasNote("p/spec.md")).toBe(true);
    expect(app.hasNote("p/tasks.md")).toBe(false);
    const focus = app.editorFocusRequest;
    app.selectFolder(ALL_TASKS);
    app.openTaskNote("p/tasks.md", ref(app, "p/tasks.md", 0));
    expect(app.folder).toBe("p");
    expect(app.item).toBe("p/spec.md");
    expect(app.editorFocusRequest).toBe(focus + 1);
    await app.settled();
    expect(app.document).toMatchObject({ status: "ready", text: "# Spec\n" });
  });

  it("offers to create a missing linked note and opens it", async () => {
    const { storage, app } = await started(linked);
    app.openTaskNote("p/tasks.md", ref(app, "p/tasks.md", 1));
    expect(app.toasts).toEqual([
      { id: 1, message: missingNoteMessage("missing one.md"), action: "Create" },
    ]);
    expect(await app.runToastAction(1)).toBe("create");
    expect(await read(storage, "p/missing one.md")).toBe("# gone\n");
    expect(app.item).toBe("p/missing one.md");
    expect(app.toasts).toEqual([]);
  });

  it("says when the missing note was created elsewhere meanwhile", async () => {
    const { storage, app } = await started({
      ...linked,
      "p/tasks.md": "- [ ] a [n](x.md)\n- [ ] b [n](.hidden/y.md)\n",
    });
    app.openTaskNote("p/tasks.md", ref(app, "p/tasks.md", 0));
    storage.setExternal("p/x.md", "theirs", false);
    await app.runToastAction(1);
    expect(app.toasts.map((toast) => toast.message)).toEqual([nameTakenMessage("x.md")]);
    expect(await read(storage, "p/x.md")).toBe("theirs");
    // A link to a hidden path is offered too, but the note could not be shown.
    app.openTaskNote("p/tasks.md", ref(app, "p/tasks.md", 1));
    await app.runToastAction(app.toasts.at(-1)?.id ?? 0);
    expect(app.toasts.at(-1)?.message).toBe(createNoteFailedMessage(NOTE_NOT_SHOWN));
  });

  it("does nothing without a link and explains a task that changed", async () => {
    const { app } = await started(linked);
    app.openTaskNote("p/tasks.md", ref(app, "p/tasks.md", 2));
    expect(app.toasts).toEqual([]);
    app.openTaskNote("p/tasks.md", { line: 0, raw: "- [ ] other" });
    expect(app.toasts.map((toast) => toast.message)).toEqual([TASK_CHANGED]);
    app.openNote("p/tasks.md");
    expect(app.item).not.toBe("p/tasks.md");
  });

  it("creates a note from a task, links it and opens it", async () => {
    const { storage, app } = await started({
      ...linked,
      "p/tasks.md": "- [ ] Ship it: now [old](https://x.dev)\n",
    });
    const focus = app.editorFocusRequest;
    await app.createNoteFromTask("p/tasks.md", ref(app, "p/tasks.md", 0));
    expect(await read(storage, "p/Ship it now.md")).toBe("# Ship it: now\n");
    expect(textOf(app, "p/tasks.md")).toBe(
      "- [ ] Ship it: now [old](https://x.dev) [note](Ship%20it%20now.md)\n",
    );
    expect(app.item).toBe("p/Ship it now.md");
    expect(app.editorFocusRequest).toBe(focus + 1);
    await wait(app);
    expect(await read(storage, "p/tasks.md")).toBe(
      "- [ ] Ship it: now [old](https://x.dev) [note](Ship%20it%20now.md)\n",
    );
  });

  it("numbers the name when it is taken, also when a file appears meanwhile", async () => {
    const { storage, app } = await started({ "p/tasks.md": "- [ ] plan\n", "p/plan.md": "x" });
    const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementationOnce(async (path, contents, options) => {
      storage.setExternal("p/plan 2.md", "late", false);
      return write(path, contents, options);
    });
    await app.createNoteFromTask("p/tasks.md", ref(app, "p/tasks.md", 0));
    expect(await read(storage, "p/plan 3.md")).toBe("# plan\n");
    expect(textOf(app, "p/tasks.md")).toBe("- [ ] plan [note](plan%203.md)\n");
  });

  it("reports failures and tasks that changed", async () => {
    const { storage, app } = await started({ "p/tasks.md": "- [ ] plan\n" });
    await app.createNoteFromTask("p/tasks.md", { line: 0, raw: "- [ ] other" });
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "disk full"));
    await app.createNoteFromTask("p/tasks.md", ref(app, "p/tasks.md", 0));
    expect(app.toasts.map((toast) => toast.message)).toEqual([
      TASK_CHANGED,
      createNoteFailedMessage("disk full"),
    ]);
    vi.spyOn(storage, "writeFile").mockRejectedValue(new StorageError("Conflict", "taken"));
    await app.createNoteFromTask("p/tasks.md", ref(app, "p/tasks.md", 0));
    expect(app.toasts.at(-1)?.message).toBe(NO_FREE_NOTE_NAME);
  });

  it("runs undo through the toast action too, and drops actions with the workspace", async () => {
    const { storage, app } = await started(linked);
    app.deleteTask("p/tasks.md", ref(app, "p/tasks.md", 2));
    expect(await app.runToastAction(1)).toBe("task");
    app.openTaskNote("p/tasks.md", ref(app, "p/tasks.md", 1));
    storage.addFolder("/other", {});
    await app.openWorkspace("/other");
    expect(app.toasts).toEqual([]);
    expect(await app.runToastAction(2)).toBeNull();
  });
});

describe("AppState all tasks", () => {
  it("edits lists of every project through sessions created on demand", async () => {
    const { storage, app } = await started();
    app.selectFolder(ALL_TASKS);
    app.toggleTask("api/tasks.md", ref(app, "api/tasks.md", 1));
    app.toggleTask("web/tasks.md", ref(app, "web/tasks.md", 0));
    expect(open(app, "api/tasks.md")).toBe(1);
    expect(open(app, "web/tasks.md")).toBe(0);
    await wait(app);
    expect(await read(storage, "api/tasks.md")).toBe(
      "# Now\r\n- [x] a\r\n  - [ ] a1\r\n- [x] b\r\n- [ ] c\r\n",
    );
    expect(await read(storage, "web/tasks.md")).toBe("- [x] w");

    // Sessions are dropped once saved; later edits start from the saved version.
    app.toggleTask("web/tasks.md", ref(app, "web/tasks.md", 0));
    await wait(app);
    expect(await read(storage, "web/tasks.md")).toBe("- [ ] w");
  });

  it("saves pending edits when another item is selected", async () => {
    const { storage, app } = await started();
    app.selectFolder(ALL_TASKS);
    app.addTask("web/tasks.md", "w2", { after: ref(app, "web/tasks.md", 0) });
    app.selectItem("api/tasks.md");
    await vi.advanceTimersByTimeAsync(0);
    expect(await read(storage, "web/tasks.md")).toBe("- [ ] w\n- [ ] w2");
  });

  it("keeps both versions when a list changed on disk before the index caught up", async () => {
    const { storage, app } = await started();
    app.selectFolder(ALL_TASKS);
    storage.setExternal("web/tasks.md", "- [ ] changed", false);
    app.toggleTask("web/tasks.md", ref(app, "web/tasks.md", 0));
    await wait(app);
    expect(await read(storage, "web/tasks.md")).toBe("- [x] w");
    const names = (await storage.listFiles()).map((file) => file.path);
    expect(names.some((path) => path.startsWith("web/tasks (conflict"))).toBe(true);
  });

  it("applies All tasks edits again on top of a newer disk version before keeping a copy", async () => {
    const { storage, app } = await started();
    app.selectFolder(ALL_TASKS);
    // The index has not seen this change yet.
    storage.setExternal("web/tasks.md", "- [ ] zero\n- [ ] w", false);
    app.toggleTask("web/tasks.md", ref(app, "web/tasks.md", 0));
    app.addTask("web/tasks.md", "w2", { after: ref(app, "web/tasks.md", 0) });
    await wait(app);
    expect(await read(storage, "web/tasks.md")).toBe("- [ ] zero\n- [x] w\n- [ ] w2");
    const names = (await storage.listFiles()).map((file) => file.path);
    expect(names.some((path) => path.includes("conflict"))).toBe(false);
    expect(textOf(app, "web/tasks.md")).toBe("- [ ] zero\n- [x] w\n- [ ] w2");
    expect(app.toasts).toEqual([]);
  });

  it("forgets a list that grew over 1 MiB", async () => {
    const { storage, app } = await started();
    storage.setExternal("web/tasks.md", `- [ ] w\n${"a".repeat(1024 * 1024)}`);
    await app.settled();
    expect(app.taskDocs.has("web/tasks.md")).toBe(false);
  });

  it("does not let background reads replace edits that are not saved yet", async () => {
    const { storage, app } = await started();
    app.selectFolder(ALL_TASKS);
    app.toggleTask("web/tasks.md", ref(app, "web/tasks.md", 0));
    storage.emitChange({ paths: ["web/tasks.md"], rescan: true });
    await app.settled();
    expect(textOf(app, "web/tasks.md")).toBe("- [x] w");
  });

  it("builds rows from the index", async () => {
    const { app } = await started();
    const doc = app.taskDocs.get("api/tasks.md");
    expect(
      doc && taskRows("api/tasks.md", doc, { hideDone: false, exists: () => false }).length,
    ).toBe(5);
  });
});

describe("AppState new project", () => {
  it("creates the folder with an empty task list and opens it", async () => {
    const { storage, app } = await started();
    expect(await app.createProject("  side ")).toEqual({ kind: "created", name: "side" });
    expect(await read(storage, "side/tasks.md")).toBe("");
    expect(app.folder).toBe("side");
    expect(app.item).toBe("side/tasks.md");
    expect(app.taskTextMode).toBe(false);
    expect(app.taskDocs.get("side/tasks.md")?.text).toBe("");
    expect(app.taskFocus).toMatchObject({ path: "side/tasks.md", line: null });
    expect(app.workspace.projects.map((project) => project.name)).toContain("side");

    // The new list takes tasks right away.
    expect(app.addTask("side/tasks.md", "first", "end")).toEqual({ line: 0, raw: "- [ ] first" });
    await wait(app);
    expect(await read(storage, "side/tasks.md")).toBe("- [ ] first\n");
  });

  it("refuses invalid, existing and ignored names", async () => {
    const { app } = await started({}, JSON.stringify({ version: 1, ignore: ["secret*"] }));
    expect(await app.createProject("API")).toEqual({
      kind: "invalid",
      reason: "A project named api already exists.",
    });
    expect(await app.createProject("_x")).toMatchObject({ kind: "invalid" });
    expect(await app.createProject("secret-stuff")).toEqual({
      kind: "invalid",
      reason: PROJECT_IGNORED,
    });
  });

  it("refuses a folder that already has a task list on disk", async () => {
    const { storage, app } = await started();
    storage.setExternal("late/tasks.md", "", false);
    expect(await app.createProject("late")).toEqual({
      kind: "invalid",
      reason: projectExistsMessage("late"),
    });
  });

  it("reports other failures in a toast", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(
      new StorageError("PermissionDenied", "no"),
    );
    expect(await app.createProject("side")).toEqual({ kind: "failed" });
    expect(app.toasts.map((toast) => toast.message)).toEqual([createProjectFailedMessage("no")]);
  });

  it("does nothing before a workspace is open or after it changed", async () => {
    const { storage, app } = setup();
    expect(await app.createProject("side")).toEqual({ kind: "failed" });
    await app.start();
    await app.settled();
    storage.addFolder("/other", {});
    let release: () => void = () => undefined;
    const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementationOnce(
      (path, contents, options) =>
        new Promise((resolve, reject) => {
          release = () => void write(path, contents, options).then(resolve, reject);
        }),
    );
    const creating = app.createProject("side");
    await vi.advanceTimersByTimeAsync(0);
    const switching = app.openWorkspace("/other");
    await vi.advanceTimersByTimeAsync(0);
    release();
    expect(await creating).toEqual({ kind: "failed" });
    await switching;
  });
});

describe("AppState linked notes, review fixes", () => {
  it("refuses to create a missing note whose name is not valid, and says why", async () => {
    const { storage, app } = await started({
      "p/tasks.md": "- [ ] a [n](CON.md)\n- [ ] b [n](%20x.md)\n- [ ] c [l](tasks.md)\n",
    });
    app.openTaskNote("p/tasks.md", ref(app, "p/tasks.md", 0));
    await app.runToastAction(app.toasts.at(-1)?.id ?? 0);
    expect(app.toasts.at(-1)?.message).toBe(
      createNoteFailedMessage("CON is a reserved name on Windows."),
    );
    app.openTaskNote("p/tasks.md", ref(app, "p/tasks.md", 1));
    await app.runToastAction(app.toasts.at(-1)?.id ?? 0);
    expect(app.toasts.at(-1)?.message).toBe(createNoteFailedMessage(SPACED_NAME));
    const inP = (await storage.listFiles()).filter((file) => file.path.startsWith("p/"));
    expect(inP.map((file) => file.path)).toEqual(["p/tasks.md"]);
    // A link to a task list is no note link: nothing to open or create.
    const count = app.toasts.length;
    app.openTaskNote("p/tasks.md", ref(app, "p/tasks.md", 2));
    expect(app.toasts).toHaveLength(count);
  });

  it("says when the note was created but the task changed before it could be linked", async () => {
    const { storage, app } = await started({ "p/tasks.md": "- [ ] plan\n" });
    const write = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementationOnce(async (path, contents, options) => {
      const written = await write(path, contents, options);
      app.editTask("p/tasks.md", ref(app, "p/tasks.md", 0), "renamed");
      return written;
    });
    await app.createNoteFromTask("p/tasks.md", ref(app, "p/tasks.md", 0));
    expect(await read(storage, "p/plan.md")).toBe("# plan\n");
    expect(app.toasts.map((toast) => toast.message)).toEqual([notLinkedMessage("plan.md")]);
    expect(textOf(app, "p/tasks.md")).toBe("- [ ] renamed\n");
  });

  it("creates one note when asked twice for the same task at once", async () => {
    const { storage, app } = await started({ "p/tasks.md": "- [ ] plan\n" });
    const task = ref(app, "p/tasks.md", 0);
    await Promise.all([
      app.createNoteFromTask("p/tasks.md", task),
      app.createNoteFromTask("p/tasks.md", task),
    ]);
    const notes = (await storage.listFiles()).filter((file) => file.path.startsWith("p/"));
    expect(notes.map((file) => file.path)).toEqual(["p/plan.md", "p/tasks.md"]);
    expect(textOf(app, "p/tasks.md")).toBe("- [ ] plan [note](plan.md)\n");
  });
});
