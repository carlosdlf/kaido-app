import { describe, expect, it, vi } from "vitest";
import { conflictCopyPath } from "$lib/core/saveMachine";
import { MemoryStorage } from "./MemoryStorage";
import type { MemoryGitOptions } from "./MemoryGit";

const ROOT = "/notes";
const NOW = new Date(2026, 9, 8, 14, 30).getTime();

async function open(git: MemoryGitOptions = { unavailable: null, upstream: "origin/main" }) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { "inbox/a.md": "a", "inbox/tasks.md": "- [ ] t\n", "notes.png": "png" } },
    now: () => NOW,
    echoWrites: false,
    git,
  });
  await storage.openWorkspace(ROOT);
  return storage;
}

describe("MemoryGit status", () => {
  it("is not a repository by default", async () => {
    const storage = new MemoryStorage({ folders: { [ROOT]: {} } });
    await storage.openWorkspace(ROOT);
    await expect(storage.gitStatus()).resolves.toEqual({
      state: "unavailable",
      reason: "not-a-repo",
    });
    await expect(storage.gitCommit("x")).rejects.toMatchObject({ kind: "GitUnavailable" });
    await expect(storage.gitSync()).rejects.toMatchObject({ kind: "GitUnavailable" });
  });

  it("reports a missing git", async () => {
    const storage = await open({ unavailable: "git-missing" });
    await expect(storage.gitStatus()).resolves.toEqual({
      state: "unavailable",
      reason: "git-missing",
    });
  });

  it("starts clean and lists changed, added and deleted files", async () => {
    const storage = await open();
    await expect(storage.gitStatus()).resolves.toEqual({
      state: "ready",
      branch: "main",
      upstream: "origin/main",
      remote: true,
      ahead: 0,
      behind: 0,
      changed: [],
      gitVersion: "2.43.0",
    });
    await storage.writeFile("inbox/a.md", "a2");
    await storage.writeFile("inbox/new.md", "n");
    storage.setExternal("inbox/tasks.md", null);
    storage.setExternal("inbox/.kaido-1.tmp", "temp", false);
    expect((await storage.gitStatus()).state === "ready").toBe(true);
    const status = await storage.gitStatus();
    expect(status.state !== "unavailable" && status.changed).toEqual([
      "inbox/a.md",
      "inbox/new.md",
      "inbox/tasks.md",
    ]);
  });

  it("reports paused states", async () => {
    const storage = await open({ unavailable: null, pausedReason: "detached-head" });
    await expect(storage.gitStatus()).resolves.toMatchObject({
      state: "paused",
      pausedReason: "detached-head",
      branch: null,
      upstream: null,
      remote: false,
    });
    storage.git.pausedReason = "operation-in-progress";
    await expect(storage.gitStatus()).resolves.toMatchObject({
      operation: "rebase",
      branch: "main",
    });
    storage.git.operation = "merge";
    await expect(storage.gitStatus()).resolves.toMatchObject({ operation: "merge" });
  });

  it("needs an open workspace", async () => {
    const storage = new MemoryStorage({ git: { unavailable: null } });
    await expect(storage.gitStatus()).rejects.toMatchObject({ kind: "NoWorkspace" });
  });

  it("keeps a repository per workspace", async () => {
    const storage = await open();
    await storage.writeFile("inbox/a.md", "changed");
    storage.addFolder("/other", { "x.md": "x" });
    await storage.openWorkspace("/other");
    await expect(storage.gitStatus()).resolves.toMatchObject({ changed: [] });
    await storage.openWorkspace(ROOT);
    await expect(storage.gitStatus()).resolves.toMatchObject({ changed: ["inbox/a.md"] });
  });
});

describe("MemoryGit commit", () => {
  it("commits every change and counts it as ahead", async () => {
    const storage = await open();
    await storage.writeFile("inbox/a.md", "a2");
    await expect(storage.gitCommit("Update inbox/a.md")).resolves.toEqual({
      commit: "c1",
      paths: ["inbox/a.md"],
    });
    expect(storage.git.commits).toEqual([{ message: "Update inbox/a.md", paths: ["inbox/a.md"] }]);
    expect(storage.git.head.get("inbox/a.md")).toBe("a2");
    await expect(storage.gitStatus()).resolves.toMatchObject({ ahead: 1, changed: [] });
  });

  it("has nothing to commit in a clean repository", async () => {
    const storage = await open();
    await expect(storage.gitCommit("x")).resolves.toEqual({ commit: null, paths: [] });
  });

  it("commits with changes outside the workspace but refuses other paused states", async () => {
    const storage = await open({ unavailable: null, pausedReason: "outside-changes" });
    await storage.writeFile("inbox/a.md", "a2");
    await expect(storage.gitCommit("x")).resolves.toMatchObject({ commit: "c1" });
    storage.git.pausedReason = "no-identity";
    await expect(storage.gitCommit("x")).rejects.toMatchObject({
      kind: "GitPaused",
      message: "no-identity",
    });
  });
});

