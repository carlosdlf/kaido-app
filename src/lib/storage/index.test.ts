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
});
