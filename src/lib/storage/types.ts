/**
 * The storage boundary. Everything that touches the filesystem, the native
 * folder picker or the device settings file goes through this interface, so
 * other platforms only need another implementation.
 *
 * Workspace paths are relative to the workspace root and `/`-separated.
 */

import type { CommitResult, GitStatus, SyncResult } from "$lib/core/git";
import type { ChangeEvent, FileEntry } from "$lib/core/workspace";

export type { ChangeEvent, CommitResult, FileEntry, GitStatus, SyncResult };

export interface OpenedWorkspace {
  /** Canonical absolute path of the workspace root. */
  root: string;
}

export type ChangeListener = (event: ChangeEvent) => void;
export type Unsubscribe = () => void;
/**
 * Runs when the user asks to close the app. Resolves to `true` to let the
 * window close, or `false` to keep it open.
 */
export type CloseHandler = () => Promise<boolean>;

/** A file's contents with an opaque hash of its bytes. */
export interface FileContents {
  contents: string;
  /** Same contents give the same hash; compare it, never compute it. */
  hash: string;
}

export interface WriteOptions {
  /**
   * Precondition checked right before the file is replaced:
   * - omitted: write unconditionally;
   * - `null`: create only, a `Conflict` error if the file exists;
   * - a hash: the file must exist with exactly this hash, else `Conflict`.
   */
  expectedHash?: string | null;
}

/** Metadata of a written file, with the hash of the written contents. */
export interface WrittenFile extends FileEntry {
  hash: string;
}

export interface Storage {
  /** Asks the user for a folder. Resolves to its absolute path, or `null` if cancelled. */
  pickWorkspaceFolder(): Promise<string | null>;
  /** Opens an existing folder as the workspace, replacing the current one. */
  openWorkspace(path: string): Promise<OpenedWorkspace>;
  /** All Markdown files in the workspace, sorted by path. */
  listFiles(): Promise<FileEntry[]>;
  readFile(path: string): Promise<FileContents>;
  /** Writes atomically, creating parent folders, and returns the new metadata. */
  writeFile(path: string, contents: string, options?: WriteOptions): Promise<WrittenFile>;
  /**
   * Renames a note within its folder and returns the metadata and hash of
   * the file at `to`. Never replaces an existing file (`Conflict`); moving
   * to another folder is `InvalidPath`. A case-only rename is allowed.
   */
  renameFile(from: string, to: string): Promise<WrittenFile>;
  /**
   * Deletes a note, moving it to the system trash where there is one. The
   * file must still have `expectedHash`, else `Conflict`.
   */
  deleteFile(path: string, expectedHash: string): Promise<void>;
  /** Raw device settings, or `null` if the file does not exist. */
  readSettings(): Promise<string | null>;
  writeSettings(contents: string): Promise<void>;
  /** Subscribes to workspace changes, including the app's own writes. */
  watch(listener: ChangeListener): Promise<Unsubscribe>;
  /**
   * Registers the handler that runs before the app window closes. Only one
   * handler should be registered at a time.
   */
  onCloseRequested(handler: CloseHandler): Promise<Unsubscribe>;
  /** The workspace's git state. Never fails for a missing git or repository: those are states. */
  gitStatus(): Promise<GitStatus>;
  /**
   * Stages and commits every change inside the workspace folder (temporary
   * files excluded). `commit` is `null` when there was nothing to commit.
   * Fails with `GitPaused` in a paused state that does not allow commits
   * (only `outside-changes`, `outside-commits`, `upstream-mismatch` and
   * `upstream-gone` do).
   */
  gitCommit(message: string): Promise<CommitResult>;
  /**
   * Fetches, rebases onto the upstream (keeping both versions of conflicting
   * notes) and pushes. Requires an upstream. With uncommitted changes in
   * the workspace it only fetches and reports `deferred`. Fails with
   * `GitNetwork`, `GitAuth`, `GitPaused` (message: the reason) or `GitFailed`.
   */
  gitSync(): Promise<SyncResult>;
}
