import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { payload: unknown }) => void;

const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const listeners = new Map<string, Listener>();
const listen = vi.fn(async (event: string, listener: Listener) => {
  listeners.set(event, listener);
  return () => listeners.delete(event);
});
const emitTo = vi.fn<(target: string, event: string, payload: unknown) => Promise<void>>();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen, emitTo }));

const { TauriCaptureChannel, TauriCaptureHost } = await import("./TauriCapture");

const fire = (event: string, payload: unknown) => listeners.get(event)?.({ payload });

beforeEach(() => {
  invoke.mockReset();
  listeners.clear();
  listen.mockClear();
  emitTo.mockReset();
  emitTo.mockResolvedValue(undefined);
  invoke.mockResolvedValue(undefined);
});

describe("TauriCaptureChannel", () => {
  const channel = new TauriCaptureChannel();

  it("hears when it is shown, and the main window's projects and results", async () => {
    const shown = vi.fn();
    const projects = vi.fn();
    const results = vi.fn();
    await channel.onShown(shown);
    await channel.onProjects(projects);
    const stop = await channel.onResult(results);

    fire("capture:shown", null);
    fire("capture:projects", { projects: ["inbox", "api"], workspaceOpen: true });
    fire("capture:projects", { projects: "inbox" });
    fire("capture:result", { id: "1", ok: false, message: "No" });
    fire("capture:result", { id: 1 });

    expect(shown).toHaveBeenCalledOnce();
    expect(projects).toHaveBeenCalledExactlyOnceWith({
      projects: ["inbox", "api"],
      workspaceOpen: true,
    });
    expect(results).toHaveBeenCalledExactlyOnceWith({ id: "1", ok: false, message: "No" });
    stop();
    expect(listeners.has("capture:result")).toBe(false);
  });

  it("asks the backend to relay to the main window, never emitting events itself", async () => {
    await channel.requestProjects();
    const submit = { id: "1", kind: "note" as const, text: "idea", project: "inbox" };
    await channel.submit({ ...submit, extra: "dropped" } as typeof submit);
    expect(invoke).toHaveBeenNthCalledWith(1, "capture_request_projects", undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, "capture_submit", { payload: submit });
    expect(emitTo).not.toHaveBeenCalled();
  });

  it("hides, shows and resizes its window through commands", async () => {
    await channel.hide();
    await channel.show();
    await channel.resize(200);
    expect(invoke.mock.calls).toEqual([
      ["capture_hide", undefined],
      ["capture_show", undefined],
      ["capture_set_height", { height: 200 }],
    ]);
  });

  it("converts failures to storage errors", async () => {
    invoke.mockRejectedValue("denied");
    await expect(
      channel.submit({ id: "1", kind: "task", text: "a", project: "inbox" }),
    ).rejects.toMatchObject({ kind: "Io" });
    invoke.mockRejectedValue({ kind: "Io", message: "not allowed" });
    await expect(channel.hide()).rejects.toMatchObject({ kind: "Io", message: "not allowed" });
    listen.mockRejectedValueOnce(new Error("no"));
    await expect(channel.onShown(() => undefined)).rejects.toMatchObject({ kind: "Io" });
  });
});

describe("TauriCaptureHost", () => {
  const host = new TauriCaptureHost();

  it("hears submits and project requests", async () => {
    const submits = vi.fn();
    const requests = vi.fn();
    await host.onSubmit(submits);
    await host.onProjectsRequest(requests);
    fire("capture:submit", { id: "1", kind: "task", text: "a", project: "inbox" });
    fire("capture:submit", { id: "2", kind: "event", text: "a", project: "inbox" });
    fire("capture:projects-request", {});
    expect(submits).toHaveBeenCalledExactlyOnceWith({
      id: "1",
      kind: "task",
      text: "a",
      project: "inbox",
    });
    expect(requests).toHaveBeenCalledOnce();
  });

  it("replies to the capture window", async () => {
    await host.sendResult({ id: "1", ok: true, message: "Added to inbox" });
    await host.sendProjects({ projects: ["inbox"], workspaceOpen: false });
    expect(emitTo).toHaveBeenNthCalledWith(1, "capture", "capture:result", {
      id: "1",
      ok: true,
      message: "Added to inbox",
    });
    expect(emitTo).toHaveBeenNthCalledWith(2, "capture", "capture:projects", {
      projects: ["inbox"],
      workspaceOpen: false,
    });
    emitTo.mockRejectedValue("denied");
    await expect(host.sendResult({ id: "1", ok: true, message: "" })).rejects.toMatchObject({
      kind: "Io",
    });
  });

  it("asks whether the shortcut was registered", async () => {
    invoke.mockResolvedValue({ registered: false, shortcut: "CommandOrControl+Alt+Space" });
    await expect(host.shortcutStatus()).resolves.toEqual({
      registered: false,
      shortcut: "CommandOrControl+Alt+Space",
    });
    expect(invoke).toHaveBeenCalledWith("capture_shortcut_status");
    invoke.mockResolvedValue({ registered: "no" });
    await expect(host.shortcutStatus()).rejects.toMatchObject({ kind: "Io" });
    invoke.mockRejectedValue({ kind: "Io", message: "unknown command" });
    await expect(host.shortcutStatus()).rejects.toMatchObject({ kind: "Io" });
  });
});
