import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCaptureBus, MemoryStorage, StorageError, type CaptureResult } from "$lib/storage";
import {
  AppState,
  captureTaskFailedMessage,
  capturedElsewhereMessage,
  capturedNoteMessage,
  capturedTaskMessage,
  createNoteFailedMessage,
  HANDLED_CAPTURES,
  missingProjectMessage,
  NO_FREE_NOTE_NAME,
  NOTHING_TO_CAPTURE,
  OPEN_WORKSPACE_FIRST,
  SHORTCUT_TAKEN,
  TASK_LIST_APPEARED,
  TASK_LIST_HIDDEN,
  TASK_LIST_TOO_LARGE,
} from "./appState.svelte";

const ROOT = "/notes";
const NOW = new Date(2026, 9, 8, 9, 5).getTime();

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] one\n",
  "inbox/idea.md": "# Idea\n",
  "api/tasks.md": "# Now\r\n- [ ] a\r\n",
  "api/deploy.md": "# Deploy\n",
  "web/readme.md": "# Readme\n",
};

function setup(extra: Record<string, string> = {}, options: { defer?: boolean } = {}) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...files, ...extra } },
    settings: JSON.stringify({ version: 1, workspace: ROOT }),
  });
  const deferred: (() => void)[] = [];
  const app = new AppState(storage, {
    defer: options.defer ? (task) => deferred.push(task) : (task) => task(),
    schedule: (task) => task(),
    saveDelay: 10,
  });
  return { storage, app, deferred };
}

async function started(extra: Record<string, string> = {}) {
  const context = setup(extra);
  await context.app.start();
  await context.app.settled();
  return context;
}

async function saved(app: AppState) {
  await vi.advanceTimersByTimeAsync(20);
  await app.settled();
}

