import { describe, expect, it, vi } from "vitest";
import { contentHash } from "./contentHash";
import { StorageError } from "./errors";
import { MemoryStorage } from "./MemoryStorage";

function storage(options: ConstructorParameters<typeof MemoryStorage>[0] = {}) {
  let time = 1000;
  return new MemoryStorage({ now: () => (time += 1), ...options });
}

async function opened(files: Record<string, string>, echoWrites = true) {
  const store = storage({ folders: { "/w": files }, echoWrites });
  await store.openWorkspace("/w");
  return store;
}

describe("MemoryStorage", () => {
  it("requires an open workspace", async () => {
    const store = storage();
    await expect(store.listFiles()).rejects.toMatchObject({ kind: "NoWorkspace" });
    await expect(store.readFile("a.md")).rejects.toMatchObject({ kind: "NoWorkspace" });
    await expect(store.writeFile("a.md", "")).rejects.toMatchObject({ kind: "NoWorkspace" });
  });

  it("opens existing folders only", async () => {
    const store = storage({ folders: { "/w": {} } });
    await expect(store.openWorkspace("/missing")).rejects.toMatchObject({ kind: "NotFound" });
    await expect(store.openWorkspace("/w")).resolves.toEqual({ root: "/w" });
    expect(store.root).toBe("/w");
  });

  it("lists Markdown files sorted by path with metadata", async () => {
    const store = await opened({
      "b/x.md": "héllo",
      "a.md": "",
      "a/z.MD": "",
      "img.png": "",
      ".kaido/config.json": "{}",
      ".git/x.md": "",
      "node_modules/p/readme.md": "",
    });
    const files = await store.listFiles();
    expect(files.map((file) => file.path)).toEqual(["a.md", "a/z.MD", "b/x.md"]);
    expect(files[2]).toEqual({ path: "b/x.md", size: 6, modified: 1001 });
  });

  it("sorts identical prefixes deterministically", async () => {
    const store = await opened({ "b.md": "", "a.md": "", "c.md": "" });
    expect((await store.listFiles()).map((file) => file.path)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("reads files, including ones not listed", async () => {
    const store = await opened({ "a.md": "text", ".kaido/config.json": "{}" });
    await expect(store.readFile("a.md")).resolves.toMatchObject({ contents: "text" });
    await expect(store.readFile(".kaido/config.json")).resolves.toMatchObject({ contents: "{}" });
    await expect(store.readFile("missing.md")).rejects.toMatchObject({ kind: "NotFound" });
    await expect(store.readFile("../x.md")).rejects.toMatchObject({ kind: "InvalidPath" });
    await expect(store.readFile("notes.txt")).rejects.toMatchObject({ kind: "InvalidPath" });
  });

  it("writes files, returns metadata and echoes the change", async () => {
    const store = await opened({});
    const listener = vi.fn();
    await store.watch(listener);
    const entry = await store.writeFile("inbox/new.md", "abc");
    expect(entry).toEqual({
      path: "inbox/new.md",
      size: 3,
      modified: 1002,
      hash: contentHash("abc"),
    });
    await expect(store.readFile("inbox/new.md")).resolves.toMatchObject({ contents: "abc" });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({
      paths: ["inbox/new.md"],
      entries: [{ path: "inbox/new.md", size: 3, modified: 1002 }],
      rescan: false,
    });
  });

  it("does not echo writes when disabled", async () => {
    const store = await opened({}, false);
    const listener = vi.fn();
    await store.watch(listener);
    await store.writeFile("a.md", "x");
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects files larger than 8 MiB", async () => {
    const big = "a".repeat(8 * 1024 * 1024 + 1);
    const store = await opened({ "big.md": big, "edge.md": "é".repeat(4 * 1024 * 1024) });
    await expect(store.readFile("big.md")).rejects.toMatchObject({ kind: "TooLarge" });
    expect((await store.readFile("edge.md")).contents).toHaveLength(4 * 1024 * 1024);
    await expect(store.writeFile("a.md", big)).rejects.toMatchObject({ kind: "TooLarge" });
    await expect(store.readFile("a.md")).rejects.toMatchObject({ kind: "NotFound" });
  });

  it("never replaces a read-only file", async () => {
    const store = await opened({ "a.md": "keep" });
    store.setReadOnly("a.md");
    store.setReadOnly("missing.md");
    await expect(store.writeFile("a.md", "new")).rejects.toMatchObject({
      kind: "PermissionDenied",
    });
    await expect(store.readFile("a.md")).resolves.toMatchObject({ contents: "keep" });
    store.setReadOnly("a.md", false);
    await expect(store.writeFile("a.md", "new")).resolves.toMatchObject({ path: "a.md" });
  });

  it("reports the workspace configuration like a listed file", async () => {
    const store = await opened({});
    const listener = vi.fn();
    await store.watch(listener);
    await store.writeFile(".kaido/config.json", "{}");
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({
      paths: [".kaido/config.json"],
      entries: [{ path: ".kaido/config.json", size: 2, modified: 1002 }],
      rescan: false,
    });
    store.setExternal(".kaido/other.json", "{}");
    store.setExternal("notes.txt", "x");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("fills in entries for simulated changes unless given", async () => {
    const store = await opened({ "a.md": "x" });
    const listener = vi.fn();
    await store.watch(listener);
    store.emitChange({ paths: ["a.md", "gone.md"] });
    expect(listener).toHaveBeenLastCalledWith({
      paths: ["a.md", "gone.md"],
      entries: [{ path: "a.md", size: 1, modified: 1001 }],
      rescan: false,
    });
    store.emitChange({ paths: ["a.md"], entries: [], rescan: true });
    expect(listener).toHaveBeenLastCalledWith({ paths: ["a.md"], entries: [], rescan: true });

    const closed = storage();
    await closed.watch(listener);
    closed.emitChange({ paths: ["a.md"] });
    expect(listener).toHaveBeenLastCalledWith({ paths: ["a.md"], entries: [], rescan: false });
  });

  it("rejects invalid paths on write", async () => {
    const store = await opened({});
    await expect(store.writeFile("/abs.md", "")).rejects.toMatchObject({ kind: "InvalidPath" });
    await expect(store.writeFile(".kaido/state.json", "")).rejects.toMatchObject({
      kind: "InvalidPath",
    });
  });

  it("stores settings", async () => {
    const store = storage({ settings: '{"version":1}' });
    await expect(store.readSettings()).resolves.toBe('{"version":1}');
    await store.writeSettings("{}");
    await expect(store.readSettings()).resolves.toBe("{}");
    await expect(storage().readSettings()).resolves.toBeNull();
  });

  it("only replaces the settings it last read or wrote", async () => {
    const store = storage({ settings: '{"version":1}' });
    // Never read: an existing file is not replaced, a missing one is created.
    await expect(store.writeSettings("{}")).rejects.toMatchObject({ kind: "Conflict" });
    expect(store.settings).toBe('{"version":1}');
    const fresh = storage();
    await fresh.writeSettings("{}");
    expect(fresh.settings).toBe("{}");

    await store.readSettings();
    await store.writeSettings("a");
    await store.writeSettings("b");
    store.setExternalSettings("outside");
    await expect(store.writeSettings("c")).rejects.toMatchObject({ kind: "Conflict" });
    expect(store.settings).toBe("outside");
    await store.readSettings();
    await store.writeSettings("c");
    expect(store.settings).toBe("c");

    // A deleted file counts as changed too.
    store.setExternalSettings(null);
    await expect(store.writeSettings("d")).rejects.toMatchObject({ kind: "Conflict" });
    await store.readSettings();
    await store.writeSettings("d");
    expect(store.settings).toBe("d");
  });

  it("returns the configured folder pick", async () => {
    await expect(storage().pickWorkspaceFolder()).resolves.toBeNull();
    await expect(storage({ pick: "/w" }).pickWorkspaceFolder()).resolves.toBe("/w");
  });

  it("simulates external edits and deletions", async () => {
    const store = await opened({ "a.md": "old" });
    const listener = vi.fn();
    const stop = await store.watch(listener);
    store.setExternal("a.md", "new");
    expect(listener).toHaveBeenLastCalledWith({
      paths: ["a.md"],
      entries: [{ path: "a.md", size: 3, modified: 1002 }],
      rescan: false,
    });
    await expect(store.readFile("a.md")).resolves.toMatchObject({ contents: "new" });
    store.setExternal("a.md", null, false);
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(store.readFile("a.md")).rejects.toMatchObject({ kind: "NotFound" });

    expect(store.listenerCount).toBe(1);
    stop();
    expect(store.listenerCount).toBe(0);
    store.emitChange({ paths: [], rescan: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reports a workspace folder that disappeared", async () => {
    const store = await opened({ "a.md": "" });
    store.removeFolder("/w");
    await expect(store.listFiles()).rejects.toMatchObject({ kind: "NotFound" });
  });

  it("uses the system clock by default", async () => {
    const store = new MemoryStorage({ folders: { "/w": {} } });
    await store.openWorkspace("/w");
    const before = Date.now();
    const entry = await store.writeFile("a.md", "");
    expect(entry.modified).toBeGreaterThanOrEqual(before);
  });

  it("returns the hash of the contents with every read", async () => {
    const store = await opened({ "a.md": "text" });
    const read = await store.readFile("a.md");
    expect(read).toEqual({ contents: "text", hash: contentHash("text") });
    const written = await store.writeFile("a.md", "text");
    expect(written.hash).toBe(read.hash);
  });

  it("creates only when the expected hash is null", async () => {
    const store = await opened({ "a.md": "old" });
    await expect(store.writeFile("a.md", "x", { expectedHash: null })).rejects.toMatchObject({
      kind: "Conflict",
    });
    await expect(store.readFile("a.md")).resolves.toMatchObject({ contents: "old" });
    await expect(store.writeFile("b.md", "new", { expectedHash: null })).resolves.toMatchObject({
      path: "b.md",
      hash: contentHash("new"),
    });
  });

  it("writes only over the expected version", async () => {
    const store = await opened({ "a.md": "old" });
    const { hash } = await store.readFile("a.md");
    store.setExternal("a.md", "theirs", false);
    await expect(store.writeFile("a.md", "mine", { expectedHash: hash })).rejects.toMatchObject({
      kind: "Conflict",
    });
    await expect(
      store.writeFile("missing.md", "mine", { expectedHash: hash }),
    ).rejects.toMatchObject({ kind: "Conflict" });
    const current = await store.readFile("a.md");
    await expect(
      store.writeFile("a.md", "mine", { expectedHash: current.hash }),
    ).resolves.toMatchObject({ hash: contentHash("mine") });
    await expect(store.writeFile("a.md", "any", {})).resolves.toMatchObject({ path: "a.md" });
  });

  it("checks read-only files before the expected hash", async () => {
    const store = await opened({ "a.md": "keep" });
    store.setReadOnly("a.md");
    await expect(store.writeFile("a.md", "x", { expectedHash: null })).rejects.toMatchObject({
      kind: "PermissionDenied",
    });
  });

  it("runs the close handler when asked to close", async () => {
    const store = storage();
    await expect(store.requestClose()).resolves.toBe(true);
    const stop = await store.onCloseRequested(async () => false);
    await expect(store.requestClose()).resolves.toBe(false);
    const other = await store.onCloseRequested(async () => true);
    stop();
    await expect(store.requestClose()).resolves.toBe(true);
    other();
    await expect(store.requestClose()).resolves.toBe(true);
  });
});

describe("MemoryStorage.renameFile", () => {
  it("renames within the folder, keeping contents and time, and echoes both paths", async () => {
    const store = await opened({ "inbox/a.md": "abc" });
    const listener = vi.fn();
    await store.watch(listener);
    await expect(store.renameFile("inbox/a.md", "inbox/b.md")).resolves.toEqual({
      path: "inbox/b.md",
      size: 3,
      modified: 1001,
      hash: contentHash("abc"),
    });
    await expect(store.readFile("inbox/a.md")).rejects.toMatchObject({ kind: "NotFound" });
    await expect(store.readFile("inbox/b.md")).resolves.toMatchObject({ contents: "abc" });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({
      paths: ["inbox/a.md", "inbox/b.md"],
      entries: [{ path: "inbox/b.md", size: 3, modified: 1001 }],
      rescan: false,
    });
  });

  it("allows case-only renames but not renaming to the same path", async () => {
    const store = await opened({ "a.md": "x" });
    await expect(store.renameFile("a.md", "A.md")).resolves.toMatchObject({ path: "A.md" });
    expect(await store.listFiles()).toEqual([{ path: "A.md", size: 1, modified: 1001 }]);
    await expect(store.renameFile("A.md", "A.md")).rejects.toMatchObject({ kind: "Conflict" });
  });

  it("checks folders case-sensitively and refuses files larger than 8 MiB", async () => {
    const store = await opened({ "p/a.md": "x", "big.md": "a".repeat(8 * 1024 * 1024 + 1) });
    await expect(store.renameFile("p/a.md", "P/a.md")).rejects.toMatchObject({
      kind: "InvalidPath",
    });
    await expect(store.renameFile("big.md", "huge.md")).rejects.toMatchObject({
      kind: "TooLarge",
    });
  });

  it("never replaces an existing file", async () => {
    const store = await opened({ "a.md": "one", "b.md": "two" });
    await expect(store.renameFile("a.md", "b.md")).rejects.toMatchObject({ kind: "Conflict" });
    expect((await store.readFile("a.md")).contents).toBe("one");
    expect((await store.readFile("b.md")).contents).toBe("two");
  });

  it("reports a missing source and rejects invalid paths", async () => {
    const store = await opened({ "inbox/a.md": "x", ".kaido/config.json": "{}" });
    await expect(store.renameFile("inbox/x.md", "inbox/y.md")).rejects.toMatchObject({
      kind: "NotFound",
    });
    await expect(store.renameFile("inbox/a.md", "api/a.md")).rejects.toMatchObject({
      kind: "InvalidPath",
    });
    await expect(store.renameFile(".kaido/config.json", ".kaido/c.md")).rejects.toMatchObject({
      kind: "InvalidPath",
    });
    await expect(store.renameFile("inbox/a.md", "inbox/a.txt")).rejects.toMatchObject({
      kind: "InvalidPath",
    });
  });

  it("requires an open workspace", async () => {
    await expect(storage().renameFile("a.md", "b.md")).rejects.toMatchObject({
      kind: "NoWorkspace",
    });
  });
});

describe("MemoryStorage.deleteFile", () => {
  it("deletes a file with the expected hash, keeps it in the trash and echoes", async () => {
    const store = await opened({ "inbox/a.md": "abc" });
    const listener = vi.fn();
    await store.watch(listener);
    await expect(store.deleteFile("inbox/a.md", contentHash("abc"))).resolves.toBeUndefined();
    await expect(store.readFile("inbox/a.md")).rejects.toMatchObject({ kind: "NotFound" });
    expect(store.trash).toEqual([{ path: "inbox/a.md", contents: "abc" }]);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({ paths: ["inbox/a.md"], entries: [], rescan: false });
  });

  it("never deletes a version that was not seen", async () => {
    const store = await opened({ "a.md": "new" });
    await expect(store.deleteFile("a.md", contentHash("old"))).rejects.toMatchObject({
      kind: "Conflict",
    });
    expect((await store.readFile("a.md")).contents).toBe("new");
    expect(store.trash).toEqual([]);
  });

  it("reports missing files and rejects the workspace configuration", async () => {
    const store = await opened({ ".kaido/config.json": "{}" });
    await expect(store.deleteFile("a.md", "h")).rejects.toMatchObject({ kind: "NotFound" });
    await expect(store.deleteFile(".kaido/config.json", contentHash("{}"))).rejects.toMatchObject({
      kind: "InvalidPath",
    });
    await expect(store.deleteFile("a.txt", "h")).rejects.toMatchObject({ kind: "InvalidPath" });
  });

  it("does not echo when echoes are disabled", async () => {
    const store = await opened({ "a.md": "x" }, false);
    const listener = vi.fn();
    await store.watch(listener);
    await store.deleteFile("a.md", contentHash("x"));
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("MemoryStorage.moveFile", () => {
  it("moves a note to another folder, keeping contents and time, and echoes both paths", async () => {
    const store = await opened({ "inbox/a.md": "abc" });
    const listener = vi.fn();
    await store.watch(listener);
    await expect(store.moveFile("inbox/a.md", "api/new/a.md")).resolves.toEqual({
      path: "api/new/a.md",
      size: 3,
      modified: 1001,
      hash: contentHash("abc"),
    });
    await expect(store.readFile("inbox/a.md")).rejects.toMatchObject({ kind: "NotFound" });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({
      paths: ["inbox/a.md", "api/new/a.md"],
      entries: [{ path: "api/new/a.md", size: 3, modified: 1001 }],
      rescan: false,
    });
  });

  it("allows case-only moves and never replaces a file", async () => {
    const store = await opened({ "a/x.md": "one", "b/x.md": "two" });
    await expect(store.moveFile("a/x.md", "b/x.md")).rejects.toMatchObject({ kind: "Conflict" });
    await expect(store.moveFile("a/x.md", "a/X.md")).resolves.toMatchObject({ path: "a/X.md" });
    expect((await store.readFile("b/x.md")).contents).toBe("two");
  });

  it("refuses missing, large and invalid files", async () => {
    const store = await opened({ "big.md": "a".repeat(8 * 1024 * 1024 + 1), "a.md": "x" });
    await expect(store.moveFile("none.md", "b/none.md")).rejects.toMatchObject({
      kind: "NotFound",
    });
    await expect(store.moveFile("big.md", "b/big.md")).rejects.toMatchObject({
      kind: "TooLarge",
    });
    await expect(store.moveFile("a.md", "b/a.txt")).rejects.toMatchObject({
      kind: "InvalidPath",
    });
  });
});

describe("MemoryStorage.renameFolder", () => {
  it("moves every file of the folder, returns its notes and reports a rescan", async () => {
    const store = await opened({
      "a/tasks.md": "- [ ] t\n",
      "a/sub/n.md": "n",
      "a/image.png": "png",
      "ab/x.md": "x",
    });
    const listener = vi.fn();
    await store.watch(listener);
    await expect(store.renameFolder("a", "_archive/a")).resolves.toEqual({
      entries: [
        { path: "_archive/a/sub/n.md", size: 1, modified: 1001 },
        { path: "_archive/a/tasks.md", size: 8, modified: 1001 },
      ],
    });
    expect([...(store.folders.get("/w")?.keys() ?? [])].sort()).toEqual([
      "_archive/a/image.png",
      "_archive/a/sub/n.md",
      "_archive/a/tasks.md",
      "ab/x.md",
    ]);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({ paths: [], entries: [], rescan: true });
  });

  it("refuses a missing folder, an existing target and invalid folders", async () => {
    const store = await opened({ "a/x.md": "x", "b/y.md": "y", "inbox/z.md": "z" });
    await expect(store.renameFolder("c", "d")).rejects.toMatchObject({ kind: "NotFound" });
    await expect(store.renameFolder("a", "b")).rejects.toMatchObject({ kind: "Conflict" });
    await expect(store.renameFolder("inbox", "c")).rejects.toMatchObject({
      kind: "InvalidPath",
    });
    await expect(store.renameFolder("a", "a/b")).rejects.toMatchObject({ kind: "InvalidPath" });
    await expect(store.renameFolder("a", "a")).rejects.toMatchObject({ kind: "Conflict" });
    await expect(store.renameFolder("a", "A")).resolves.toEqual({
      entries: [{ path: "A/x.md", size: 1, modified: 1001 }],
    });
  });
});

describe("MemoryStorage.deleteFolder", () => {
  it("moves every file of the folder to the trash and reports a rescan", async () => {
    const store = await opened({ "a/tasks.md": "t", "a/n.md": "n", "b/x.md": "x" });
    const listener = vi.fn();
    await store.watch(listener);
    await expect(store.deleteFolder("a")).resolves.toBeUndefined();
    expect(store.trash).toEqual([
      { path: "a/tasks.md", contents: "t" },
      { path: "a/n.md", contents: "n" },
    ]);
    expect(await store.listFiles()).toEqual([{ path: "b/x.md", size: 1, modified: 1001 }]);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith({ paths: [], entries: [], rescan: true });
  });

  it("refuses missing and fixed folders, and does not echo when echoes are off", async () => {
    const store = await opened({ "a/x.md": "x", "inbox/y.md": "y" }, false);
    const listener = vi.fn();
    await store.watch(listener);
    await expect(store.deleteFolder("c")).rejects.toMatchObject({ kind: "NotFound" });
    await expect(store.deleteFolder("inbox")).rejects.toMatchObject({ kind: "InvalidPath" });
    await expect(store.deleteFolder("_archive")).rejects.toMatchObject({ kind: "InvalidPath" });
    await store.deleteFolder("a");
    await store.renameFolder("inbox", "x").catch(() => undefined);
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("MemoryStorage onboarding", () => {
  it("reports git", async () => {
    await expect(new MemoryStorage().gitVersion()).resolves.toEqual({
      available: true,
      version: "2.43.0",
    });
    await expect(
      new MemoryStorage({ git: { unavailable: "git-missing" } }).gitVersion(),
    ).resolves.toEqual({ available: false, version: null });
  });

  it("scaffolds empty or new folders only", async () => {
    const storage = new MemoryStorage({ folders: { "/full": { "a.md": "" }, "/empty": {} } });
    await expect(storage.scaffoldWorkspace("/new")).resolves.toEqual({
      root: "/new",
      created: [".gitattributes", ".gitignore", ".kaido/config.json", "inbox/tasks.md"],
      updated: [],
      git: "initialized",
      commit: "0000000",
      gitError: null,
    });
    await expect(storage.scaffoldWorkspace("/empty")).resolves.toMatchObject({ updated: [] });
    await expect(storage.scaffoldWorkspace("/full")).rejects.toMatchObject({ kind: "NotEmpty" });
    await expect(
      new MemoryStorage({ git: { unavailable: "git-missing" } }).scaffoldWorkspace("/n"),
    ).resolves.toMatchObject({ git: "git-missing", commit: null });
    await storage.openWorkspace("/new");
    await expect(storage.workspaceSetupStatus()).resolves.toEqual({ missing: [] });
    await expect(storage.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: "inbox/tasks.md" }),
    ]);
    await expect(storage.readFile(".kaido/config.json")).resolves.toMatchObject({
      contents: '{ "version": 1, "ignore": [] }\n',
    });
  });

  it("adds missing setup lines without touching the rest", async () => {
    const storage = new MemoryStorage({
      folders: { "/w": { ".gitattributes": "*.md text", ".gitignore": ".Trash-*\n" } },
    });
    await storage.openWorkspace("/w");
    await expect(storage.workspaceSetupStatus()).resolves.toEqual({
      missing: [".gitattributes", ".gitignore"],
    });
    await expect(storage.ensureWorkspaceFiles()).resolves.toEqual({
      created: [],
      updated: [".gitattributes", ".gitignore"],
    });
    const files = storage.folders.get("/w");
    expect(files?.get(".gitattributes")?.contents).toBe("*.md text\ntasks.md merge=union\n");
    expect(files?.get(".gitignore")?.contents).toBe(".Trash-*\n.kaido-*.tmp\n");
    await expect(storage.ensureWorkspaceFiles()).resolves.toEqual({ created: [], updated: [] });
    await expect(storage.workspaceSetupStatus()).resolves.toEqual({ missing: [] });
  });

  it("clones known repositories into new folders", async () => {
    const storage = new MemoryStorage({
      folders: { "/p/taken": {} },
      remotes: { "https://h/notes.git": { "inbox/tasks.md": "- [ ] a\n" } },
    });
    await expect(storage.cloneRepository("https://h/notes.git", "/p", "notes")).resolves.toEqual({
      root: "/p/notes",
    });
    expect(storage.folders.get("/p/notes")?.get("inbox/tasks.md")?.contents).toBe("- [ ] a\n");
    await expect(
      storage.cloneRepository("https://h/notes.git", "/p", "taken"),
    ).rejects.toMatchObject({ kind: "Conflict" });
    await expect(storage.cloneRepository("https://h/x.git", "/p", "x")).rejects.toMatchObject({
      kind: "GitFailed",
    });
    storage.cloneError = new StorageError("GitAuth", "denied");
    await expect(storage.cloneRepository("https://h/notes.git", "/p", "n2")).rejects.toMatchObject({
      kind: "GitAuth",
    });
    await expect(storage.cloneRepository("https://h/notes.git", "/p", "n2")).resolves.toEqual({
      root: "/p/n2",
    });
  });

  it("holds a clone until it is released or cancelled", async () => {
    const storage = new MemoryStorage({ remotes: { u: {} } });
    storage.holdClone = true;
    const first = storage.cloneRepository("u", "/p", "a");
    storage.releaseClone();
    await expect(first).resolves.toEqual({ root: "/p/a" });
    storage.holdClone = true;
    const second = storage.cloneRepository("u", "/p", "b");
    await storage.cancelClone();
    await expect(second).rejects.toMatchObject({ kind: "Cancelled" });
    expect(storage.folders.has("/p/b")).toBe(false);
    await expect(storage.cancelClone()).resolves.toBeUndefined();
    storage.releaseClone();
  });

  it("reports settings changed by another program", async () => {
    const storage = new MemoryStorage();
    const listener = vi.fn();
    const stop = await storage.watchSettings(listener);
    storage.setExternalSettings('{"version":1}');
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(storage.readSettings()).resolves.toBe('{"version":1}');
    stop();
    storage.setExternalSettings(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
