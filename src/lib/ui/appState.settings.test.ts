import { describe, expect, it, vi } from "vitest";
import { ALL_TASKS } from "$lib/core/views";
import { MemoryCaptureBus, MemoryStorage, StorageError, type MemoryGitOptions } from "$lib/storage";
import {
  AppState,
  CAPTURE_UNAVAILABLE,
  CHOOSE_FOLDER,
  ENTER_URL,
  SETTINGS_CHANGED_INVALID,
  SETTINGS_CHANGES_NOT_SAVED,
  SETTINGS_INVALID,
  SETTINGS_KEEP_CHANGING,
  SETTINGS_WRITE_RETRIES,
  SHORTCUT_IN_USE,
  SHORTCUT_TAKEN,
  gitSetupFailedMessage,
  setupDoneMessage,
  setupFailedMessage,
} from "./appState.svelte";

const ROOT = "/notes";
const OTHER = "/other";

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] one\n- [x] two\n",
  "api/tasks.md": "- [ ] three\n",
  "api/deploy.md": "# Deploy\n",
};

interface Options {
  settings?: Record<string, unknown> | string | null;
  folders?: Record<string, Record<string, string>>;
  git?: MemoryGitOptions;
  remotes?: Record<string, Record<string, string>>;
}

function setup(options: Options = {}) {
  const settings =
    options.settings === undefined
      ? JSON.stringify({ version: 1, workspace: ROOT })
      : typeof options.settings === "string" || options.settings === null
        ? options.settings
        : JSON.stringify(options.settings);
  const storage = new MemoryStorage({
    folders: options.folders ?? { [ROOT]: { ...files }, [OTHER]: { "inbox/x.md": "x" } },
    settings,
    git: options.git ?? { unavailable: null, upstream: "origin/main" },
    remotes: options.remotes ?? {},
    pick: "/parent",
  });
  const app = new AppState(storage, {
    defer: (task) => task(),
    saveDelay: 5,
    sync: { commitDelay: 5 },
  });
  return { storage, app };
}

async function started(options: Options = {}) {
  const context = setup(options);
  await context.app.start();
  await context.app.settled();
  await context.app.syncIdle();
  return context;
}

function saved(storage: MemoryStorage): Record<string, unknown> {
  return JSON.parse(storage.settings ?? "{}") as Record<string, unknown>;
}

const toastMessages = (app: AppState) => app.toasts.map((toast) => toast.message);

describe("AppState device settings", () => {
  it("fills in defaults", async () => {
    const { app } = await started();
    expect(app.settings).toEqual({
      recentWorkspaces: [ROOT],
      editorFontSize: 15,
      autoSync: true,
      captureShortcut: "CommandOrControl+Alt+Space",
    });
    expect(toastMessages(app)).toEqual([]);
  });

  it("uses defaults for invalid fields and says so once", async () => {
    const { app } = await started({
      settings: { version: 1, workspace: ROOT, editorFontSize: 40, autoSync: "no" },
    });
    expect(app.settings.editorFontSize).toBe(15);
    expect(app.settings.autoSync).toBe(true);
    expect(toastMessages(app)).toEqual([SETTINGS_INVALID]);
    expect(app.warnings.map((warning) => warning.field)).toEqual(["editorFontSize", "autoSync"]);
  });

  it("clamps and saves the font size", async () => {
    const { storage, app } = await started();
    app.setEditorFontSize(25);
    app.setEditorFontSize(Number.NaN);
    await app.settingsSaved();
    expect(app.settings.editorFontSize).toBe(20);
    expect(saved(storage)["editorFontSize"]).toBe(20);
    app.setEditorFontSize(11.6);
    expect(app.settings.editorFontSize).toBe(12);
    const write = vi.spyOn(storage, "writeSettings");
    app.setEditorFontSize(12);
    expect(write).not.toHaveBeenCalled();
  });

  it("writes settings in order", async () => {
    const { storage, app } = await started();
    for (const size of [16, 17, 18]) app.setEditorFontSize(size);
    await app.settingsSaved();
    expect(saved(storage)["editorFontSize"]).toBe(18);
  });

  it("never overwrites a file it cannot read, and says once that changes are not saved", async () => {
    const broken = "{ not json";
    const { storage, app } = await started({ settings: broken });
    app.setEditorFontSize(18);
    app.setAutoSync(false);
    await app.settingsSaved();
    expect(storage.settings).toBe(broken);
    expect(app.settings.editorFontSize).toBe(18);
    const notSaved = app.warnings.filter(
      (warning) => warning.message === SETTINGS_CHANGES_NOT_SAVED,
    );
    expect(notSaved).toHaveLength(1);
  });

  it("reports failing settings writes as warnings", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "writeSettings").mockRejectedValueOnce(new StorageError("Io", "disk full"));
    app.setEditorFontSize(18);
    app.setEditorFontSize(19);
    await app.settingsSaved();
    expect(app.warnings.map((warning) => warning.message)).toContain("settings.json: disk full");
    expect(saved(storage)["editorFontSize"]).toBe(19);
  });
});

