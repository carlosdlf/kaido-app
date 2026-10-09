import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const listen = vi.fn();
const onCloseRequested = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested }) }));

const { CHANGE_EVENT, TauriStorage, writeFileArgs } = await import("./TauriStorage");

const repoStatus = {
  state: "ready",
  branch: "main",
  upstream: "origin/main",
  remote: true,
  ahead: 1,
  behind: 0,
  changed: ["inbox/a.md"],
  gitVersion: "2.43.0",
};

const entry = { path: "a.md", size: 1, modified: 2 };
const written = { ...entry, hash: "ab12" };
const read = { contents: "text", hash: "ab12" };

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  onCloseRequested.mockReset();
});

describe("TauriStorage", () => {
  const storage = new TauriStorage();

  it.each([
    ["pickWorkspaceFolder", [], "pick_workspace_folder", undefined, "/w"],
    ["pickWorkspaceFolder", [], "pick_workspace_folder", undefined, null],
    ["openWorkspace", ["/w"], "open_workspace", { path: "/w" }, { root: "/w" }],
    ["listFiles", [], "list_files", undefined, [entry]],
    ["readFile", ["a.md"], "read_file", { path: "a.md" }, read],
    ["writeFile", ["a.md", "x"], "write_file", { path: "a.md", contents: "x" }, written],
    ["renameFile", ["a.md", "b.md"], "rename_file", { from: "a.md", to: "b.md" }, written],
    ["readSettings", [], "read_settings", undefined, "{}"],
    ["readSettings", [], "read_settings", undefined, null],
  ] as const)("%s calls %s", async (method, args, command, commandArgs, response) => {
    invoke.mockResolvedValue(response);
    const fn = storage[method] as (...input: readonly string[]) => Promise<unknown>;
    await expect(fn.apply(storage, [...args])).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith(command, commandArgs);
  });

  it("writes settings", async () => {
    invoke.mockResolvedValue(null);
    await expect(storage.writeSettings("{}")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("write_settings", { contents: "{}" });
  });

  it("deletes files with the expected hash", async () => {
    invoke.mockResolvedValue(null);
    await expect(storage.deleteFile("a.md", "ab12")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("delete_file", { path: "a.md", expectedHash: "ab12" });
  });

  it("rejects unexpected rename and delete responses", async () => {
    invoke.mockResolvedValue({ path: "b.md" });
    await expect(storage.renameFile("a.md", "b.md")).rejects.toMatchObject({ kind: "Io" });
    invoke.mockResolvedValue({ deleted: true });
    await expect(storage.deleteFile("a.md", "ab12")).rejects.toMatchObject({ kind: "Io" });
  });

  it("converts rename conflicts", async () => {
    invoke.mockRejectedValue({ kind: "Conflict", message: "b.md already exists." });
    await expect(storage.renameFile("a.md", "b.md")).rejects.toMatchObject({ kind: "Conflict" });
  });

  it("converts backend errors", async () => {
    invoke.mockRejectedValue({ kind: "NotFound", message: "a.md does not exist" });
    await expect(storage.readFile("a.md")).rejects.toMatchObject({
      name: "StorageError",
      kind: "NotFound",
      message: "a.md does not exist",
    });
  });

  it("passes through TooLarge errors", async () => {
    invoke.mockRejectedValue({ kind: "TooLarge", message: "a.md is larger than 8 MiB" });
    await expect(storage.readFile("a.md")).rejects.toMatchObject({ kind: "TooLarge" });
  });

  it("passes through Superseded errors from overtaken opens", async () => {
    invoke.mockRejectedValue({ kind: "Superseded", message: "A newer workspace was opened." });
    await expect(storage.openWorkspace("/w")).rejects.toMatchObject({ kind: "Superseded" });
  });

  it("rejects malformed responses", async () => {
    invoke.mockResolvedValue([{ path: "a.md" }]);
    await expect(storage.listFiles()).rejects.toMatchObject({
      kind: "Io",
      message: "Unexpected response from list_files.",
    });
  });

  it("forwards change events and unsubscribes", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const listener = vi.fn();
    const stop = await storage.watch(listener);
    expect(listen).toHaveBeenCalledWith(CHANGE_EVENT, expect.any(Function));

    const handler = listen.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    const payload = { paths: ["a.md", "b.md"], entries: [entry], rescan: false };
    handler({ payload });
    expect(listener).toHaveBeenLastCalledWith(payload);

    handler({ payload: { paths: ["a.md"], rescan: false } });
    expect(listener).toHaveBeenLastCalledWith({ paths: [], entries: [], rescan: true });

    handler({ payload: { paths: ["a.md"], entries: [{ path: "a.md" }], rescan: false } });
    expect(listener).toHaveBeenLastCalledWith({ paths: [], entries: [], rescan: true });

    stop();
    expect(unlisten).toHaveBeenCalled();
  });

  it("converts failures to subscribe", async () => {
    listen.mockRejectedValue(new Error("no event system"));
    await expect(storage.watch(vi.fn())).rejects.toMatchObject({
      kind: "Io",
      message: "no event system",
    });
  });

  it("passes write preconditions", async () => {
    invoke.mockResolvedValue(written);
    await storage.writeFile("a.md", "x", { expectedHash: "ab12" });
    expect(invoke).toHaveBeenLastCalledWith("write_file", {
      path: "a.md",
      contents: "x",
      expectedHash: "ab12",
    });
    await storage.writeFile("a.md", "x", { expectedHash: null });
    expect(invoke).toHaveBeenLastCalledWith("write_file", {
      path: "a.md",
      contents: "x",
      expectedHash: null,
    });
  });

  it("leaves the precondition out of unconditional writes", () => {
    expect(writeFileArgs("a.md", "x")).toEqual({ path: "a.md", contents: "x" });
    expect("expectedHash" in writeFileArgs("a.md", "x", {})).toBe(false);
    expect(writeFileArgs("a.md", "x", { expectedHash: null })).toHaveProperty("expectedHash", null);
  });

  it("passes through Conflict errors", async () => {
    invoke.mockRejectedValue({ kind: "Conflict", message: "a.md changed on disk" });
    await expect(storage.writeFile("a.md", "x", { expectedHash: "1" })).rejects.toMatchObject({
      kind: "Conflict",
    });
  });

  it("rejects reads and writes without a hash", async () => {
    invoke.mockResolvedValue("text");
    await expect(storage.readFile("a.md")).rejects.toMatchObject({ kind: "Io" });
    invoke.mockResolvedValue(entry);
    await expect(storage.writeFile("a.md", "x")).rejects.toMatchObject({ kind: "Io" });
  });

  describe("git", () => {
    it("reads the status", async () => {
      invoke.mockResolvedValue(repoStatus);
      await expect(storage.gitStatus()).resolves.toEqual(repoStatus);
      expect(invoke).toHaveBeenCalledWith("git_status", undefined);
    });

    it("drops absent optional status fields", async () => {
      invoke.mockResolvedValue({ ...repoStatus, pausedReason: null, operation: null });
      await expect(storage.gitStatus()).resolves.toEqual(repoStatus);
      invoke.mockResolvedValue({
        ...repoStatus,
        state: "paused",
        pausedReason: "operation-in-progress",
        operation: "rebase",
      });
      await expect(storage.gitStatus()).resolves.toMatchObject({
        pausedReason: "operation-in-progress",
        operation: "rebase",
      });
    });

    it("keeps a status message and drops an empty one", async () => {
      const pausedMessage =
        "Kaido started this rebase. Run git rebase --continue or git rebase --abort.";
      invoke.mockResolvedValue({
        ...repoStatus,
        state: "paused",
        pausedReason: "operation-in-progress",
        operation: "rebase",
        pausedMessage,
      });
      await expect(storage.gitStatus()).resolves.toMatchObject({ pausedMessage });
      invoke.mockResolvedValue({ ...repoStatus, pausedMessage: "" });
      await expect(storage.gitStatus()).resolves.toEqual(repoStatus);
      invoke.mockResolvedValue({ ...repoStatus, pausedMessage: null });
      await expect(storage.gitStatus()).resolves.toEqual(repoStatus);
    });

    it("reads an unavailable state", async () => {
      invoke.mockResolvedValue({ state: "unavailable", reason: "git-missing" });
      await expect(storage.gitStatus()).resolves.toEqual({
        state: "unavailable",
        reason: "git-missing",
      });
    });

    it.each([
      { ...repoStatus, state: "weird" },
      { ...repoStatus, ahead: -1 },
      { ...repoStatus, pausedReason: "tired" },
      { state: "unavailable", reason: "nope" },
      { ...repoStatus, changed: [1] },
    ])("rejects a malformed status %#", async (response) => {
      invoke.mockResolvedValue(response);
      await expect(storage.gitStatus()).rejects.toMatchObject({
        kind: "Io",
        message: "Unexpected response from git_status.",
      });
    });

    it("commits with a message", async () => {
      invoke.mockResolvedValue({ commit: "abc", paths: ["a.md"] });
      await expect(storage.gitCommit("Update a.md")).resolves.toEqual({
        commit: "abc",
        paths: ["a.md"],
      });
      expect(invoke).toHaveBeenCalledWith("git_commit", { message: "Update a.md" });
      invoke.mockResolvedValue({ commit: null, paths: [] });
      await expect(storage.gitCommit("x")).resolves.toEqual({ commit: null, paths: [] });
      invoke.mockResolvedValue({ commit: 1, paths: [] });
      await expect(storage.gitCommit("x")).rejects.toMatchObject({ kind: "Io" });
    });

    it.each([
      "index-locked",
      "upstream-mismatch",
      "upstream-gone",
      "outside-commits",
      "local-merges",
    ])("accepts the %s paused reason", async (reason) => {
      invoke.mockResolvedValue({ ...repoStatus, state: "paused", pausedReason: reason });
      await expect(storage.gitStatus()).resolves.toMatchObject({ pausedReason: reason });
    });

    it("reads deferred syncs, and treats a missing flag as not deferred", async () => {
      const base = { pulled: 0, pushed: 0, changed: [], conflicts: [] };
      invoke.mockResolvedValue({ ...base, deferred: true });
      await expect(storage.gitSync()).resolves.toEqual({ ...base, deferred: true });
      invoke.mockResolvedValue(base);
      await expect(storage.gitSync()).resolves.toEqual({ ...base, deferred: false });
      invoke.mockResolvedValue({ ...base, deferred: "yes" });
      await expect(storage.gitSync()).rejects.toMatchObject({ kind: "Io" });
    });

    it("syncs", async () => {
      const result = {
        pulled: 2,
        pushed: 1,
        changed: ["a.md"],
        conflicts: [{ path: "a.md", copy: "a (conflict 2026-10-08 1430).md" }],
        deferred: false,
      };
      invoke.mockResolvedValue(result);
      await expect(storage.gitSync()).resolves.toEqual(result);
      expect(invoke).toHaveBeenCalledWith("git_sync", undefined);
      invoke.mockResolvedValue({ ...result, conflicts: [{ path: "a.md" }] });
      await expect(storage.gitSync()).rejects.toMatchObject({ kind: "Io" });
    });

    it.each(["GitUnavailable", "GitPaused", "GitNetwork", "GitAuth", "GitFailed"])(
      "passes through %s errors",
      async (kind) => {
        invoke.mockRejectedValue({ kind, message: "details" });
        await expect(storage.gitSync()).rejects.toMatchObject({ kind, message: "details" });
      },
    );
  });

  describe("close requests", () => {
    type Handler = (event: { preventDefault: () => void }) => Promise<void>;

    async function register(result: () => Promise<boolean>) {
      const unlisten = vi.fn();
      onCloseRequested.mockResolvedValue(unlisten);
      const stop = await storage.onCloseRequested(result);
      const handler = onCloseRequested.mock.calls[0]?.[0] as Handler;
      const preventDefault = vi.fn();
      await handler({ preventDefault });
      return { stop, unlisten, preventDefault };
    }

    it("lets the window close when the handler agrees", async () => {
      const { stop, unlisten, preventDefault } = await register(async () => true);
      expect(preventDefault).not.toHaveBeenCalled();
      stop();
      expect(unlisten).toHaveBeenCalled();
    });

    it("keeps the window open when the handler refuses", async () => {
      const { preventDefault } = await register(async () => false);
      expect(preventDefault).toHaveBeenCalled();
    });

    it("closes anyway when the handler fails", async () => {
      const { preventDefault } = await register(() => Promise.reject(new Error("boom")));
      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("converts failures to register", async () => {
      onCloseRequested.mockRejectedValue(new Error("no window"));
      await expect(storage.onCloseRequested(async () => true)).rejects.toMatchObject({
        kind: "Io",
        message: "no window",
      });
    });
  });
});