describe("MemoryGit sync", () => {
  it("pushes local commits", async () => {
    const storage = await open();
    await storage.writeFile("inbox/a.md", "a2");
    await storage.gitCommit("x");
    await expect(storage.gitSync()).resolves.toEqual({
      pulled: 0,
      pushed: 1,
      changed: [],
      conflicts: [],
      deferred: false,
    });
    expect(storage.git.ahead).toBe(0);
  });

  it("pulls remote commits and reports the changed files to watchers", async () => {
    const storage = await open();
    const listener = vi.fn();
    await storage.watch(listener);
    storage.git.addRemoteCommit({ "inbox/b.md": "b" });
    storage.git.addRemoteCommit({ "inbox/a.md": null, "inbox/b.md": "b2" });
    await expect(storage.gitSync()).resolves.toEqual({
      pulled: 2,
      pushed: 0,
      changed: ["inbox/a.md", "inbox/b.md"],
      conflicts: [],
      deferred: false,
    });
    expect((await storage.readFile("inbox/b.md")).contents).toBe("b2");
    await expect(storage.readFile("inbox/a.md")).rejects.toMatchObject({ kind: "NotFound" });
    expect(listener.mock.calls.map(([event]) => event.paths)).toEqual([
      ["inbox/a.md"],
      ["inbox/b.md"],
    ]);
  });

  it("keeps both versions of a note changed on both sides", async () => {
    const storage = await open();
    await storage.writeFile("inbox/a.md", "local");
    await storage.gitCommit("x");
    storage.git.addRemoteCommit({ "inbox/a.md": "upstream" });
    const copy = conflictCopyPath("inbox/a.md", NOW);
    await expect(storage.gitSync()).resolves.toEqual({
      pulled: 1,
      pushed: 2,
      changed: [copy, "inbox/a.md"].sort(),
      conflicts: [{ path: "inbox/a.md", copy }],
      deferred: false,
    });
    expect((await storage.readFile("inbox/a.md")).contents).toBe("upstream");
    expect((await storage.readFile(copy)).contents).toBe("local");
    await expect(storage.gitStatus()).resolves.toMatchObject({ changed: [], ahead: 0 });
  });

  it("numbers conflict copies whose name is taken", async () => {
    const storage = await open();
    const first = conflictCopyPath("inbox/a.md", NOW);
    await storage.writeFile(first, "older copy");
    await storage.writeFile("inbox/a.md", "local");
    await storage.gitCommit("x");
    storage.git.addRemoteCommit({ "inbox/a.md": "upstream" });
    const result = await storage.gitSync();
    expect(result.conflicts).toEqual([
      { path: "inbox/a.md", copy: conflictCopyPath("inbox/a.md", NOW, 2) },
    ]);
  });

  it("keeps a local change of a note deleted upstream, and an upstream change of a note deleted here", async () => {
    const storage = await open();
    await storage.writeFile("inbox/a.md", "local");
    storage.setExternal("inbox/tasks.md", null);
    await storage.gitCommit("x");
    storage.git.addRemoteCommit({ "inbox/a.md": null, "inbox/tasks.md": "- [ ] upstream\n" });
    const result = await storage.gitSync();
    expect(result).toMatchObject({ changed: ["inbox/tasks.md"], conflicts: [] });
    expect((await storage.readFile("inbox/a.md")).contents).toBe("local");
    expect((await storage.readFile("inbox/tasks.md")).contents).toBe("- [ ] upstream\n");
  });

  it("ignores upstream changes identical to local ones", async () => {
    const storage = await open();
    await storage.writeFile("inbox/a.md", "same");
    await storage.gitCommit("x");
    storage.git.addRemoteCommit({ "inbox/a.md": "same" });
    await expect(storage.gitSync()).resolves.toMatchObject({ changed: [], conflicts: [] });
  });

  it("pauses on conflicts in files that are not notes", async () => {
    const storage = await open();
    storage.setExternal("notes.png", "local png", false);
    await storage.gitCommit("x");
    storage.git.addRemoteCommit({ "notes.png": "upstream png" });
    await expect(storage.gitSync()).rejects.toMatchObject({
      kind: "GitPaused",
      message: "unmerged-files: notes.png",
    });
  });

  it("defers rebasing and pushing while there are uncommitted changes", async () => {
    const storage = await open();
    await storage.writeFile("inbox/a.md", "committed");
    await storage.gitCommit("x");
    await storage.writeFile("inbox/a.md", "dirty");
    storage.git.addRemoteCommit({ "inbox/b.md": "b" });
    await expect(storage.gitSync()).resolves.toEqual({
      pulled: 0,
      pushed: 0,
      changed: [],
      conflicts: [],
      deferred: true,
    });
    expect(storage.git.ahead).toBe(1);
    await storage.gitCommit("y");
    await expect(storage.gitSync()).resolves.toMatchObject({
      pulled: 1,
      pushed: 2,
      deferred: false,
    });
  });

  it.each(["upstream-mismatch", "local-merges"] as const)(
    "commits but does not sync when paused by %s",
    async (reason) => {
      const storage = await open({
        unavailable: null,
        upstream: "origin/main",
        pausedReason: reason,
      });
      await storage.writeFile("inbox/a.md", "a2");
      await expect(storage.gitCommit("x")).resolves.toMatchObject({ commit: "c1" });
      await expect(storage.gitSync()).rejects.toMatchObject({ kind: "GitPaused", message: reason });
    },
  );

  it.each(["upstream-gone", "outside-commits"] as const)(
    "commits when paused by %s; a sync re-checks and stays paused until resolved",
    async (reason) => {
      const storage = await open({
        unavailable: null,
        upstream: "origin/main",
        pausedReason: reason,
      });
      await storage.writeFile("inbox/a.md", "a2");
      await expect(storage.gitCommit("x")).resolves.toMatchObject({ commit: "c1" });
      await expect(storage.gitSync()).rejects.toMatchObject({ kind: "GitPaused", message: reason });
      expect(storage.git.pausedReason).toBe(reason);
      expect(storage.git.ahead).toBe(1);
      // The user resolved it with git.
      storage.git.pausedReason = null;
      await expect(storage.gitSync()).resolves.toMatchObject({ pushed: 1 });
    },
  );

  it("neither commits nor syncs while the index is locked", async () => {
    const storage = await open({
      unavailable: null,
      upstream: "origin/main",
      pausedReason: "index-locked",
    });
    await storage.writeFile("inbox/a.md", "a2");
    await expect(storage.gitCommit("x")).rejects.toMatchObject({ message: "index-locked" });
    await expect(storage.gitSync()).rejects.toMatchObject({ message: "index-locked" });
  });

  it("needs an upstream", async () => {
    const storage = await open({ unavailable: null });
    await expect(storage.gitSync()).rejects.toMatchObject({ kind: "GitFailed" });
  });

  it("is paused by changes outside the workspace", async () => {
    const storage = await open({
      unavailable: null,
      upstream: "origin/main",
      pausedReason: "outside-changes",
    });
    await expect(storage.gitSync()).rejects.toMatchObject({
      kind: "GitPaused",
      message: "outside-changes",
    });
  });
});

