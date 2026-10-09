import { describe, expect, it, vi } from "vitest";
import { contentHash } from "./contentHash";
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
