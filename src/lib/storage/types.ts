/**
 * The storage boundary. Everything that touches the filesystem, the native
 * folder picker or the device settings file goes through this interface, so
 * other platforms only need another implementation.
 *
 * Workspace paths are relative to the workspace root and `/`-separated.
 */

import type { ChangeEvent, FileEntry } from "$lib/core/workspace";

export type { ChangeEvent, FileEntry };

export interface OpenedWorkspace {
  /** Canonical absolute path of the workspace root. */
  root: string;
}

export type ChangeListener = (event: ChangeEvent) => void;
export type Unsubscribe = () => void;

export interface Storage {
  /** Asks the user for a folder. Resolves to its absolute path, or `null` if cancelled. */
  pickWorkspaceFolder(): Promise<string | null>;
  /** Opens an existing folder as the workspace, replacing the current one. */
  openWorkspace(path: string): Promise<OpenedWorkspace>;
  /** All Markdown files in the workspace, sorted by path. */
  listFiles(): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  /** Writes atomically, creating parent folders, and returns the new metadata. */
  writeFile(path: string, contents: string): Promise<FileEntry>;
  /** Raw device settings, or `null` if the file does not exist. */
  readSettings(): Promise<string | null>;
  writeSettings(contents: string): Promise<void>;
  /** Subscribes to workspace changes, including the app's own writes. */
  watch(listener: ChangeListener): Promise<Unsubscribe>;
}
