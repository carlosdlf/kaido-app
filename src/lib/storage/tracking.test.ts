import { describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "./MemoryStorage";
import { trackWrites } from "./tracking";

async function setup() {
  const inner = new MemoryStorage({
    folders: { "/w": { "a/x.md": "x", "a/y.md": "y" } },
    settings: "{}",
    pick: "/w",
    git: { unavailable: null },
  });
  const hooks = { written: vi.fn(), renamed: vi.fn(), deleted: vi.fn() };
  const storage = trackWrites(inner, hooks);
  await storage.openWorkspace("/w");
  return { inner, storage, hooks };
}

describe("trackWrites", () => {
  it("reports successful writes, renames and deletes", async () => {
    const { storage, hooks } = await setup();
    await storage.writeFile("a/x.md", "x2");
    await storage.writeFile("a/new.md", "n", { expectedHash: null });
    expect(hooks.written.mock.calls).toEqual([
      ["a/x.md", false],
      ["a/new.md", true],
    ]);
    await storage.renameFile("a/new.md", "a/renamed.md");
    expect(hooks.renamed).toHaveBeenCalledWith("a/new.md", "a/renamed.md");
    const { hash } = await storage.readFile("a/y.md");
    await storage.deleteFile("a/y.md", hash);
    expect(hooks.deleted).toHaveBeenCalledWith("a/y.md");
  });

  it("does not report failures", async () => {
    const { storage, hooks } = await setup();
    await expect(storage.writeFile("a/x.md", "n", { expectedHash: null })).rejects.toThrow();
    await expect(storage.renameFile("a/x.md", "a/y.md")).rejects.toThrow();
    await expect(storage.deleteFile("a/x.md", "wrong")).rejects.toThrow();
    expect(hooks.written).not.toHaveBeenCalled();
    expect(hooks.renamed).not.toHaveBeenCalled();
    expect(hooks.deleted).not.toHaveBeenCalled();
  });

  it("passes everything else through", async () => {
    const { inner, storage } = await setup();
    await expect(storage.pickWorkspaceFolder()).resolves.toBe("/w");
    await expect(storage.listFiles()).resolves.toHaveLength(2);
    await expect(storage.readSettings()).resolves.toBe("{}");
    await storage.writeSettings("{ }");
    expect(inner.settings).toBe("{ }");
    const listener = vi.fn();
    await storage.watch(listener);
    inner.emitChange({ paths: ["a/x.md"] });
    expect(listener).toHaveBeenCalled();
    await storage.onCloseRequested(async () => false);
    await expect(inner.requestClose()).resolves.toBe(false);
    await expect(storage.gitStatus()).resolves.toMatchObject({ state: "ready" });
    await expect(storage.gitCommit("x")).resolves.toEqual({ commit: null, paths: [] });
    await expect(storage.gitSync()).rejects.toMatchObject({ kind: "GitFailed" });
  });
});
