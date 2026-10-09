/**
 * Autosave for one open document.
 *
 * A session tracks the last known disk version (`base` and its hash) and
 * the editor text (`buffer`). Edits are cheap: they only remember how to
 * read the new text and restart a timer, so nothing is copied or compared
 * on the keystroke path. When the timer fires, or on a forced flush, the
 * buffer is written with the base hash as precondition. All disk work runs
 * one step at a time, so at most one write is in flight; edits made during
 * a write are saved after it completes.
 *
 * When the file changes on disk:
 * - the same hash as the base is the echo of our own write and is ignored;
 * - without unsaved edits the new version replaces the buffer;
 * - with unsaved edits both versions are kept: the disk version is written
 *   to a conflict copy next to the file and the buffer then replaces it.
 *
 * Renaming or deleting the file runs as an exclusive step (`exclusive`)
 * after pending edits are saved, so no write races it; a rename then moves
 * the session to the new path (`moveTo`) with its buffer and status.
 *
 * Nothing here touches the platform: storage access and timers are passed
 * in, so the whole flow can be tested with fakes.
 */

import { FILE_NAME_LIMIT_BYTES, truncateUtf8, utf8Length } from "./noteNames";
import { formatAge } from "./time";

/** Delay after the last edit before saving. */
export const SAVE_DELAY_MS = 500;
/** How often the conflict flow is attempted before giving up. */
export const MAX_CONFLICT_ATTEMPTS = 3;
/** Retry delays after a failed save; the last one repeats. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];
/** Conflict copy names tried before giving up (`name`, `name 2`, … `name 99`). */
export const MAX_CONFLICT_COPY_NAMES = 99;

