/** `Storage` backed by the desktop app's Rust commands and file watcher. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as v from "valibot";
import type { ChangeEvent, FileEntry } from "$lib/core/workspace";
import { StorageError, toStorageError } from "./errors";
import type { ChangeListener, OpenedWorkspace, Storage, Unsubscribe } from "./types";

export const CHANGE_EVENT = "workspace://changed";

const FileEntrySchema = v.object({ path: v.string(), size: v.number(), modified: v.number() });
const OpenedSchema = v.object({ root: v.string() });
const ChangeEventSchema = v.object({
  paths: v.array(v.string()),
  entries: v.array(FileEntrySchema),
  rescan: v.boolean(),
});
const OptionalString = v.nullable(v.string());

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

  readFile(path: string): Promise<string> {
    return call(v.string(), "read_file", { path });
  }

  writeFile(path: string, contents: string): Promise<FileEntry> {
    return call(FileEntrySchema, "write_file", { path, contents });
  }

  readSettings(): Promise<string | null> {
    return call(OptionalString, "read_settings");
  }

  async writeSettings(contents: string): Promise<void> {
    await call(v.unknown(), "write_settings", { contents });
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
}
