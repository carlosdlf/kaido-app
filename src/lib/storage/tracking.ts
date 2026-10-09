/** A `Storage` wrapper that reports the app's own successful file changes. */

import type { Storage, WriteOptions, WrittenFile } from "./types";

export interface WriteHooks {
  /** A file was written; `created` when the write was create-only. */
  written(path: string, created: boolean): void;
  renamed(from: string, to: string): void;
  deleted(path: string): void;
}

/**
 * Wraps `storage` so `hooks` hear about every successful write, rename and
 * delete. Failed operations are not reported. Everything else is passed
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
    readSettings: () => storage.readSettings(),
    writeSettings: (contents) => storage.writeSettings(contents),
    watch: (listener) => storage.watch(listener),
    onCloseRequested: (handler) => storage.onCloseRequested(handler),
    gitStatus: () => storage.gitStatus(),
    gitCommit: (message) => storage.gitCommit(message),
    gitSync: () => storage.gitSync(),
  };
}
