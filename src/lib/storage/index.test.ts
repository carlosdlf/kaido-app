import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { createStorage, MemoryStorage } = await import("./index");
const { TauriStorage } = await import("./TauriStorage");
const { SAMPLE_ROOT } = await import("./sample");

describe("createStorage", () => {
  it("uses the desktop backend inside the app", () => {
    expect(createStorage(true)).toBeInstanceOf(TauriStorage);
  });

  it("serves a sample workspace from memory elsewhere", async () => {
    const storage = createStorage();
    expect(storage).toBeInstanceOf(MemoryStorage);
    const picked = await storage.pickWorkspaceFolder();
    expect(picked).toBe(SAMPLE_ROOT);
    await storage.openWorkspace(SAMPLE_ROOT);
    expect((await storage.listFiles()).length).toBeGreaterThan(5);
  });

  it("serves the sample workspace as a clean repository with an upstream", async () => {
    vi.useFakeTimers();
    try {
      const storage = createStorage();
      await storage.openWorkspace(SAMPLE_ROOT);
      const status = storage.gitStatus();
      await vi.runAllTimersAsync();
      await expect(status).resolves.toMatchObject({
        state: "ready",
        upstream: "origin/main",
        changed: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("quick capture factories", () => {
  it("connects the main window only inside the app", async () => {
    const { createCaptureHost } = await import("./index");
    const { TauriCaptureHost } = await import("./TauriCapture");
    expect(createCaptureHost(true)).toBeInstanceOf(TauriCaptureHost);
    expect(createCaptureHost()).toBeNull();
  });

  it("gives the capture page a channel everywhere", async () => {
    const { createCaptureChannel } = await import("./index");
    const { TauriCaptureChannel } = await import("./TauriCapture");
    expect(createCaptureChannel(true)).toBeInstanceOf(TauriCaptureChannel);
    const channel = createCaptureChannel();
    expect(channel).not.toBeInstanceOf(TauriCaptureChannel);
    await expect(channel.requestProjects()).resolves.toBeUndefined();
  });
});
