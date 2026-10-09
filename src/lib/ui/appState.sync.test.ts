import { describe, expect, it, vi } from "vitest";
import { conflictCopyPath } from "$lib/core/saveMachine";
import { MemoryStorage, type MemoryGitOptions } from "$lib/storage";
import { AppState } from "./appState.svelte";

const ROOT = "/notes";
const OTHER = "/other";

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] one\n",
  "inbox/idea.md": "# Idea\n",
  "api/deploy.md": "# Deploy\n",
};

function setup(git: MemoryGitOptions = { unavailable: null, upstream: "origin/main" }) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...files }, [OTHER]: { "inbox/x.md": "x" } },
    settings: JSON.stringify({ version: 1, workspace: ROOT }),
    git,
  });
  const app = new AppState(storage, {
    defer: (task) => task(),
    saveDelay: 5,
    sync: { commitDelay: 5 },
  });
  return { storage, app };
}

async function started(git?: MemoryGitOptions) {
  const context = setup(git);
  await context.app.start();
  await context.app.settled();
  await context.app.syncIdle();
  return context;
}

/** Waits until the scheduler has committed `count` times and is idle again. */
async function commits(storage: MemoryStorage, app: AppState, count: number) {
  await vi.waitFor(() => expect(storage.git.commits).toHaveLength(count));
  await app.syncIdle();
  return storage.git.commits.map((commit) => commit.message.split("\n")[0]);
}

describe("AppState sync", () => {
  it("starts after the workspace is loaded and syncs", async () => {
    const { storage, app } = await started();
    expect(storage.git.calls.sync).toBe(1);
    expect(app.sync).toMatchObject({
      status: { state: "ready", upstream: "origin/main" },
      activity: "idle",
      problem: null,
    });
    expect(app.sync?.lastSync).not.toBeNull();
  });

  it("shows a folder that is not a repository", async () => {
    const { storage, app } = await started({});
    expect(app.sync?.status).toEqual({ state: "unavailable", reason: "not-a-repo" });
    expect(storage.git.calls).toMatchObject({ commit: 0, sync: 0 });
  });

  it("has no sync state before a workspace is open", async () => {
    const storage = new MemoryStorage({ git: { unavailable: null } });
    const app = new AppState(storage);
    await app.start();
    expect(app.sync).toBeNull();
    app.syncNow();
    app.windowFocused();
    await app.syncIdle();
    expect(storage.git.calls.status).toBe(0);
  });

  it("commits new notes as added and edits as updates", async () => {
    const { storage, app } = await started();
    await app.createNote();
    expect(await commits(storage, app, 1)).toEqual(["Add inbox/untitled.md"]);
    app.selectItem("inbox/idea.md");
    await app.settled();
    app.edit("inbox/idea.md", () => "# Idea\n\nmore");
    expect(await commits(storage, app, 2)).toEqual([
      "Add inbox/untitled.md",
      "Update inbox/idea.md",
    ]);
    // Each commit is pushed right away.
    expect(storage.git.ahead).toBe(0);
  });

  it("commits renames and deletes", async () => {
    const { storage, app } = await started();
    await app.renameNote("inbox/idea.md", "plan");
    expect(await commits(storage, app, 1)).toEqual(["Rename inbox/idea.md to plan.md"]);
    await app.deleteNote("inbox/plan.md");
    expect((await commits(storage, app, 2))[1]).toBe("Delete inbox/plan.md");
  });

  it("commits task edits", async () => {
    const { storage, app } = await started();
    app.selectItem("inbox/tasks.md");
    await app.settled();
    app.toggleTask("inbox/tasks.md", { line: 0, raw: "- [ ] one" });
    expect(await commits(storage, app, 1)).toEqual(["Update tasks in inbox"]);
  });

  it("commits changes made outside the app", async () => {
    const { storage, app } = await started();
    storage.setExternal("api/deploy.md", "# Deploy\n\nchanged");
    storage.setExternal("api/gone.md", "new");
    expect(await commits(storage, app, 1)).toEqual(["Update 2 notes in api"]);
    storage.setExternal("api/gone.md", null);
    expect((await commits(storage, app, 2))[1]).toBe("Delete api/gone.md");
  });

  it("saves pending edits before syncing now", async () => {
    const storage = new MemoryStorage({
      folders: { [ROOT]: { ...files } },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
      git: { unavailable: null, upstream: "origin/main" },
    });
    const app = new AppState(storage, {
      defer: (task) => task(),
      saveDelay: 60_000,
      sync: { commitDelay: 60_000 },
    });
    await app.start();
    await app.settled();
    await app.syncIdle();
    app.selectItem("inbox/idea.md");
    await app.settled();
    app.edit("inbox/idea.md", () => "# Idea\n\nunsaved");
    app.syncNow();
    await vi.waitFor(() => expect(storage.git.commits).toHaveLength(1));
    await app.syncIdle();
    expect(storage.git.head.get("inbox/idea.md")).toBe("# Idea\n\nunsaved");
    expect(storage.git.ahead).toBe(0);
    app.dispose();
  });

  it("shows a toast when both versions of a note were kept", async () => {
    const { storage, app } = await started();
    storage.git.addRemoteCommit({ "inbox/idea.md": "# Idea\n\nupstream" });
    storage.setExternal("inbox/idea.md", "# Idea\n\nlocal");
    await commits(storage, app, 1);
    const copy = conflictCopyPath("inbox/idea.md", Date.now());
    await vi.waitFor(() =>
      expect(app.toasts.map((toast) => toast.message)).toContain(
        `Both versions kept: ${copy.slice("inbox/".length)}`,
      ),
    );
    await app.settled();
    expect(app.hasNote(copy)).toBe(true);
  });

  it("shows changes pending after a deferred sync and commits and syncs again", async () => {
    const { storage, app } = await started();
    const release = storage.git.hold("sync");
    app.syncNow();
    await vi.waitFor(() => expect(app.sync?.activity).toBe("syncing"));
    // Changed between the commit and the sync, before the watcher reports it.
    storage.setExternal("api/deploy.md", "# Deploy\n\nlate", false);
    release();
    await app.syncIdle();
    expect(app.sync?.pending).toBe(true);
    expect(await commits(storage, app, 1)).toEqual(["Update api/deploy.md"]);
    await vi.waitFor(() => expect(app.sync?.pending).toBe(false));
    expect(storage.git.ahead).toBe(0);
  });

  it.each([
    ["GitAuth", "auth"],
    ["GitNetwork", "network"],
    ["GitPaused", "paused"],
    ["GitFailed", "failed"],
  ] as const)("reports %s as a %s problem", async (kind, problem) => {
    const { storage, app } = await started();
    storage.git.failNext("sync", kind, "details");
    app.syncNow();
    await app.syncIdle();
    expect(app.sync?.problem).toEqual({ kind: problem, message: "details", during: "sync" });
  });

  it("reports other storage errors as failures", async () => {
    const { storage, app } = await started();
    vi.spyOn(storage, "gitSync").mockRejectedValueOnce(new Error("bridge down"));
    app.syncNow();
    await app.syncIdle();
    expect(app.sync?.problem).toEqual({ kind: "failed", message: "bridge down", during: "sync" });
  });

  it("refreshes the status on window focus", async () => {
    const { storage, app } = await started();
    const before = storage.git.calls.status;
    storage.git.pausedReason = "detached-head";
    app.windowFocused();
    await app.syncIdle();
    expect(storage.git.calls.status).toBe(before + 1);
    expect(app.sync?.status).toMatchObject({ state: "paused", pausedReason: "detached-head" });
  });
});

