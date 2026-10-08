import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const { CHANGE_EVENT, TauriStorage } = await import("./TauriStorage");

const entry = { path: "a.md", size: 1, modified: 2 };

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe("TauriStorage", () => {
  const storage = new TauriStorage();

  it.each([
    ["pickWorkspaceFolder", [], "pick_workspace_folder", undefined, "/w"],
    ["pickWorkspaceFolder", [], "pick_workspace_folder", undefined, null],
    ["openWorkspace", ["/w"], "open_workspace", { path: "/w" }, { root: "/w" }],
    ["listFiles", [], "list_files", undefined, [entry]],
    ["readFile", ["a.md"], "read_file", { path: "a.md" }, "text"],
    ["writeFile", ["a.md", "x"], "write_file", { path: "a.md", contents: "x" }, entry],
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
});
