import { isTauri } from "@tauri-apps/api/core";
import { MemoryStorage } from "./MemoryStorage";
import { SAMPLE_GIT_DELAY_MS, sampleWorkspace, SAMPLE_ROOT } from "./sample";
import { TauriStorage } from "./TauriStorage";
import type { Storage } from "./types";

export { StorageError, isStorageError, toStorageError, type StorageErrorKind } from "./errors";
export { MemoryStorage, type MemoryStorageOptions } from "./MemoryStorage";
export { MemoryGit, type MemoryGitOptions } from "./MemoryGit";
export { trackWrites, type WriteHooks } from "./tracking";
export type * from "./types";

/**
 * The storage for this platform. Outside the desktop app (`pnpm dev` in a
 * browser) a sample workspace is served from memory.
 */
export function createStorage(inTauri: boolean = isTauri()): Storage {
  if (inTauri) return new TauriStorage();
  return new MemoryStorage({
    folders: { [SAMPLE_ROOT]: sampleWorkspace },
    pick: SAMPLE_ROOT,
    // A repository with an upstream, slow enough to see the sync states.
    git: { unavailable: null, upstream: "origin/main", delay: SAMPLE_GIT_DELAY_MS },
  });
}