describe("AppState sync lifecycle", () => {
  it("stops the scheduler of the previous workspace before switching", async () => {
    const { storage, app } = await started();
    const release = storage.git.hold("sync");
    app.syncNow();
    await vi.waitFor(() => expect(app.sync?.activity).toBe("syncing"));
    const open = vi.spyOn(storage, "openWorkspace");
    const switching = app.openWorkspace(OTHER);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The backend keeps the old workspace until git is done with it.
    expect(open).not.toHaveBeenCalled();
    expect(app.sync).toBeNull();
    release();
    await switching;
    await app.settled();
    await app.syncIdle();
    expect(app.phase).toEqual({ kind: "ready", root: OTHER });
    expect(app.sync?.status).toMatchObject({ state: "ready" });
  });

  it("no longer commits the previous workspace", async () => {
    const { storage, app } = await started();
    await app.openWorkspace(OTHER);
    await app.settled();
    await app.syncIdle();
    storage.setExternal("inbox/x.md", "changed");
    expect(await commits(storage, app, 1)).toEqual(["Update inbox/x.md"]);
  });

  it("forgets what happened in the previous workspace", async () => {
    const storage = new MemoryStorage({
      folders: { [ROOT]: { ...files }, [OTHER]: { "inbox/new.md": "x" } },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
      git: { unavailable: null },
    });
    const app = new AppState(storage, {
      defer: (task) => task(),
      sync: { commitDelay: 60_000 },
    });
    await app.start();
    await app.settled();
    await app.createNote();
    await app.renameNote("inbox/untitled.md", "new");
    await app.openWorkspace(OTHER);
    await app.settled();
    storage.setExternal("inbox/new.md", "changed");
    app.syncNow();
    await vi.waitFor(() => expect(storage.git.commits).toHaveLength(1));
    expect(storage.git.commits[0]?.message).toBe("Update inbox/new.md");
    app.dispose();
  });

  it("waits for git before closing and starts nothing meanwhile", async () => {
    const { storage, app } = await started();
    const release = storage.git.hold("sync");
    app.syncNow();
    await vi.waitFor(() => expect(app.sync?.activity).toBe("syncing"));
    let closed: boolean | null = null;
    const closing = storage.requestClose().then((result) => (closed = result));
    app.syncNow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBeNull();
    release();
    await closing;
    expect(closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storage.git.calls.sync).toBe(2);
    expect(app.sync).toBeNull();
  });

  it("resumes when closing is refused", async () => {
    const { storage, app } = await started();
    app.selectItem("inbox/idea.md");
    await app.settled();
    storage.setReadOnly("inbox/idea.md");
    app.edit("inbox/idea.md", () => "unsaved");
    await expect(storage.requestClose()).resolves.toBe(false);
    expect(app.sync).not.toBeNull();
    const syncs = storage.git.calls.sync;
    app.syncNow();
    await app.syncIdle();
    expect(storage.git.calls.sync).toBe(syncs + 1);
    app.dispose();
  });

  it("stops on dispose", async () => {
    const { storage, app } = await started();
    app.dispose();
    expect(app.sync).toBeNull();
    const calls = { ...storage.git.calls };
    app.syncNow();
    storage.setExternal("inbox/idea.md", "changed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.git.calls).toEqual(calls);
  });
});
