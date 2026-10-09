/** `Storage` backed by the desktop app's Rust commands and file watcher. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as v from "valibot";
import {
  GIT_OPERATIONS,
  PAUSED_REASONS,
  UNAVAILABLE_REASONS,
  type CommitResult,
  type GitRepoStatus,
  type GitStatus,
  type SyncResult,
} from "$lib/core/git";
import type { ChangeEvent, FileEntry } from "$lib/core/workspace";
import { StorageError, toStorageError } from "./errors";
import type {
  ChangeListener,
  CloseHandler,
  FileContents,
  OpenedWorkspace,
  Storage,
  Unsubscribe,
  WriteOptions,
  WrittenFile,
} from "./types";

export const CHANGE_EVENT = "workspace://changed";

const FileEntrySchema = v.object({ path: v.string(), size: v.number(), modified: v.number() });
const OpenedSchema = v.object({ root: v.string() });
const FileContentsSchema = v.object({ contents: v.string(), hash: v.string() });
const WrittenFileSchema = v.object({
  path: v.string(),
  size: v.number(),
  modified: v.number(),
  hash: v.string(),
});
const ChangeEventSchema = v.object({
  paths: v.array(v.string()),
  entries: v.array(FileEntrySchema),
  rescan: v.boolean(),
});
const OptionalString = v.nullable(v.string());
const Count = v.pipe(v.number(), v.integer(), v.minValue(0));
const GitStatusSchema = v.variant("state", [
  v.object({ state: v.literal("unavailable"), reason: v.picklist(UNAVAILABLE_REASONS) }),
  v.object({
    state: v.picklist(["ready", "paused"]),
    pausedReason: v.nullish(v.picklist(PAUSED_REASONS)),
    operation: v.nullish(v.picklist(GIT_OPERATIONS)),
    pausedMessage: v.nullish(v.string()),
    branch: v.nullable(v.string()),
    upstream: v.nullable(v.string()),
    remote: v.boolean(),
    ahead: Count,
    behind: Count,
    changed: v.array(v.string()),
    gitVersion: v.string(),
  }),
]);
const CommitResultSchema = v.object({ commit: v.nullable(v.string()), paths: v.array(v.string()) });
const SyncResultSchema = v.object({
  pulled: Count,
  pushed: Count,
  changed: v.array(v.string()),
  conflicts: v.array(v.object({ path: v.string(), copy: v.string() })),
  // Older backends leave it out: nothing was deferred.
  deferred: v.optional(v.boolean(), false),
});
/** Commands without a result resolve to `null`. */
const NoResult = v.nullish(v.never());

async function call<T>(
  schema: v.GenericSchema<unknown, T>,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  let result: unknown;
  try {
    result = await invoke<unknown>(command, args);
  } catch (error) {
    throw toStorageError(error);
  }
  const parsed = v.safeParse(schema, result);
  if (!parsed.success) {
    throw new StorageError("Io", `Unexpected response from ${command}.`);
  }
  return parsed.output;
}

/**
 * Arguments of `write_file`. The `expectedHash` key is left out for an
 * unconditional write, `null` means create only, and a string must match
 * the hash of the file on disk.
 */
export function writeFileArgs(
  path: string,
  contents: string,
  options: WriteOptions = {},
): Record<string, unknown> {
  const args: Record<string, unknown> = { path, contents };
  if (options.expectedHash !== undefined) args["expectedHash"] = options.expectedHash;
  return args;
}

/** Drops absent optional fields (sent as `null` or left out) from a parsed status. */
export function normalizeGitStatus(status: v.InferOutput<typeof GitStatusSchema>): GitStatus {
  if (status.state === "unavailable") return status;
  const { pausedReason, operation, pausedMessage, ...rest } = status;
  const result: GitRepoStatus = { ...rest };
  if (pausedReason != null) result.pausedReason = pausedReason;
  if (operation != null) result.operation = operation;
  if (pausedMessage != null && pausedMessage !== "") result.pausedMessage = pausedMessage;
  return result;
}

export class TauriStorage implements Storage {
  pickWorkspaceFolder(): Promise<string | null> {
    return call(OptionalString, "pick_workspace_folder");
  }

  openWorkspace(path: string): Promise<OpenedWorkspace> {
    return call(OpenedSchema, "open_workspace", { path });
  }

  listFiles(): Promise<FileEntry[]> {
    return call(v.array(FileEntrySchema), "list_files");
  }

  readFile(path: string): Promise<FileContents> {
    return call(FileContentsSchema, "read_file", { path });
  }

  writeFile(path: string, contents: string, options?: WriteOptions): Promise<WrittenFile> {
    return call(WrittenFileSchema, "write_file", writeFileArgs(path, contents, options));
  }

  renameFile(from: string, to: string): Promise<WrittenFile> {
    return call(WrittenFileSchema, "rename_file", { from, to });
  }

  async deleteFile(path: string, expectedHash: string): Promise<void> {
    await call(NoResult, "delete_file", { path, expectedHash });
  }

  readSettings(): Promise<string | null> {
    return call(OptionalString, "read_settings");
  }

  async writeSettings(contents: string): Promise<void> {
    await call(v.unknown(), "write_settings", { contents });
  }

  async gitStatus(): Promise<GitStatus> {
    return normalizeGitStatus(await call(GitStatusSchema, "git_status"));
  }

  gitCommit(message: string): Promise<CommitResult> {
    return call(CommitResultSchema, "git_commit", { message });
  }

  gitSync(): Promise<SyncResult> {
    return call(SyncResultSchema, "git_sync");
  }

  async watch(listener: ChangeListener): Promise<Unsubscribe> {
    try {
      return await listen<unknown>(CHANGE_EVENT, (event) => {
        const parsed = v.safeParse(ChangeEventSchema, event.payload);
        // A malformed payload still means something changed; rescan to be safe.
        const change: ChangeEvent = parsed.success
          ? parsed.output
          : { paths: [], entries: [], rescan: true };
        listener(change);
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }

  async onCloseRequested(handler: CloseHandler): Promise<Unsubscribe> {
    try {
      return await getCurrentWindow().onCloseRequested(async (event) => {
        let close = true;
        try {
          close = await handler();
        } catch {
          // A failing handler must never trap the user in the app.
        }
        if (!close) event.preventDefault();
      });
    } catch (error) {
      throw toStorageError(error);
    }
  }
}
