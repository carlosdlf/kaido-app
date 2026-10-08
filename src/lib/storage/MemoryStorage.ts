/**
 * An in-memory `Storage` for tests and for running the UI in a plain
 * browser. It follows the same rules as the desktop backend: relative paths,
 * Markdown-only listings that skip hidden folders and `node_modules`, and
 * change notifications (with fresh metadata) for writes and simulated
 * external edits of listed files and the workspace configuration.
 */

import {
  isListablePath,
  isStoragePath,
  type ChangeEvent,
  type FileEntry,
} from "$lib/core/workspace";
import { StorageError } from "./errors";
import { checkStoragePath, MAX_FILE_BYTES } from "./paths";
import type { ChangeListener, OpenedWorkspace, Storage, Unsubscribe } from "./types";

interface StoredFile {
  contents: string;
  modified: number;
  readOnly?: boolean;
}

export interface MemoryStorageOptions {
  /** Folders that exist, by absolute path, with their files by relative path. */
  folders?: Record<string, Record<string, string>>;
  /** Raw device settings; `null` means the file does not exist. */
  settings?: string | null;
  /** What the folder picker returns. */
  pick?: string | null;
  /** Clock for modification times. */
  now?: () => number;
  /** Notify watchers about the app's own writes, like a real file watcher. Default `true`. */
  echoWrites?: boolean;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export interface SimulatedChange {
  paths: readonly string[];
  /** Defaults to the current metadata of each path that exists. */
  entries?: readonly FileEntry[];
  rescan?: boolean;
}

export class MemoryStorage implements Storage {
  readonly folders = new Map<string, Map<string, StoredFile>>();
  settings: string | null;
  pick: string | null;
  root: string | null = null;
  readonly #listeners = new Set<ChangeListener>();
  readonly #now: () => number;
  readonly #echoWrites: boolean;

  constructor(options: MemoryStorageOptions = {}) {
    this.settings = options.settings ?? null;
    this.pick = options.pick ?? null;
    this.#now = options.now ?? Date.now;
    this.#echoWrites = options.echoWrites ?? true;
    for (const [root, files] of Object.entries(options.folders ?? {})) {
      this.addFolder(root, files);
    }
  }

  /** Creates or replaces a folder that can be opened as a workspace. */
  addFolder(root: string, files: Record<string, string> = {}): void {
    const stored = new Map<string, StoredFile>();
    const modified = this.#now();
    for (const [path, contents] of Object.entries(files)) stored.set(path, { contents, modified });
    this.folders.set(root, stored);
  }

  /** Marks a file of the open workspace as read-only (or writable again). */
  setReadOnly(path: string, readOnly = true): void {
    const file = this.#files().get(path);
    if (file) file.readOnly = readOnly;
  }

  /** Deletes a folder, e.g. to simulate a workspace that was moved away. */
  removeFolder(root: string): void {
    this.folders.delete(root);
  }

  #files(): Map<string, StoredFile> {
    if (this.root === null) throw new StorageError("NoWorkspace", "No workspace is open.");
    const files = this.folders.get(this.root);
    if (!files) throw new StorageError("NotFound", "The workspace folder no longer exists.");
    return files;
  }

  #entry(path: string, file: StoredFile): FileEntry {
    return { path, size: byteLength(file.contents), modified: file.modified };
  }

  pickWorkspaceFolder(): Promise<string | null> {
    return Promise.resolve(this.pick);
  }

  async openWorkspace(path: string): Promise<OpenedWorkspace> {
    if (!this.folders.has(path)) {
      throw new StorageError("NotFound", "The folder does not exist.");
    }
    this.root = path;
    return { root: path };
  }

  async listFiles(): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    for (const [path, file] of this.#files()) {
      if (isListablePath(path)) entries.push(this.#entry(path, file));
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async readFile(path: string): Promise<string> {
    checkStoragePath(path);
    const file = this.#files().get(path);
    if (!file) throw new StorageError("NotFound", `${path} does not exist.`);
    if (byteLength(file.contents) > MAX_FILE_BYTES) {
      throw new StorageError("TooLarge", `${path} is larger than 8 MiB.`);
    }
    return file.contents;
  }

  async writeFile(path: string, contents: string): Promise<FileEntry> {
    checkStoragePath(path);
    const files = this.#files();
    if (byteLength(contents) > MAX_FILE_BYTES) {
      throw new StorageError("TooLarge", "The contents are larger than 8 MiB.");
    }
    if (files.get(path)?.readOnly) {
      throw new StorageError("PermissionDenied", `${path} is read-only.`);
    }
    const file = { contents, modified: this.#now() };
    files.set(path, file);
    if (this.#echoWrites) {
      queueMicrotask(() => this.emitChange({ paths: [path] }));
    }
    return this.#entry(path, file);
  }

  async readSettings(): Promise<string | null> {
    return this.settings;
  }

  async writeSettings(contents: string): Promise<void> {
    this.settings = contents;
  }

  async watch(listener: ChangeListener): Promise<Unsubscribe> {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Notifies watchers, as the file watcher would. */
  emitChange(change: SimulatedChange): void {
    const event: ChangeEvent = {
      paths: change.paths,
      entries: change.entries ?? this.#currentEntries(change.paths),
      rescan: change.rescan ?? false,
    };
    for (const listener of [...this.#listeners]) listener(event);
  }

  #currentEntries(paths: readonly string[]): FileEntry[] {
    const files = this.root === null ? undefined : this.folders.get(this.root);
    const entries: FileEntry[] = [];
    for (const path of paths) {
      const file = files?.get(path);
      if (file) entries.push(this.#entry(path, file));
    }
    return entries;
  }

  /**
   * Changes a file behind the app's back. With `notify`, watchers get the
   * event immediately; `contents = null` deletes the file.
   */
  setExternal(path: string, contents: string | null, notify = true): void {
    const files = this.#files();
    if (contents === null) files.delete(path);
    else files.set(path, { contents, modified: this.#now() });
    if (notify && isStoragePath(path)) this.emitChange({ paths: [path] });
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