describe("MemoryGit test controls", () => {
  it("fails queued operations with the given errors", async () => {
    const storage = await open();
    storage.git.failNext("sync", "GitNetwork", "offline");
    storage.git.failNext("sync", "GitAuth");
    storage.git.failNext("commit", "GitFailed", "hook");
    storage.git.failNext("status", "GitFailed", "locked");
    await expect(storage.gitSync()).rejects.toMatchObject({
      kind: "GitNetwork",
      message: "offline",
    });
    await expect(storage.gitSync()).rejects.toMatchObject({ kind: "GitAuth", message: "GitAuth" });
    await expect(storage.gitSync()).resolves.toMatchObject({ pulled: 0 });
    await expect(storage.gitCommit("x")).rejects.toMatchObject({ message: "hook" });
    await expect(storage.gitStatus()).rejects.toMatchObject({ message: "locked" });
    expect(storage.git.calls).toEqual({ status: 1, commit: 1, sync: 3 });
  });

  it("holds an operation until released", async () => {
    const storage = await open();
    const release = storage.git.hold("status");
    let done = false;
    const status = storage.gitStatus().then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await status;
    expect(done).toBe(true);
  });

  it("can take a while, like a real repository", async () => {
    vi.useFakeTimers();
    try {
      const storage = await open({ unavailable: null, delay: 300 });
      let done = false;
      const status = storage.gitStatus().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(299);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await status;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can have a remote without an upstream", async () => {
    const storage = await open({ unavailable: null, remote: true });
    await expect(storage.gitStatus()).resolves.toMatchObject({ upstream: null, remote: true });
  });
});
