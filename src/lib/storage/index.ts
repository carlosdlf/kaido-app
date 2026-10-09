import { isTauri } from "@tauri-apps/api/core";
import { MemoryStorage } from "./MemoryStorage";
import { SAMPLE_GIT_DELAY_MS, sampleWorkspace, SAMPLE_ROOT } from "./sample";
import { TauriStorage } from "./TauriStorage";
import { MemoryCaptureBus, type CaptureChannel, type CaptureHost } from "./capture";
import { TauriCaptureChannel, TauriCaptureHost } from "./TauriCapture";
import type { Storage } from "./types";

export { StorageError, isStorageError, toStorageError, type StorageErrorKind } from "./errors";
export { MemoryStorage, type MemoryStorageOptions } from "./MemoryStorage";
export { MemoryGit, type MemoryGitOptions } from "./MemoryGit";
export { trackWrites, type WriteHooks } from "./tracking";
export {
  MemoryCaptureBus,
  type CaptureChannel,
  type CaptureHost,
  type CaptureKind,
  type CaptureProjects,
  type CaptureResult,
  type CaptureSubmit,
  type MemoryCaptureBusOptions,
  type ShortcutStatus,
} from "./capture";
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

/** The main window's side of quick capture; `null` outside the desktop app, which has no capture window. */
export function createCaptureHost(inTauri: boolean = isTauri()): CaptureHost | null {
  return inTauri ? new TauriCaptureHost() : null;
}

/**
 * The capture window's side of quick capture. Outside the desktop app the
 * capture page talks to nobody, so it can still be looked at in a browser.
 */
export function createCaptureChannel(inTauri: boolean = isTauri()): CaptureChannel {
  return inTauri ? new TauriCaptureChannel() : new MemoryCaptureBus().channel;
}