const read = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AppState.capture tasks", () => {
  it("appends a task to an existing list and keeps the selection", async () => {
    const { storage, app } = await started();
    app.selectFolder("web");
    await app.settled();
    const before = { folder: app.folder, item: app.item };

    const outcome = await app.capture("task", "  call the bank  ", "inbox");
    expect(outcome).toEqual({ ok: true, message: capturedTaskMessage("inbox") });
    expect(app.taskDocs.get("inbox/tasks.md")?.text).toBe("- [ ] one\n- [ ] call the bank\n");
    expect(app.summaries.get("inbox/tasks.md")?.openTasks).toBe(2);
    expect(app.toasts.at(-1)?.message).toBe("Added to inbox");
    expect({ folder: app.folder, item: app.item }).toEqual(before);

    await saved(app);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n- [ ] call the bank\n");
  });

  it("keeps the list's CRLF line endings", async () => {
    const { storage, app } = await started();
    await app.capture("task", "b", "api");
    await saved(app);
    expect(await read(storage, "api/tasks.md")).toBe("# Now\r\n- [ ] a\r\n- [ ] b\r\n");
  });

  it("adds to the open list's buffer, unsaved edits included", async () => {
    const { storage, app } = await started();
    app.selectItem("inbox/tasks.md");
    app.addTask("inbox/tasks.md", "local", "end");
    await app.capture("task", "captured", "inbox");
    await saved(app);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n- [ ] local\n- [ ] captured\n");
  });

  it("updates a list shown as text", async () => {
    const { app } = await started();
    app.selectItem("inbox/tasks.md");
    await app.settled();
    app.setTaskTextMode(true);
    await app.capture("task", "two", "inbox");
    expect(app.document).toMatchObject({ text: "- [ ] one\n- [ ] two\n" });
  });

  it("creates a missing task list, create-only", async () => {
    const { storage, app } = await started();
    const write = vi.spyOn(storage, "writeFile");
    const outcome = await app.capture("task", "first\nline", "web");
    expect(outcome.ok).toBe(true);
    expect(write).toHaveBeenCalledWith("web/tasks.md", "- [ ] first line\n", {
      expectedHash: null,
    });
    expect(app.taskDocs.get("web/tasks.md")?.text).toBe("- [ ] first line\n");
    expect(app.workspace.projects.find((project) => project.name === "web")?.tasks?.path).toBe(
      "web/tasks.md",
    );

    // Later captures go through the list's session.
    await app.capture("task", "second", "web");
    await saved(app);
    expect(await read(storage, "web/tasks.md")).toBe("- [ ] first line\n- [ ] second\n");
  });

  it("creates the inbox task list when the inbox folder does not exist", async () => {
    const { storage, app } = await started({});
    await app.capture("task", "x", "inbox");
    await saved(app);
    expect(await read(storage, "inbox/tasks.md")).toBe("- [ ] one\n- [ ] x\n");

    const empty = new MemoryStorage({
      folders: { "/empty": {} },
      settings: JSON.stringify({ version: 1, workspace: "/empty" }),
    });
    const fresh = new AppState(empty, { defer: (task) => task(), schedule: (task) => task() });
    await fresh.start();
    await fresh.settled();
    expect(await fresh.capture("task", "x", "inbox")).toEqual({
      ok: true,
      message: "Added to inbox",
    });
    expect(await read(empty, "inbox/tasks.md")).toBe("- [ ] x\n");
  });

  it("reads a list that was not read in the background yet", async () => {
    const { storage, app, deferred } = setup({}, { defer: true });
    await app.start();
    expect(deferred).toHaveLength(1);
    const outcome = await app.capture("task", "early", "api");
    expect(outcome.ok).toBe(true);
    for (const task of deferred) task();
    await saved(app);
    expect(await read(storage, "api/tasks.md")).toBe("# Now\r\n- [ ] a\r\n- [ ] early\r\n");
  });

  it("fails when the list cannot be read", async () => {
    const { storage, app } = setup({}, { defer: true });
    await app.start();
    vi.spyOn(storage, "readFile").mockRejectedValueOnce(new StorageError("Io", "disk error"));
    expect(await app.capture("task", "x", "api")).toEqual({
      ok: false,
      message: captureTaskFailedMessage("api", "disk error"),
    });
  });

  it("refuses lists that are too large to keep parsed", async () => {
    const big = `${"- [ ] x\n".repeat(140_000)}`;
    const { app } = setup({ "api/tasks.md": big }, { defer: true });
    await app.start();
    expect(await app.capture("task", "x", "api")).toEqual({
      ok: false,
      message: captureTaskFailedMessage("api", TASK_LIST_TOO_LARGE),
    });
  });

  it("refuses a task list hidden by the ignore patterns", async () => {
    const { app } = await started({ ".kaido/config.json": '{"version":1,"ignore":["tasks.md"]}' });
    expect(await app.capture("task", "x", "web")).toEqual({
      ok: false,
      message: captureTaskFailedMessage("web", TASK_LIST_HIDDEN),
    });
  });

  it("asks to try again when the list was created on disk meanwhile", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Conflict", "exists"));
    expect(await app.capture("task", "x", "web")).toEqual({
      ok: false,
      message: captureTaskFailedMessage("web", TASK_LIST_APPEARED),
    });
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "disk full"));
    expect(await app.capture("task", "x", "web")).toEqual({
      ok: false,
      message: captureTaskFailedMessage("web", "disk full"),
    });
  });

  it("refuses empty text, unknown projects and a missing workspace", async () => {
    const { app } = await started();
    expect(await app.capture("task", "  \n ", "inbox")).toEqual({
      ok: false,
      message: NOTHING_TO_CAPTURE,
    });
    expect(await app.capture("task", "x", "gone")).toEqual({
      ok: false,
      message: missingProjectMessage("gone"),
    });
    const idle = new AppState(new MemoryStorage());
    expect(await idle.capture("task", "x", "inbox")).toEqual({
      ok: false,
      message: OPEN_WORKSPACE_FIRST,
    });
  });

  /** Holds the next write's answer until the workspace switch has begun. */
  function holdNextWrite(storage: MemoryStorage) {
    const original = storage.writeFile.bind(storage);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(storage, "writeFile").mockImplementationOnce(async (...args) => {
      const written = await original(...args);
      await gate;
      return written;
    });
    return release;
  }

  async function switchWhileWriting(app: AppState, storage: MemoryStorage, release: () => void) {
    storage.addFolder("/other", {});
    const switching = app.openWorkspace("/other");
    const stillOpen = () => app.phase.kind === "ready" && app.phase.root === ROOT;
    for (let tries = 0; tries < 100 && stillOpen(); tries += 1) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(stillOpen()).toBe(false);
    release();
    await switching;
  }

  it("drops a capture when the workspace is switched before it is written", async () => {
    const { storage, app } = setup({}, { defer: true });
    await app.start();
    storage.addFolder("/other", {});
    const write = vi.spyOn(storage, "writeFile");
    // The list is read first; the switch comes before the task is added.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementationOnce(async (path) => {
      const file = await original(path);
      await gate;
      return file;
    });
    const capture = app.capture("task", "x", "api");
    await switchWhileWriting(app, storage, release);
    expect(await capture).toEqual({ ok: false, message: "The workspace was closed." });
    expect(write).not.toHaveBeenCalled();
  });

  it("says where a note went when the workspace was switched while writing it", async () => {
    const { storage, app } = await started();
    const release = holdNextWrite(storage);
    const capture = app.capture("note", "Plan", "web");
    await switchWhileWriting(app, storage, release);
    expect(await capture).toEqual({
      ok: true,
      message: capturedElsewhereMessage(capturedNoteMessage("web/Plan.md"), ROOT),
    });
    expect(app.toasts.some((toast) => toast.message.includes("Plan"))).toBe(false);
    await storage.openWorkspace(ROOT);
    expect(await read(storage, "web/Plan.md")).toBe("# Plan\n");
  });

  it("says where a new task list went when the workspace was switched while writing it", async () => {
    const { storage, app } = await started();
    const release = holdNextWrite(storage);
    const capture = app.capture("task", "deploy", "web");
    await switchWhileWriting(app, storage, release);
    expect(await capture).toEqual({
      ok: true,
      message: capturedElsewhereMessage(capturedTaskMessage("web"), ROOT),
    });
    expect(app.taskDocs.has("web/tasks.md")).toBe(false);
    await storage.openWorkspace(ROOT);
    expect(await read(storage, "web/tasks.md")).toBe("- [ ] deploy\n");
  });

  it("refuses project names outside the workspace's projects", async () => {
    const { storage, app } = await started({ "_archive/old/tasks.md": "- [ ] old\n" });
    const write = vi.spyOn(storage, "writeFile");
    for (const project of ["../x", "/abs", "_archive", "_archive/old", ".git", "", "inbox/.."]) {
      expect(await app.capture("task", "x", project)).toEqual({
        ok: false,
        message: missingProjectMessage(project),
      });
      expect((await app.capture("note", "x", project)).ok).toBe(false);
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("drops a task capture when the app is disposed meanwhile", async () => {
    const { app } = setup({}, { defer: true });
    await app.start();
    const capture = app.capture("task", "x", "api");
    app.dispose();
    expect((await capture).ok).toBe(false);
  });
});

describe("AppState.capture notes", () => {
  it("creates a note named after the text without opening it", async () => {
    const { storage, app } = await started();
    const before = { folder: app.folder, item: app.item };
    const outcome = await app.capture("note", "Plan the trip", "api");
    expect(outcome).toEqual({ ok: true, message: capturedNoteMessage("api/Plan the trip.md") });
    expect(await read(storage, "api/Plan the trip.md")).toBe("# Plan the trip\n");
    expect(app.hasNote("api/Plan the trip.md")).toBe(true);
    expect(app.summaries.get("api/Plan the trip.md")?.title).toBe("Plan the trip");
    expect({ folder: app.folder, item: app.item }).toEqual(before);

    const toast = app.toasts.at(-1);
    expect(toast).toMatchObject({ message: "Note created: api/Plan the trip.md", action: "Open" });
    await app.runToastAction(toast?.id ?? 0);
    expect(app.item).toBe("api/Plan the trip.md");
  });

  it("numbers names that are taken", async () => {
    const { app } = await started({ "inbox/Idea.md": "# Idea\n" });
    expect((await app.capture("note", "idea", "inbox")).message).toBe(
      capturedNoteMessage("inbox/idea 2.md"),
    );
    expect((await app.capture("note", "idea", "inbox")).message).toBe(
      capturedNoteMessage("inbox/idea 3.md"),
    );
  });

  it("reports failures", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "disk full"));
    expect(await app.capture("note", "x", "inbox")).toEqual({
      ok: false,
      message: createNoteFailedMessage("disk full"),
    });
    vi.spyOn(storage, "writeFile").mockRejectedValue(new StorageError("Conflict", "exists"));
    expect(await app.capture("note", "x", "inbox")).toEqual({
      ok: false,
      message: NO_FREE_NOTE_NAME,
    });
  });
});