describe("AppState settings hot reload", () => {
  it("applies settings changed by another program", async () => {
    const { storage, app } = await started({
      settings: { version: 1, workspace: ROOT, recentWorkspaces: [ROOT] },
    });
    storage.setExternalSettings(
      JSON.stringify({
        version: 1,
        workspace: ROOT,
        recentWorkspaces: [ROOT, OTHER],
        editorFontSize: 18,
        autoSync: false,
        hideDone: { [ROOT]: ["inbox/tasks.md", "~/all-tasks"] },
      }),
    );
    await vi.waitFor(() => expect(app.settings.editorFontSize).toBe(18));
    expect(app.settings.recentWorkspaces).toEqual([ROOT, OTHER]);
    expect(app.sync?.auto).toBe(false);
    expect([...app.hideDone]).toEqual(["inbox/tasks.md", ALL_TASKS]);
    expect(app.phase).toEqual({ kind: "ready", root: ROOT });
    expect(toastMessages(app)).toEqual([]);
  });

  it("ignores reports of its own writes", async () => {
    const { storage, app } = await started();
    app.setEditorFontSize(18);
    await app.settingsSaved();
    const read = vi.spyOn(storage, "readSettings");
    storage.setExternalSettings(storage.settings);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    expect(app.settings.editorFontSize).toBe(18);
  });

  it("says when the new file has invalid values", async () => {
    const { storage, app } = await started();
    storage.setExternalSettings(JSON.stringify({ version: 1, editorFontSize: "big" }));
    await vi.waitFor(() => expect(toastMessages(app)).toEqual([SETTINGS_CHANGED_INVALID]));
    expect(app.warnings.map((warning) => warning.field)).toEqual(["editorFontSize"]);
    // The same problem again is not announced twice.
    storage.setExternalSettings(JSON.stringify({ version: 1, editorFontSize: "big", x: 1 }));
    await vi.waitFor(() => expect(app.deviceSettings).not.toHaveProperty("workspace"));
    expect(toastMessages(app)).toEqual([SETTINGS_CHANGED_INVALID]);
  });

  it("keeps the settings when the file cannot be read", async () => {
    const { storage, app } = await started({
      settings: { version: 1, workspace: ROOT, editorFontSize: 17 },
    });
    vi.spyOn(storage, "readSettings").mockRejectedValue(new StorageError("Io", "busy"));
    storage.setExternalSettings("{}");
    storage.setExternalSettings("{}");
    await vi.waitFor(() =>
      expect(app.warnings.map((warning) => warning.message)).toContain("settings.json: busy"),
    );
    expect(
      app.warnings.filter((warning) => warning.message === "settings.json: busy"),
    ).toHaveLength(1);
    expect(app.settings.editorFontSize).toBe(17);
  });

  it("keeps every setting when the new file is broken, and auto-sync stays off", async () => {
    const { storage, app } = await started({
      settings: { version: 1, workspace: ROOT, autoSync: false, editorFontSize: 18 },
    });
    const before = app.deviceSettings;
    storage.setExternalSettings("{ not json");
    await vi.waitFor(() => expect(toastMessages(app)).toEqual([SETTINGS_CHANGED_INVALID]));
    await app.settingsSaved();
    expect(app.deviceSettings).toEqual(before);
    expect(app.settings.editorFontSize).toBe(18);
    expect(app.sync?.auto).toBe(false);
    await app.createNote();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await app.syncIdle();
    expect(storage.git.calls.sync).toBe(0);
    expect(storage.git.commits).toHaveLength(0);
    expect(app.warnings.map((warning) => warning.message)).toContain(
      "settings.json: not valid JSON; keeping the current settings and leaving the file unchanged",
    );
    // The broken file is not overwritten by later changes.
    app.setEditorFontSize(19);
    await app.settingsSaved();
    expect(storage.settings).toBe("{ not json");
    expect(app.warnings.map((warning) => warning.message)).toContain(SETTINGS_CHANGES_NOT_SAVED);
    // Once fixed, the file applies and is written again.
    storage.setExternalSettings(JSON.stringify({ version: 1, workspace: ROOT, autoSync: false }));
    await app.settingsSaved();
    expect(app.settings.editorFontSize).toBe(15);
    app.setEditorFontSize(17);
    await app.settingsSaved();
    expect(saved(storage)).toEqual({
      version: 1,
      workspace: ROOT,
      autoSync: false,
      editorFontSize: 17,
    });
  });

  it("keeps every setting when the new file is from a newer version", async () => {
    const { storage, app } = await started({
      settings: { version: 1, workspace: ROOT, autoSync: false, editorFontSize: 18 },
    });
    storage.setExternalSettings(JSON.stringify({ version: 2, autoSync: true }));
    await vi.waitFor(() => expect(toastMessages(app)).toEqual([SETTINGS_CHANGED_INVALID]));
    expect(app.settings.autoSync).toBe(false);
    expect(app.settings.editorFontSize).toBe(18);
    expect(app.sync?.auto).toBe(false);
  });

  it("keeps the current value of fields that became invalid", async () => {
    const { storage, app } = await started({
      settings: {
        version: 1,
        workspace: ROOT,
        autoSync: false,
        editorFontSize: 18,
        captureShortcut: "Alt+K",
        hideDone: { [ROOT]: ["inbox/tasks.md"] },
      },
    });
    const bus = new MemoryCaptureBus();
    app.connectCapture(bus.host);
    await vi.waitFor(() => expect(app.captureShortcut?.shortcut).toBe("Alt+K"));
    const invalid = {
      version: 1,
      workspace: ROOT,
      autoSync: "no",
      editorFontSize: 99,
      captureShortcut: "Space",
      hideDone: "x",
    };
    storage.setExternalSettings(JSON.stringify(invalid));
    await vi.waitFor(() => expect(toastMessages(app)).toEqual([SETTINGS_CHANGED_INVALID]));
    expect(app.settings).toMatchObject({
      autoSync: false,
      editorFontSize: 18,
      captureShortcut: "Alt+K",
    });
    expect(app.sync?.auto).toBe(false);
    expect([...app.hideDone]).toEqual(["inbox/tasks.md"]);
    expect(app.warnings.map((warning) => warning.field)).toEqual([
      "autoSync",
      "editorFontSize",
      "captureShortcut",
      "hideDone",
    ]);
    // A later change only writes its own field: the typos stay for the user to fix.
    app.setEditorFontSize(16);
    await app.settingsSaved();
    expect(saved(storage)).toEqual({ ...invalid, editorFontSize: 16 });
  });

  it("only turns auto-sync on for an explicit true", async () => {
    const { storage, app } = await started({
      settings: { version: 1, workspace: ROOT, autoSync: false },
    });
    storage.setExternalSettings(
      JSON.stringify({ version: 1, workspace: ROOT, editorFontSize: 13 }),
    );
    await vi.waitFor(() => expect(app.settings.editorFontSize).toBe(13));
    expect(app.settings.autoSync).toBe(false);
    expect(app.sync?.auto).toBe(false);
    storage.setExternalSettings(JSON.stringify({ version: 1, workspace: ROOT, autoSync: true }));
    await vi.waitFor(() => expect(app.sync?.auto).toBe(true));
  });

  it("applies a changed capture shortcut", async () => {
    const { storage, app } = await started();
    const bus = new MemoryCaptureBus();
    app.connectCapture(bus.host);
    await vi.waitFor(() => expect(app.captureShortcut).not.toBeNull());
    storage.setExternalSettings(
      JSON.stringify({ version: 1, workspace: ROOT, captureShortcut: "Alt+K" }),
    );
    await vi.waitFor(() => expect(bus.changes).toEqual(["Alt+K"]));
    await vi.waitFor(() => expect(app.captureShortcut?.shortcut).toBe("Alt+K"));
    bus.taken.add("Alt+J");
    storage.setExternalSettings(
      JSON.stringify({ version: 1, workspace: ROOT, captureShortcut: "Alt+J" }),
    );
    await vi.waitFor(() => expect(toastMessages(app)).toContain(SHORTCUT_IN_USE));
    expect(app.captureShortcut?.shortcut).toBe("Alt+K");
  });

  it("stops listening when disposed", async () => {
    const { storage, app } = await started();
    app.dispose();
    const read = vi.spyOn(storage, "readSettings");
    storage.setExternalSettings("{}");
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("AppState settings written over outside changes", () => {
  it("writes only its change on top of a file changed since it was read", async () => {
    const { storage, app } = await started({
      settings: { version: 1, workspace: ROOT, recentWorkspaces: [ROOT] },
    });
    // Changed by another program; the change is not reported yet.
    storage.settings = JSON.stringify({
      version: 1,
      workspace: ROOT,
      recentWorkspaces: [ROOT, OTHER],
      autoSync: false,
      hideDone: { [OTHER]: ["a/tasks.md"] },
      extra: 1,
    });
    const write = vi.spyOn(storage, "writeSettings");
    app.setEditorFontSize(19);
    app.toggleHideDone("inbox/tasks.md");
    await app.settingsSaved();
    expect(saved(storage)).toEqual({
      version: 1,
      workspace: ROOT,
      recentWorkspaces: [ROOT, OTHER],
      autoSync: false,
      hideDone: { [OTHER]: ["a/tasks.md"], [ROOT]: ["inbox/tasks.md"] },
      extra: 1,
      editorFontSize: 19,
    });
    // The first write was refused, then each change was written once.
    expect(write).toHaveBeenCalledTimes(3);
    expect(app.settings).toMatchObject({ editorFontSize: 19, autoSync: false });
    expect(app.sync?.auto).toBe(false);
    expect([...app.hideDone]).toEqual(["inbox/tasks.md"]);
  });

  it("keeps changes not written yet when the file is reloaded first", async () => {
    const { storage, app } = await started();
    storage.setExternalSettings(
      JSON.stringify({ version: 1, workspace: ROOT, editorFontSize: 13 }),
    );
    app.setEditorFontSize(19);
    await app.settingsSaved();
    expect(app.settings.editorFontSize).toBe(19);
    expect(saved(storage)).toEqual({ version: 1, workspace: ROOT, editorFontSize: 19 });
  });

  it("leaves a file that broke in the meantime alone", async () => {
    const { storage, app } = await started();
    storage.settings = "{ broken";
    app.setEditorFontSize(19);
    await app.settingsSaved();
    expect(storage.settings).toBe("{ broken");
    expect(app.settings.editorFontSize).toBe(19);
    expect(app.warnings.map((warning) => warning.message)).toContain(SETTINGS_CHANGES_NOT_SAVED);
  });

  it("gives up with a notice when the file keeps changing", async () => {
    const { storage, app } = await started();
    const write = vi
      .spyOn(storage, "writeSettings")
      .mockRejectedValue(new StorageError("Conflict", "changed"));
    const read = vi.spyOn(storage, "readSettings");
    app.setEditorFontSize(19);
    await app.settingsSaved();
    expect(write).toHaveBeenCalledTimes(SETTINGS_WRITE_RETRIES + 1);
    expect(read).toHaveBeenCalledTimes(SETTINGS_WRITE_RETRIES);
    expect(toastMessages(app)).toEqual([SETTINGS_KEEP_CHANGING]);
    expect(app.settings.editorFontSize).toBe(19);
    // Later changes are tried again.
    write.mockRestore();
    app.setEditorFontSize(20);
    await app.settingsSaved();
    expect(saved(storage)["editorFontSize"]).toBe(20);
  });

  it("stops retrying when the file cannot be read again", async () => {
    const { storage, app } = await started();
    const write = vi
      .spyOn(storage, "writeSettings")
      .mockRejectedValue(new StorageError("Conflict", "changed"));
    vi.spyOn(storage, "readSettings").mockRejectedValue(new StorageError("Io", "busy"));
    app.setEditorFontSize(19);
    await app.settingsSaved();
    expect(write).toHaveBeenCalledTimes(1);
    expect(app.warnings.map((warning) => warning.message)).toContain("settings.json: busy");
    expect(toastMessages(app)).toEqual([]);
  });
});

describe("AppState hide done persistence", () => {
  it("remembers hidden done tasks per workspace", async () => {
    const { storage, app } = await started();
    app.toggleHideDone("inbox/tasks.md");
    app.toggleHideDone(ALL_TASKS);
    await app.settingsSaved();
    expect(saved(storage)["hideDone"]).toEqual({ [ROOT]: ["inbox/tasks.md", "~/all-tasks"] });

    await app.openWorkspace(OTHER);
    await app.settled();
    expect(app.hideDone.size).toBe(0);
    await app.openWorkspace(ROOT);
    await app.settled();
    expect([...app.hideDone]).toEqual(["inbox/tasks.md", ALL_TASKS]);

    app.toggleHideDone("inbox/tasks.md");
    app.toggleHideDone(ALL_TASKS);
    await app.settingsSaved();
    expect(saved(storage)["hideDone"]).toEqual({});
  });
});

describe("AppState recent workspaces", () => {
  it("puts every opened workspace first", async () => {
    const { storage, app } = await started();
    await app.openWorkspace(OTHER);
    await app.settled();
    await app.settingsSaved();
    expect(app.settings.recentWorkspaces).toEqual([OTHER, ROOT]);
    expect(saved(storage)).toMatchObject({ workspace: OTHER, recentWorkspaces: [OTHER, ROOT] });
  });

  it("marks a workspace that was not found and forgets it on request", async () => {
    const { storage, app } = await started({
      settings: { version: 1, workspace: "/gone", recentWorkspaces: ["/gone", ROOT] },
    });
    expect(app.phase.kind).toBe("error");
    expect([...app.missingWorkspaces]).toEqual(["/gone"]);
    app.removeRecentWorkspace("/gone");
    await app.settingsSaved();
    expect(app.missingWorkspaces.size).toBe(0);
    expect(saved(storage)["recentWorkspaces"]).toEqual([ROOT]);
  });

  it("clears the mark once the folder opens again", async () => {
    const { storage, app } = await started({
      settings: { version: 1, workspace: "/back", recentWorkspaces: ["/back"] },
    });
    expect(app.missingWorkspaces.has("/back")).toBe(true);
    storage.addFolder("/back", { "inbox/a.md": "a" });
    await app.openWorkspace("/back");
    expect(app.missingWorkspaces.has("/back")).toBe(false);
  });
});

describe("AppState auto-sync setting", () => {
  it("starts the scheduler with auto-sync off and commits only on Sync now", async () => {
    const { storage, app } = await started({
      settings: { version: 1, workspace: ROOT, autoSync: false },
    });
    expect(app.sync?.auto).toBe(false);
    expect(storage.git.calls.sync).toBe(0);
    await app.createNote();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await app.syncIdle();
    expect(storage.git.commits).toHaveLength(0);
    app.syncNow();
    await vi.waitFor(() => expect(storage.git.commits).toHaveLength(1));
    await app.syncIdle();
    expect(storage.git.calls.sync).toBe(1);
  });

  it("switches the running scheduler and saves the choice", async () => {
    const { storage, app } = await started();
    app.setAutoSync(false);
    app.setAutoSync(false);
    expect(app.sync?.auto).toBe(false);
    app.setAutoSync(true);
    await app.settingsSaved();
    expect(app.sync?.auto).toBe(true);
    expect(saved(storage)["autoSync"]).toBe(true);
  });
});

describe("AppState capture shortcut", () => {
  it("registers the configured shortcut when another one is active", async () => {
    const { app } = await started({
      settings: { version: 1, workspace: ROOT, captureShortcut: "Alt+K" },
    });
    const bus = new MemoryCaptureBus();
    app.connectCapture(bus.host);
    await vi.waitFor(() =>
      expect(app.captureShortcut).toEqual({ registered: true, shortcut: "Alt+K" }),
    );
    expect(bus.changes).toEqual(["Alt+K"]);
  });

  it("says once when the configured shortcut is taken, keeping the old one", async () => {
    const { app } = await started({
      settings: { version: 1, workspace: ROOT, captureShortcut: "Alt+K" },
    });
    const bus = new MemoryCaptureBus({ taken: ["Alt+K"] });
    app.connectCapture(bus.host);
    await vi.waitFor(() => expect(toastMessages(app)).toEqual([SHORTCUT_TAKEN]));
    expect(app.captureShortcut).toEqual({
      registered: true,
      shortcut: "CommandOrControl+Alt+Space",
    });
  });

  it("turns a disabled shortcut off without a notice", async () => {
    const { app } = await started({
      settings: { version: 1, workspace: ROOT, captureShortcut: null },
    });
    const bus = new MemoryCaptureBus();
    app.connectCapture(bus.host);
    await vi.waitFor(() =>
      expect(app.captureShortcut).toEqual({ registered: false, shortcut: null }),
    );
    expect(toastMessages(app)).toEqual([]);
  });

  it("checks once settings are read when capture connects first", async () => {
    const { app } = setup({ settings: { version: 1, workspace: ROOT, captureShortcut: "Alt+K" } });
    const bus = new MemoryCaptureBus();
    app.connectCapture(bus.host);
    expect(bus.changes).toEqual([]);
    await app.start();
    await vi.waitFor(() => expect(bus.changes).toEqual(["Alt+K"]));
  });

  it("changes the shortcut and saves it only when registered", async () => {
    const { storage, app } = await started();
    const bus = new MemoryCaptureBus({ taken: ["Alt+X"] });
    app.connectCapture(bus.host);
    await expect(app.setCaptureShortcut("Alt+J")).resolves.toBeNull();
    await app.settingsSaved();
    expect(saved(storage)["captureShortcut"]).toBe("Alt+J");
    expect(app.captureShortcut).toEqual({ registered: true, shortcut: "Alt+J" });

    await expect(app.setCaptureShortcut("Alt+X")).resolves.toBe(SHORTCUT_IN_USE);
    await app.settingsSaved();
    expect(saved(storage)["captureShortcut"]).toBe("Alt+J");
    expect(app.captureShortcut).toEqual({ registered: true, shortcut: "Alt+J" });

    await expect(app.setCaptureShortcut(null)).resolves.toBeNull();
    await app.settingsSaved();
    expect(saved(storage)["captureShortcut"]).toBeNull();
    expect(app.settings.captureShortcut).toBeNull();
  });

  it("reports failures to change the shortcut", async () => {
    const { app } = await started();
    await expect(app.setCaptureShortcut("Alt+J")).resolves.toBe(CAPTURE_UNAVAILABLE);
    const bus = new MemoryCaptureBus();
    app.connectCapture({
      ...bus.host,
      setShortcut: () => Promise.reject(new StorageError("Io", "no command")),
    });
    await expect(app.setCaptureShortcut("Alt+J")).resolves.toBe("no command");
  });

  it("forgets the host once capture is disconnected", async () => {
    const { app } = await started();
    const stop = app.connectCapture(new MemoryCaptureBus().host);
    stop();
    await expect(app.setCaptureShortcut("Alt+J")).resolves.toBe(CAPTURE_UNAVAILABLE);
  });
});

describe("AppState onboarding", () => {
  it("checks for git", async () => {
    const { app, storage } = setup({ settings: null, git: { unavailable: "git-missing" } });
    await app.checkGit();
    expect(app.gitInfo).toEqual({ available: false, version: null });
    vi.spyOn(storage, "gitVersion").mockRejectedValue(new StorageError("Io", "unknown command"));
    await app.checkGit();
    expect(app.gitInfo).toBeNull();
  });

  it("picks a folder without opening it", async () => {
    const { app, storage } = await started({ settings: null });
    await expect(app.pickFolder()).resolves.toEqual({ kind: "picked", path: "/parent" });
    storage.pick = null;
    await expect(app.pickFolder()).resolves.toEqual({ kind: "cancelled" });
    vi.spyOn(storage, "pickWorkspaceFolder").mockRejectedValue(new StorageError("Io", "no"));
    await expect(app.pickFolder()).resolves.toEqual({ kind: "failed", message: "no" });
    expect(app.phase.kind).toBe("no-workspace");
  });

  it("creates a workspace and opens it", async () => {
    const { app, storage } = await started({ settings: null });
    await expect(app.createWorkspace("/parent", "notes")).resolves.toEqual({ kind: "opened" });
    expect(app.phase).toEqual({ kind: "ready", root: "/parent/notes" });
    expect(storage.folders.get("/parent/notes")?.has(".gitattributes")).toBe(true);
    await app.settingsSaved();
    expect(saved(storage)["workspace"]).toBe("/parent/notes");
  });

  it("refuses names, missing locations and folders that are not empty", async () => {
    const { app } = await started({ settings: null, folders: { "/p/full": { "a.md": "" } } });
    await expect(app.createWorkspace("", "notes")).resolves.toEqual({
      kind: "invalid",
      message: CHOOSE_FOLDER,
    });
    await expect(app.createWorkspace("/p", "a/b")).resolves.toMatchObject({ kind: "invalid" });
    await expect(app.createWorkspace("/p", "full")).resolves.toEqual({
      kind: "invalid",
      message: "The folder is not empty. Choose an empty folder.",
    });
    expect(app.phase.kind).toBe("no-workspace");
  });

  it("opens a created workspace even when git could not be set up, and says why", async () => {
    const { app, storage } = await started({ settings: null });
    vi.spyOn(storage, "scaffoldWorkspace").mockImplementation(async (root) => {
      storage.addFolder(root, { "inbox/tasks.md": "" });
      return {
        root,
        created: ["inbox/tasks.md"],
        updated: [],
        git: "failed",
        commit: null,
        gitError: "git init failed",
      };
    });
    await app.createWorkspace("/p", "n");
    expect(app.phase).toEqual({ kind: "ready", root: "/p/n" });
    expect(toastMessages(app)).toEqual([gitSetupFailedMessage("git init failed")]);
  });

  it("clones a repository and opens it", async () => {
    const { app } = await started({
      settings: null,
      remotes: { "https://h/notes.git": { "inbox/tasks.md": "- [ ] cloned\n" } },
    });
    await expect(app.cloneWorkspace(" https://h/notes.git ", "/p", "notes")).resolves.toEqual({
      kind: "opened",
    });
    expect(app.phase).toEqual({ kind: "ready", root: "/p/notes" });
  });

  it("keeps clone failures for the form", async () => {
    const { app, storage } = await started({ settings: null, remotes: { u: {} } });
    await expect(app.cloneWorkspace("  ", "/p", "n")).resolves.toEqual({
      kind: "invalid",
      message: ENTER_URL,
    });
    await expect(app.cloneWorkspace("u", "", "n")).resolves.toEqual({
      kind: "invalid",
      message: CHOOSE_FOLDER,
    });
    await expect(app.cloneWorkspace("u", "/p", "")).resolves.toMatchObject({ kind: "invalid" });
    storage.cloneError = new StorageError("GitAuth", "git clone failed: denied");
    await expect(app.cloneWorkspace("u", "/p", "n")).resolves.toEqual({
      kind: "invalid",
      message: "git clone failed: denied",
    });
    expect(app.phase.kind).toBe("no-workspace");
  });

  it("cancels a running clone", async () => {
    const { app, storage } = await started({ settings: null, remotes: { u: {} } });
    storage.holdClone = true;
    const cloning = app.cloneWorkspace("u", "/p", "n");
    await app.cancelClone();
    await expect(cloning).resolves.toEqual({ kind: "cancelled" });
    expect(app.phase.kind).toBe("no-workspace");
    vi.spyOn(storage, "cancelClone").mockRejectedValue(new Error("gone"));
    await expect(app.cancelClone()).resolves.toBeUndefined();
  });

  it("treats a Cancelled error as a cancel", async () => {
    const { app, storage } = await started({ settings: null, remotes: { u: {} } });
    storage.cloneError = new StorageError("Cancelled", "Cloning was cancelled.");
    await expect(app.cloneWorkspace("u", "/p", "n")).resolves.toEqual({ kind: "cancelled" });
  });
});

describe("AppState setup banner", () => {
  it("offers to set up a folder that lacks the git lines", async () => {
    const { app, storage } = await started();
    expect(app.setupMissing).toEqual([".gitattributes", ".gitignore"]);
    expect(app.setupBanner).toBe(true);
    await app.setUpWorkspace();
    expect(toastMessages(app)).toEqual([setupDoneMessage([".gitattributes", ".gitignore"])]);
    expect(app.setupMissing).toEqual([]);
    expect(app.setupBanner).toBe(false);
    expect(storage.folders.get(ROOT)?.get(".gitignore")?.contents).toBe(".kaido-*.tmp\n.Trash-*\n");
    // The next automatic commit picks them up.
    await vi.waitFor(() => expect(storage.git.commits).toHaveLength(1));
  });

  it("says nothing was needed", () => {
    expect(setupDoneMessage([])).toBe("Nothing to set up");
  });

  it("does not offer it for a folder that is set up", async () => {
    const { app } = await started({
      folders: {
        [ROOT]: {
          ...files,
          ".gitattributes": "tasks.md merge=union\n",
          ".gitignore": ".kaido-*.tmp\n.Trash-*\n",
        },
      },
    });
    expect(app.setupMissing).toEqual([]);
    expect(app.setupBanner).toBe(false);
  });

  it("remembers Not now per workspace", async () => {
    const { app, storage } = await started();
    app.dismissSetup();
    expect(app.setupBanner).toBe(false);
    await app.settingsSaved();
    expect(saved(storage)["dismissedSetup"]).toEqual([ROOT]);
    await app.openWorkspace(OTHER);
    await app.settled();
    expect(app.setupBanner).toBe(true);
    await app.openWorkspace(ROOT);
    await app.settled();
    expect(app.setupMissing).toEqual([".gitattributes", ".gitignore"]);
    expect(app.setupBanner).toBe(false);
  });

  it("reports setup failures and leaves the banner", async () => {
    const { app, storage } = await started();
    vi.spyOn(storage, "ensureWorkspaceFiles").mockRejectedValue(
      new StorageError("PermissionDenied", "read-only"),
    );
    await app.setUpWorkspace();
    expect(toastMessages(app)).toEqual([setupFailedMessage("read-only")]);
    expect(app.setupBanner).toBe(true);
  });

  it("offers nothing when the status cannot be read", async () => {
    const { app, storage } = setup();
    vi.spyOn(storage, "workspaceSetupStatus").mockRejectedValue(new Error("unknown command"));
    await app.start();
    await app.settled();
    expect(app.setupMissing).toBeNull();
    expect(app.setupBanner).toBe(false);
  });

  it("does nothing without a workspace", async () => {
    const { app, storage } = await started({ settings: null });
    const ensure = vi.spyOn(storage, "ensureWorkspaceFiles");
    await app.setUpWorkspace();
    app.dismissSetup();
    expect(ensure).not.toHaveBeenCalled();
    expect(app.deviceSettings.dismissedSetup).toBeUndefined();
  });
});
