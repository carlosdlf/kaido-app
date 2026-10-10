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
  const hooks = {
    written: vi.fn(),
    renamed: vi.fn(),
    deleted: vi.fn(),
    folderRenamed: vi.fn(),
    folderDeleted: vi.fn(),
  };
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

  it("reports moves and folder moves and deletes", async () => {
    const { storage, hooks } = await setup();
    await storage.moveFile("a/x.md", "b/x.md");
    expect(hooks.renamed).toHaveBeenCalledWith("a/x.md", "b/x.md");
    await storage.renameFolder("b", "c");
    expect(hooks.folderRenamed).toHaveBeenCalledWith("b", "c", [
      expect.objectContaining({ path: "c/x.md" }),
    ]);
    await storage.deleteFolder("c");
    expect(hooks.folderDeleted).toHaveBeenCalledWith("c");
    await expect(storage.moveFile("a/y.md", "a/y.md")).rejects.toThrow();
    await expect(storage.renameFolder("c", "d")).rejects.toThrow();
    await expect(storage.deleteFolder("c")).rejects.toThrow();
    expect(hooks.renamed).toHaveBeenCalledTimes(1);
    expect(hooks.folderRenamed).toHaveBeenCalledTimes(1);
    expect(hooks.folderDeleted).toHaveBeenCalledTimes(1);
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
    const settingsListener = vi.fn();
    await storage.watchSettings(settingsListener);
    inner.setExternalSettings("{}");
    expect(settingsListener).toHaveBeenCalled();
    await expect(storage.gitVersion()).resolves.toEqual({ available: true, version: "2.43.0" });
    await expect(storage.workspaceSetupStatus()).resolves.toEqual({
      missing: [".gitattributes", ".gitignore"],
    });
    await expect(storage.ensureWorkspaceFiles()).resolves.toEqual({
      created: [".gitattributes", ".gitignore"],
      updated: [],
    });
    await expect(storage.scaffoldWorkspace("/new")).resolves.toMatchObject({ root: "/new" });
    inner.remotes.set("https://h/r.git", { "a.md": "a" });
    await expect(storage.cloneRepository("https://h/r.git", "/p", "r")).resolves.toEqual({
      root: "/p/r",
    });
    await expect(storage.cancelClone()).resolves.toBeUndefined();
  });
});