export type ReadOutcome =
  | { kind: "ok"; contents: string; hash: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export type WriteOutcome =
  { kind: "ok"; hash: string } | { kind: "conflict" } | { kind: "error"; message: string };

/** Storage access for sessions. Implementations report failures as outcomes. */
export interface DocumentIO {
  read(path: string): Promise<ReadOutcome>;
  /**
   * Writes `contents` if the file on disk has `expectedHash`, or, with
   * `null`, only if it does not exist yet.
   */
  write(path: string, contents: string, expectedHash: string | null): Promise<WriteOutcome>;
}

export type TimerHandle = unknown;

export interface Timers {
  now(): number;
  setTimeout(task: () => void, delay: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type SaveStatus =
  | { kind: "saved"; at: number }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "failed"; message: string };

export interface SaveEvents {
  /** The status changed. */
  status?(status: SaveStatus): void;
  /** The buffer was written; `contents` is what is on disk now. */
  saved?(contents: string): void;
  /** The file changed on disk and replaced an unchanged buffer. */
  reloaded?(contents: string): void;
  /** The file was deleted on disk while the buffer had no unsaved edits. */
  removed?(): void;
  /** The disk version was kept as `copyPath` before the buffer replaced it. */
  conflict?(copyPath: string): void;
}

export interface SaveSessionOptions {
  path: string;
  /** Contents and hash as read from disk. */
  contents: string;
  hash: string;
  /** When the file was last written, for the initial status. */
  savedAt: number;
  io: DocumentIO;
  timers: Timers;
  events?: SaveEvents;
  saveDelay?: number;
  retryDelays?: readonly number[];
}

const MARKDOWN_EXTENSION = /\.md$/i;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Local time as `YYYY-MM-DD HHmm`. */
export function conflictStamp(time: number): string {
  const date = new Date(time);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * Where the other version of `path` is kept after a conflict:
 * `<dir>/<stem> (conflict YYYY-MM-DD HHmm).md`, then `… 2.md`, `… 3.md`.
 * A stem too long for the suffix to fit in a file name is shortened.
 */
export function conflictCopyPath(path: string, time: number, attempt = 1): string {
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const extension = MARKDOWN_EXTENSION.exec(name)?.[0] ?? ".md";
  const stem = MARKDOWN_EXTENSION.test(name) ? name.slice(0, -extension.length) : name;
  const suffix = ` (conflict ${conflictStamp(time)})${attempt > 1 ? ` ${attempt}` : ""}${extension}`;
  const room = FILE_NAME_LIMIT_BYTES - utf8Length(suffix);
  return `${folder}${truncateUtf8(stem, room)}${suffix}`;
}

/** File name of a workspace path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Header text: `saved · 2m ago`, `saving…`, `unsaved` or `save failed — retrying`. */
export function describeSaveStatus(status: SaveStatus, now: number): string {
  switch (status.kind) {
    case "saved": {
      const age = formatAge(status.at, now);
      return `saved · ${age === "now" ? "just now" : `${age} ago`}`;
    }
    case "saving":
      return "saving…";
    case "unsaved":
      return "unsaved";
    case "failed":
      return "save failed — retrying";
  }
}

export function sameStatus(a: SaveStatus, b: SaveStatus): boolean {
  if (a.kind === "saved") return b.kind === "saved" && a.at === b.at;
  if (a.kind === "failed") return b.kind === "failed" && a.message === b.message;
  return a.kind === b.kind;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Thrown to exclusive steps that never ran because the session was disposed. */
export const SESSION_CLOSED = "The note was closed.";

interface ExclusiveStep {
  run(): Promise<void>;
  cancel(): void;
}

export class SaveSession {
  #path: string;
  /** Last known disk contents, or `null` if the file does not exist. */
  #base: string | null;
  #baseHash: string | null;
  #buffer: string;
  /** Reads a newer buffer that has not been materialized yet. */
  #pending: (() => string) | null = null;
  #status: SaveStatus;
  #savedAt: number;

  readonly #io: DocumentIO;
  readonly #timers: Timers;
  readonly #events: SaveEvents;
  readonly #saveDelay: number;
  readonly #retryDelays: readonly number[];

  #timer: TimerHandle = null;
  #timerSet = false;
  #failures = 0;
  #wantSave = false;
  #wantCheck = false;
  #active = false;
  #idle: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly #steps: ExclusiveStep[] = [];

  constructor(options: SaveSessionOptions) {
    this.#path = options.path;
    this.#base = options.contents;
    this.#baseHash = options.hash;
    this.#buffer = options.contents;
    this.#savedAt = options.savedAt;
    this.#status = { kind: "saved", at: options.savedAt };
    this.#io = options.io;
    this.#timers = options.timers;
    this.#events = options.events ?? {};
    this.#saveDelay = options.saveDelay ?? SAVE_DELAY_MS;
    this.#retryDelays = options.retryDelays ?? RETRY_DELAYS_MS;
  }

  /** Path of the document; changes with `moveTo`. */
  get path(): string {
    return this.#path;
  }

  /** Hash of the last known disk version, or `null` if the file does not exist. */
  get hash(): string | null {
    return this.#baseHash;
  }

  get status(): SaveStatus {
    return this.#status;
  }

  /** The current buffer. */
  get text(): string {
    if (this.#pending !== null) {
      this.#buffer = this.#pending();
      this.#pending = null;
    }
    return this.#buffer;
  }

  /** Whether the buffer differs from the disk version, or the file is gone. */
  get dirty(): boolean {
    return this.#base === null || this.text !== this.#base;
  }

  /** No save is scheduled or running. */
  get idle(): boolean {
    return !this.#active && !this.#timerSet;
  }

  /**
   * Records an edit. `read` returns the new buffer and is only called when
   * the text is needed, so it must capture an immutable snapshot.
   */
  edit(read: () => string): void {
    if (this.#disposed) return;
    this.#pending = read;
    this.#failures = 0;
    this.#schedule(this.#saveDelay);
    if (this.#status.kind === "saved") this.#setStatus({ kind: "unsaved" });
  }

  /** Saves now instead of waiting; resolves when all pending work is done. */
  flush(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#cancelTimer();
    if (this.#pending !== null || this.dirty) this.#wantSave = true;
    return this.#pump();
  }

  /** The file changed or disappeared on disk; resolves when handled. */
  externalChange(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#wantCheck = true;
    return this.#pump();
  }

  /** Resolves when no work is running. */
  settled(): Promise<void> {
    return this.#idle;
  }

  /**
   * Saves pending edits, then runs `task` as the only disk work of this
   * session: saves and checks wait until it is done. Resolves or rejects
   * like `task`; a session disposed before the task starts rejects with
   * `SESSION_CLOSED`.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.#disposed) return Promise.reject(new Error(SESSION_CLOSED));
    return new Promise<T>((resolve, reject) => {
      this.#cancelTimer();
      if (this.#pending !== null || this.dirty) this.#wantSave = true;
      this.#steps.push({
        run: () => task().then(resolve, reject),
        cancel: () => reject(new Error(SESSION_CLOSED)),
      });
      void this.#pump();
    });
  }

  /**
   * The file was renamed to `path`; `hash` is the hash of the file there.
   * Call it from an `exclusive` task. Buffer, status and pending edits stay;
   * if the file there is not the known disk version, it is checked again.
   */
  moveTo(path: string, hash: string): void {
    this.#path = path;
    if (this.#baseHash !== null && hash !== this.#baseHash) this.#wantCheck = true;
  }

  /** Stops timers and events. Work already started still finishes, silently. */
  dispose(): void {
    this.#disposed = true;
    this.#cancelTimer();
    for (const step of this.#steps.splice(0)) step.cancel();
  }

  #schedule(delay: number): void {
    this.#cancelTimer();
    this.#timerSet = true;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timerSet = false;
      this.#timer = null;
      this.#wantSave = true;
      void this.#pump();
    }, delay);
  }

  #cancelTimer(): void {
    if (!this.#timerSet) return;
    this.#timers.clearTimeout(this.#timer);
    this.#timerSet = false;
    this.#timer = null;
  }

  #pump(): Promise<void> {
    if (!this.#active) {
      this.#active = true;
      this.#idle = this.#run();
    }
    return this.#idle;
  }

  async #run(): Promise<void> {
    try {
      while (!this.#disposed) {
        if (this.#wantCheck) {
          this.#wantCheck = false;
          await this.#check();
        } else if (this.#wantSave) {
          this.#wantSave = false;
          await this.#save();
        } else if (this.#steps.length > 0) {
          await this.#steps.shift()?.run();
        } else {
          break;
        }
      }
    } finally {
      this.#active = false;
    }
  }

  async #read(): Promise<ReadOutcome> {
    try {
      return await this.#io.read(this.#path);
    } catch (error) {
      return { kind: "error", message: errorMessage(error) };
    }
  }

  async #write(path: string, contents: string, expectedHash: string | null): Promise<WriteOutcome> {
    try {
      return await this.#io.write(path, contents, expectedHash);
    } catch (error) {
      return { kind: "error", message: errorMessage(error) };
    }
  }

  async #save(): Promise<void> {
    const contents = this.text;
    if (this.#base !== null && contents === this.#base) {
      this.#settle();
      return;
    }
    this.#setStatus({ kind: "saving" });
    const result = await this.#write(this.#path, contents, this.#baseHash);
    if (this.#disposed) return;
    if (result.kind === "ok") this.#saved(contents, result.hash);
    else if (result.kind === "conflict") await this.#resolveConflict(null);
    else this.#fail(result.message);
  }

  async #check(): Promise<void> {
    const disk = await this.#read();
    if (this.#disposed || disk.kind === "error") return;
    if (disk.kind === "missing") {
      if (this.#base === null) return;
      const clean = !this.dirty;
      this.#base = null;
      this.#baseHash = null;
      if (clean) {
        this.#cancelTimer();
        this.#events.removed?.();
      } else if (!this.#timerSet) {
        // Unsaved edits re-create the file with the next save.
        this.#schedule(this.#saveDelay);
      }
      return;
    }
    if (disk.hash === this.#baseHash) return;
    const text = this.text;
    if (disk.contents === text) {
      this.#adopt(disk.contents, disk.hash);
      this.#settle();
      return;
    }
    if (this.#base !== null && text === this.#base) {
      this.#cancelTimer();
      this.#adopt(disk.contents, disk.hash);
      this.#buffer = disk.contents;
      this.#savedAt = this.#timers.now();
      this.#setStatus({ kind: "saved", at: this.#savedAt });
      this.#events.reloaded?.(disk.contents);
      return;
    }
    await this.#resolveConflict(disk);
  }

  /** Keeps both versions; see the module comment. */
  async #resolveConflict(known: ReadOutcome | null): Promise<void> {
    this.#setStatus({ kind: "saving" });
    let disk = known;
    for (let attempt = 0; attempt < MAX_CONFLICT_ATTEMPTS; attempt += 1) {
      if (disk === null) disk = await this.#read();
      if (this.#disposed) return;
      if (disk.kind === "error") {
        this.#fail(disk.message);
        return;
      }
      const contents = this.text;
      let expected: string | null = null;
      if (disk.kind === "ok") {
        if (disk.contents === contents) {
          this.#adopt(disk.contents, disk.hash);
          this.#settle();
          return;
        }
        // A version that is already the base was kept before (or is ours).
        if (disk.hash !== this.#baseHash) {
          const copy = await this.#writeCopy(disk.contents);
          if (this.#disposed) return;
          if (copy.kind === "error") {
            this.#fail(copy.message);
            return;
          }
          // The disk version is safe in the copy, so it becomes the base: a
          // retry after a failed write only writes the buffer, without
          // another copy.
          this.#adopt(disk.contents, disk.hash);
          this.#events.conflict?.(copy.path);
        }
        expected = disk.hash;
      }
      const result = await this.#write(this.#path, contents, expected);
      if (this.#disposed) return;
      if (result.kind === "ok") {
        this.#saved(contents, result.hash);
        return;
      }
      if (result.kind === "error") {
        this.#fail(result.message);
        return;
      }
      disk = null;
    }
    this.#fail("The file keeps changing on disk.");
  }

  async #writeCopy(
    contents: string,
  ): Promise<{ kind: "ok"; path: string } | { kind: "error"; message: string }> {
    const time = this.#timers.now();
    for (let attempt = 1; attempt <= MAX_CONFLICT_COPY_NAMES; attempt += 1) {
      const path = conflictCopyPath(this.#path, time, attempt);
      const result = await this.#write(path, contents, null);
      if (result.kind === "ok") return { kind: "ok", path };
      if (result.kind === "error") return result;
    }
    return { kind: "error", message: "No free name for a conflict copy." };
  }

  #adopt(contents: string, hash: string): void {
    this.#base = contents;
    this.#baseHash = hash;
  }

  #saved(contents: string, hash: string): void {
    this.#adopt(contents, hash);
    this.#failures = 0;
    this.#savedAt = this.#timers.now();
    this.#events.saved?.(contents);
    this.#settle();
  }

  /** Status after a step: unsaved while newer edits wait, saved otherwise. */
  #settle(): void {
    const unsaved = this.#pending !== null || this.#base === null || this.#buffer !== this.#base;
    this.#setStatus(unsaved ? { kind: "unsaved" } : { kind: "saved", at: this.#savedAt });
  }

  #fail(message: string): void {
    const delay =
      this.#retryDelays[Math.min(this.#failures, this.#retryDelays.length - 1)] ?? SAVE_DELAY_MS;
    this.#failures += 1;
    this.#setStatus({ kind: "failed", message });
    this.#schedule(delay);
  }

  #setStatus(status: SaveStatus): void {
    if (sameStatus(this.#status, status)) return;
    this.#status = status;
    if (!this.#disposed) this.#events.status?.(status);
  }
}
