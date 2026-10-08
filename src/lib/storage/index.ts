import { isTauri } from "@tauri-apps/api/core";
import { MemoryStorage } from "./MemoryStorage";
import { sampleWorkspace, SAMPLE_ROOT } from "./sample";
import { TauriStorage } from "./TauriStorage";
import type { Storage } from "./types";

export { StorageError, isStorageError, toStorageError, type StorageErrorKind } from "./errors";
export { MemoryStorage, type MemoryStorageOptions } from "./MemoryStorage";
export type * from "./types";

/**
 * The storage for this platform. Outside the desktop app (`pnpm dev` in a
 * browser) a sample workspace is served from memory.
 */
export function createStorage(inTauri: boolean = isTauri()): Storage {
  if (inTauri) return new TauriStorage();
  return new MemoryStorage({ folders: { [SAMPLE_ROOT]: sampleWorkspace }, pick: SAMPLE_ROOT });
}