describe("AppState.connectCapture", () => {
  it("answers submits and project requests through the channel", async () => {
    const { storage, app } = await started();
    const bus = new MemoryCaptureBus();
    const stop = app.connectCapture(bus.host);
    await vi.advanceTimersByTimeAsync(0);
    const results: CaptureResult[] = [];
    const projects = vi.fn();
    await bus.channel.onResult((result) => results.push(result));
    await bus.channel.onProjects(projects);

    await bus.channel.requestProjects();
    expect(projects).toHaveBeenCalledWith({
      projects: ["inbox", "api", "web"],
      workspaceOpen: true,
    });

    await bus.channel.submit({ id: "a", kind: "task", text: "from capture", project: "web" });
    await app.settled();
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([{ id: "a", ok: true, message: "Added to web" }]);
    expect(await read(storage, "web/tasks.md")).toBe("- [ ] from capture\n");

    stop();
    await bus.channel.submit({ id: "b", kind: "task", text: "ignored", project: "web" });
    await app.settled();
    expect(results).toHaveLength(1);
    expect(app.toasts.some((toast) => toast.message === SHORTCUT_TAKEN)).toBe(false);
  });

  it("answers a capture delivered twice without writing it again", async () => {
    const { storage, app } = await started();
    const bus = new MemoryCaptureBus();
    app.connectCapture(bus.host);
    await vi.advanceTimersByTimeAsync(0);
    const results: CaptureResult[] = [];
    await bus.channel.onResult((result) => results.push(result));
    const write = vi.spyOn(storage, "writeFile");

    const submit = { id: "same", kind: "note" as const, text: "idea", project: "web" };
    await bus.channel.submit(submit);
    // Again while the first is being written, and again after it is done.
    await bus.channel.submit(submit);
    await app.settled();
    await vi.advanceTimersByTimeAsync(0);
    await bus.channel.submit(submit);
    await vi.advanceTimersByTimeAsync(0);

    const answer = { id: "same", ok: true, message: capturedNoteMessage("web/idea.md") };
    expect(results).toEqual([answer, answer, answer]);
    expect(write).toHaveBeenCalledOnce();
    expect(app.hasNote("web/idea 2.md")).toBe(false);
  });

  it("forgets the oldest handled captures", async () => {
    const { app } = await started();
    const bus = new MemoryCaptureBus();
    app.connectCapture(bus.host);
    await vi.advanceTimersByTimeAsync(0);
    const capture = vi.spyOn(app, "capture");
    for (let index = 0; index <= HANDLED_CAPTURES; index += 1) {
      await bus.channel.submit({ id: `${index}`, kind: "task", text: " ", project: "web" });
    }
    await bus.channel.submit({
      id: `${HANDLED_CAPTURES}`,
      kind: "task",
      text: " ",
      project: "web",
    });
    expect(capture).toHaveBeenCalledTimes(HANDLED_CAPTURES + 1);
    await bus.channel.submit({ id: "0", kind: "task", text: " ", project: "web" });
    expect(capture).toHaveBeenCalledTimes(HANDLED_CAPTURES + 2);
  });

  it("says no workspace is open", async () => {
    const app = new AppState(new MemoryStorage());
    const bus = new MemoryCaptureBus();
    app.connectCapture(bus.host);
    await vi.advanceTimersByTimeAsync(0);
    const projects = vi.fn();
    await bus.channel.onProjects(projects);
    await bus.channel.requestProjects();
    expect(projects).toHaveBeenCalledWith({ projects: [], workspaceOpen: false });
  });

  it("tells once that the shortcut is taken", async () => {
    const { app } = await started();
    const bus = new MemoryCaptureBus({
      shortcut: { registered: false, shortcut: "CommandOrControl+Alt+Space" },
    });
    app.connectCapture(bus.host);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.toasts.filter((toast) => toast.message === SHORTCUT_TAKEN)).toHaveLength(1);
  });

  it("keeps working when the channel fails", async () => {
    const { app } = await started();
    const bus = new MemoryCaptureBus();
    const host = {
      ...bus.host,
      onSubmit: () => Promise.reject(new Error("no events")),
      shortcutStatus: () => Promise.reject(new Error("no command")),
      sendProjects: () => Promise.reject(new Error("gone")),
    };
    const stop = app.connectCapture(host);
    await vi.advanceTimersByTimeAsync(0);
    await bus.channel.requestProjects();
    stop();
    expect(app.toasts).toEqual([]);
  });

  it("drops subscriptions that arrive after it was stopped", async () => {
    const { app } = await started();
    const bus = new MemoryCaptureBus();
    const stop = app.connectCapture(bus.host);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    const projects = vi.fn();
    await bus.channel.onProjects(projects);
    await bus.channel.requestProjects();
    expect(projects).not.toHaveBeenCalled();
  });
});
