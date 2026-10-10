/** A `Storage` wrapper that reports the app's own successful file and folder changes. */

import type { FileEntry } from "$lib/core/workspace";
import type { FolderMove, Storage, WriteOptions, WrittenFile } from "./types";

export interface WriteHooks {
  /** A file was written; `created` when the write was create-only. */
  written(path: string, created: boolean): void;
  /** A file was renamed or moved to another folder. */
  renamed(from: string, to: string): void;
  deleted(path: string): void;
  /** A whole folder moved; `entries` are its Markdown files at their new paths. */
  folderRenamed(from: string, to: string, entries: readonly FileEntry[]): void;
  folderDeleted(path: string): void;
}

/**
 * Wraps `storage` so `hooks` hear about every successful write, rename,
 * move and delete. Failed operations are not reported. Everything else is passed
 * through unchanged.
 */
export function trackWrites(storage: Storage, hooks: WriteHooks): Storage {
  return {
    pickWorkspaceFolder: () => storage.pickWorkspaceFolder(),
    openWorkspace: (path) => storage.openWorkspace(path),
    listFiles: () => storage.listFiles(),
    readFile: (path) => storage.readFile(path),
    async writeFile(path: string, contents: string, options?: WriteOptions): Promise<WrittenFile> {
      const written = await storage.writeFile(path, contents, options);
      hooks.written(written.path, options?.expectedHash === null);
      return written;
    },
    async renameFile(from: string, to: string): Promise<WrittenFile> {
      const written = await storage.renameFile(from, to);
      hooks.renamed(from, written.path);
      return written;
    },
    async deleteFile(path: string, expectedHash: string): Promise<void> {
      await storage.deleteFile(path, expectedHash);
      hooks.deleted(path);
    },
    async moveFile(from: string, to: string): Promise<WrittenFile> {
      const written = await storage.moveFile(from, to);
      hooks.renamed(from, written.path);
      return written;
    },
    async renameFolder(from: string, to: string): Promise<FolderMove> {
      const moved = await storage.renameFolder(from, to);
      hooks.folderRenamed(from, to, moved.entries);
      return moved;
    },
    async deleteFolder(path: string): Promise<void> {
      await storage.deleteFolder(path);
      hooks.folderDeleted(path);
    },
    readSettings: () => storage.readSettings(),
    writeSettings: (contents) => storage.writeSettings(contents),
    watchSettings: (listener) => storage.watchSettings(listener),
    gitVersion: () => storage.gitVersion(),
    scaffoldWorkspace: (root) => storage.scaffoldWorkspace(root),
    workspaceSetupStatus: () => storage.workspaceSetupStatus(),
    ensureWorkspaceFiles: () => storage.ensureWorkspaceFiles(),
    cloneRepository: (url, parent, name) => storage.cloneRepository(url, parent, name),
    cancelClone: () => storage.cancelClone(),
    watch: (listener) => storage.watch(listener),
    onCloseRequested: (handler) => storage.onCloseRequested(handler),
    gitStatus: () => storage.gitStatus(),
    gitCommit: (message) => storage.gitCommit(message),
    gitSync: () => storage.gitSync(),
  };
}
