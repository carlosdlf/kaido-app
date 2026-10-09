/**
 * Application state: opens the workspace, keeps the model in sync with the
 * file watcher, loads note contents lazily and saves edits.
 *
 * The first render only needs the file listing. Titles and task counts are
 * read in the background afterwards and published at most once per frame,
 * and a note's contents are read when it is selected.
 *
 * Every opened note gets a `SaveSession` that autosaves its edits. Sessions
 * are flushed when another note is selected, the window loses focus or the
 * app closes, and are dropped once everything is on disk. Closing the window
 * or opening another workspace while edits cannot be saved is refused once
 * with a notice; trying again right away goes ahead without them.
 */

import {
  baseName,
  SaveSession,
  type DocumentIO,
  type ReadOutcome,
  type SaveStatus,
  type Timers,
  type WriteOutcome,
} from "$lib/core/saveMachine";
import { newNoteFolder, newNotePath } from "$lib/core/newNote";
import {
  ALL_TASKS,
  fallbackSummary,
  listItems,
  MAX_SUMMARY_BYTES,
  PathQueue,
  pathsToSummarize,
  summarizeFile,
  SummaryStore,
  type Summaries,
} from "$lib/core/views";
import {
  applyChange,
  buildWorkspace,
  classifyPath,
  createPathFilter,
  diffFiles,
  findProject,
  INBOX,
  isTaskListPath,
  WORKSPACE_CONFIG_PATH,
  workspaceFiles,
  type ChangeEvent,
  type FileEntry,
  type Workspace,
} from "$lib/core/workspace";
import type { ConfigWarning, ParseResult } from "$lib/config/parse";
import { parseSettings, serializeSettings, type DeviceSettings } from "$lib/config/settings";
import { parseWorkspaceConfig, type WorkspaceConfig } from "$lib/config/workspaceConfig";
import {
  isStorageError,
  toStorageError,
  type FileContents,
  type Storage,
  type Unsubscribe,
  type WrittenFile,
} from "$lib/storage";

export type Phase =
  | { kind: "starting" }
  | { kind: "no-workspace" }
  | { kind: "loading"; path: string }
  | { kind: "ready"; root: string }
  | { kind: "error"; message: string };

export type DocumentState =
  | { status: "loading"; path: string }
  | { status: "ready"; path: string; text: string; modified: number }
  | { status: "missing"; path: string }
  | { status: "too-large"; path: string }
  | { status: "error"; path: string; message: string };

export interface Toast {
  id: number;
  message: string;
}

export interface AppStateOptions {
  /** Runs the initial background work after the first render. */
  defer?: (task: () => void) => void;
  /** Schedules publishing loaded summaries; called at most once per pending update. */
  schedule?: (task: () => void) => void;
  /** Files read in parallel while loading titles and counts. */
  concurrency?: number;
  /** Clock and timers for autosave. */
  timers?: Timers;
  /** Delay after the last edit before saving. */
  saveDelay?: number;
  /** Longest wait for pending saves when the app closes or switches workspaces. */
  closeTimeout?: number;
}

interface LoadedConfig {
  config: WorkspaceConfig;
  warnings: ConfigWarning[];
}

const EMPTY_WORKSPACE: Workspace = buildWorkspace([], { ignore: [] });

const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (task, delay) => setTimeout(task, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Writes to a closed workspace are refused, so they never land in the next one. */
const WORKSPACE_CLOSED = "The workspace was closed.";

function defaultDefer(task: () => void): void {
  setTimeout(task, 0);
}

function defaultSchedule(task: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => task());
  else setTimeout(task, 16);
}

function openErrorMessage(error: unknown, path: string): string {
  const storageError = toStorageError(error);
  switch (storageError.kind) {
    case "NotFound":
      return `The folder ${path} could not be found. It may have been moved or deleted.`;
    case "NotADirectory":
      return `${path} is not a folder.`;
    case "PermissionDenied":
      return `Kaido does not have permission to open ${path}.`;
    default:
      return `The workspace could not be opened: ${storageError.message}`;
  }
}

function refreshErrorMessage(error: unknown): string {
  const storageError = toStorageError(error);
  switch (storageError.kind) {
    case "NotFound":
    case "NoWorkspace":
      return "The workspace folder is no longer available. Changes on disk are not shown.";
    case "PermissionDenied":
      return "Kaido can no longer read the workspace folder. Changes on disk are not shown.";
    default:
      return `The workspace could not be refreshed: ${storageError.message}`;
  }
}

export function conflictMessage(copyPath: string): string {
  return `Changed outside Kaido — the other version was saved as ${baseName(copyPath)}`;
}

/** How many names a new note tries when another file takes them first. */
export const MAX_CREATE_ATTEMPTS = 5;

export const NO_FREE_NOTE_NAME = "No free name for a new note.";

export function createNoteFailedMessage(message: string): string {
  return `The note could not be created: ${message}`;
}

export const UNSAVED_ON_CLOSE =
  "Some changes could not be saved. Close again to quit without them.";

export function unsavedOnSwitchMessage(paths: readonly string[]): string {
  return `Changes to ${paths.join(", ")} could not be saved. Open the folder again to switch without them.`;
}

/** Actions that are refused once while edits cannot be saved. */
type UnsafeAction = "close" | "switch";

const SETTINGS_NOT_SAVED =
  "settings.json was left unchanged, so this workspace will not be reopened next time. Fix or remove the file to let Kaido save it.";

export class AppState {
  phase: Phase = $state({ kind: "starting" });
  workspace: Workspace = $state.raw(EMPTY_WORKSPACE);
  summaries: Summaries = $state.raw(new SummaryStore().view());
  /** Selected sidebar entry: a project name or `ALL_TASKS`. */
  folder: string = $state(INBOX);
  /** Path of the selected list item, or an empty string. */
  item: string = $state("");
  document: DocumentState | null = $state.raw(null);
  warnings: ConfigWarning[] = $state.raw([]);
  /** A problem keeping the workspace up to date, or `null`. */
  notice: string | null = $state(null);
  /** Save state of the open note, or `null` when no note is open. */
  saveStatus: SaveStatus | null = $state.raw(null);
  /** Short, non-blocking messages. */
  toasts: Toast[] = $state.raw([]);
  /** Bumped when the editor should take focus, e.g. after a note was created. */
  editorFocusRequest: number = $state(0);

  readonly #storage: Storage;
  readonly #defer: (task: () => void) => void;
  readonly #schedule: (task: () => void) => void;
  readonly #concurrency: number;
  readonly #timers: Timers;
  readonly #saveDelay: number | undefined;
  readonly #closeTimeout: number;
  /** Autosave sessions by path: the open note and notes still being saved. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  readonly #sessions = new Map<string, SaveSession>();
  /** Sessions of a previous workspace that are still being saved. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  readonly #closingSessions = new Set<SaveSession>();
  /** Whether sessions may still reach the disk; replaced when the workspace changes. */
  #io = { open: true };
  /** Pending saves of a previous workspace, awaited before another one opens. */
  #closing: Promise<void> = Promise.resolve();
  #pendingCloses = 0;
  #stopCloseHandler: Unsubscribe | null = null;
  #disposed = false;
  /**
   * The action that was just refused because of unsaved edits. Trying it
   * again goes ahead; any edit, successful save or check that finds
   * nothing unsaved withdraws that consent.
   */
  #refused: UnsafeAction | null = null;
  /** Bumped by every `openWorkspace` call, so only the latest one proceeds. */
  #openRequest = 0;
  #toastId = 0;
  #settings: ParseResult<DeviceSettings> = parseSettings(null);
  #settingsWarnings: ConfigWarning[] = [];
  #config: WorkspaceConfig = parseWorkspaceConfig(null).value;
  #files: FileEntry[] = [];
  /** Every shown file by path, rebuilt with the model. */
  #index: Map<string, FileEntry> = $derived(workspaceFiles(this.workspace));
  #unwatch: Unsubscribe | null = null;
  /** Bumped on every workspace switch so stale async work is dropped. */
  #generation = 0;
  /** Bumped on every document read so only the latest one lands. */
  #documentRequest = 0;
  /** Change events are applied one at a time, after the initial load. */
  #changes: Promise<void> = Promise.resolve();
  /** A rescan failed; every later notification is handled as a rescan until one succeeds. */
  #needsRescan = false;
  #background: Promise<void> = Promise.resolve();
  readonly #store = new SummaryStore();
  readonly #queue = new PathQueue();
  #pump: Promise<void> = Promise.resolve();
  #pumping = false;
  #publishPending = false;

  constructor(storage: Storage, options: AppStateOptions = {}) {
    this.#storage = storage;
    this.#defer = options.defer ?? defaultDefer;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#concurrency = options.concurrency ?? 8;
    this.#timers = options.timers ?? systemTimers;
    this.#saveDelay = options.saveDelay;
    this.#closeTimeout = options.closeTimeout ?? 5_000;
  }

  /** Reads device settings and reopens the last workspace, if any. */
  async start(): Promise<void> {
    this.#watchClose();
    try {
      this.#settings = parseSettings(await this.#storage.readSettings());
      this.#settingsWarnings = this.#settings.warnings;
    } catch (error) {
      // Without readable settings, start fresh but never overwrite the file.
      this.#settings = { ...parseSettings(null), writable: false };
      this.#settingsWarnings = [
        { field: "", message: `settings.json: ${toStorageError(error).message}` },
      ];
    }
    this.warnings = this.#settingsWarnings;
    const path = this.#settings.value.workspace;
    if (path === undefined) this.phase = { kind: "no-workspace" };
    else await this.openWorkspace(path);
  }

  /** Asks for a folder and opens it. Cancelling keeps the current state. */
  async pickWorkspace(): Promise<void> {
    let path: string | null;
    try {
      path = await this.#storage.pickWorkspaceFolder();
    } catch (error) {
      this.phase = { kind: "error", message: toStorageError(error).message };
      return;
    }
    if (path !== null) await this.openWorkspace(path);
  }

  /**
   * Opens `path` as the workspace. Pending edits are saved first; if some
   * cannot be saved, the current workspace stays open and a notice names
   * them, unless this is the second attempt in a row.
   */
  async openWorkspace(path: string): Promise<void> {
    const request = ++this.#openRequest;
    if (this.#sessions.size > 0) {
      await this.#withTimeout(this.flush());
      if (request !== this.#openRequest || this.#disposed) return;
      const unsaved = this.#unsaved(this.#sessions.values());
      if (!this.#allow("switch", unsaved, unsavedOnSwitchMessage(unsaved))) return;
    }
    const generation = ++this.#generation;
    const closing = this.#closeSessions();
    this.#unwatch?.();
    this.#unwatch = null;
    this.#queue.clear();
    this.#pumping = false;
    this.#needsRescan = false;
    // Change events wait for the initial listing, so they are never
    // applied first and then overwritten by it.
    let finishInitialLoad: () => void = () => undefined;
    this.#changes = new Promise((resolve) => (finishInitialLoad = resolve));
    this.phase = { kind: "loading", path };
    try {
      // Pending saves must land in the workspace they belong to.
      if (closing) await closing;
      const { root } = await this.#storage.openWorkspace(path);
      // Subscribe before listing so no change between the two is missed.
      const unwatch = await this.#storage.watch((event) => this.#onChange(event, generation));
      if (generation !== this.#generation) {
        unwatch();
        return;
      }
      this.#unwatch = unwatch;
      const [config, files] = await Promise.all([
        this.#readWorkspaceConfig(),
        this.#storage.listFiles(),
      ]);
      if (generation !== this.#generation) return;

      this.#applyConfig(config);
      this.#files = files;
      this.workspace = buildWorkspace(files, this.#config);
      this.#store.clear();
      this.summaries = this.#store.view();
      this.notice = null;
      this.#select(INBOX);
      this.phase = { kind: "ready", root };
      this.#rememberWorkspace(root);
      this.#background = new Promise((resolve) => {
        this.#defer(() => {
          this.#enqueue([...this.#index.keys()], generation);
          resolve();
        });
      });
    } catch (error) {
      // A newer open overtook this one; it owns the state now.
      if (generation !== this.#generation || toStorageError(error).kind === "Superseded") return;
      this.#unwatch?.();
      this.#unwatch = null;
      this.phase = { kind: "error", message: openErrorMessage(error, path) };
    } finally {
      finishInitialLoad();
    }
  }

  /** Selects a sidebar entry and its first list item. */
  selectFolder(folder: string): void {
    if (folder === this.folder) return;
    this.#select(folder);
  }

  /** Selects a list item and reads its contents. */
  selectItem(path: string): void {
    if (path === this.item && this.document?.status !== "error") return;
    this.#leave(path);
    this.item = path;
    const live = this.#sessions.get(path);
    if (live) {
      // Unsaved or still saving: show the buffer, not the disk version.
      this.#documentRequest += 1;
      this.document = this.#ready(path, live.text);
      this.saveStatus = live.status;
      return;
    }
    this.saveStatus = null;
    void this.#loadDocument(path, this.#generation);
  }

  /**
   * Records an edit of the open note. `read` returns the new text and must
   * capture an immutable snapshot; it is called only when the text is saved.
   */
  edit(path: string, read: () => string): void {
    // The editor may report a last edit for a note it is leaving; its
    // session saves it even if another note is selected by now.
    const session = this.#sessions.get(path);
    if (!session) return;
    this.#refused = null;
    session.edit(read);
  }

  /**
   * Creates an empty note in the selected project (the inbox when no
   * project is selected), opens it and asks the editor for focus. A name
   * taken on disk meanwhile moves on to the next one; other failures show a
   * toast and change nothing.
   */
  async createNote(): Promise<void> {
    if (this.phase.kind !== "ready") return;
    const generation = this.#generation;
    const folder = newNoteFolder(this.folder);
    const isIgnored = createPathFilter(this.#config);
    // Names are compared case-insensitively, since many file systems are.
    const tried: string[] = [];
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      // The listing may change while a write is in flight.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local to this call, never rendered
      const taken = new Set(this.#files.map((file) => file.path.toLowerCase()));
      const path = newNotePath(folder, (candidate) => {
        const key = candidate.toLowerCase();
        // An ignored name would be created but never shown.
        return taken.has(key) || tried.includes(key) || classifyPath(candidate, isIgnored) === null;
      });
      if (path === null) break;
      let written: WrittenFile;
      try {
        written = await this.#storage.writeFile(path, "", { expectedHash: null });
      } catch (error) {
        if (generation !== this.#generation) return;
        const storageError = toStorageError(error);
        if (storageError.kind === "Conflict") {
          tried.push(path.toLowerCase());
          continue;
        }
        this.#toast(createNoteFailedMessage(storageError.message));
        return;
      }
      if (generation !== this.#generation) return;
      this.#openCreated(written, folder);
      return;
    }
    if (generation === this.#generation) this.#toast(NO_FREE_NOTE_NAME);
  }

  /** Saves every pending edit now. */
  flush(): Promise<void> {
    return Promise.all([...this.#sessions.values()].map((session) => session.flush())).then(
      () => undefined,
    );
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }

  /** Resolves when change handling and background reads are done, and publishes them. */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [this.#background, this.#changes, this.#pump];
      await Promise.all(pending);
      if (
        pending[0] === this.#background &&
        pending[1] === this.#changes &&
        pending[2] === this.#pump
      ) {
        break;
      }
    }
    this.#publish();
  }

  /** Stops watching and saves what is pending. The instance should not be used afterwards. */
  dispose(): void {
    this.#disposed = true;
    this.#generation += 1;
    this.#queue.clear();
    this.#unwatch?.();
    this.#unwatch = null;
    this.#stopCloseHandler?.();
    this.#stopCloseHandler = null;
    void this.#closeSessions();
  }

  #select(folder: string): void {
    this.folder = folder;
    const first = this.#firstItem(folder);
    this.#leave("");
    this.item = "";
    this.document = null;
    this.saveStatus = null;
    if (first !== null) this.selectItem(first);
  }

  /**
   * Adds a note this app just created to the model without waiting for the
   * watcher, and opens it with a session based on the creation write. The
   * watcher's later report carries the same metadata, so it changes nothing.
   */
  #openCreated(written: WrittenFile, folder: string): void {
    const { hash, ...entry } = written;
    const path = entry.path;
    this.#files = [...this.#files.filter((file) => file.path !== path), entry];
    this.workspace = buildWorkspace(this.#files, this.#config);
    this.#store.set(path, summarizeFile(path, ""));
    this.#schedulePublish();

    this.#leave(path);
    // A session left from a note deleted at this path is replaced.
    this.#sessions.get(path)?.dispose();
    const session = this.#createSession(path, { contents: "", hash }, entry.modified);
    this.#sessions.set(path, session);
    // Drop reads still in flight for the previous selection.
    this.#documentRequest += 1;
    this.folder = folder;
    this.item = path;
    this.document = { status: "ready", path, text: "", modified: entry.modified };
    this.saveStatus = session.status;
    this.editorFocusRequest += 1;
  }

  #ready(path: string, text: string): DocumentState {
    return { status: "ready", path, text, modified: this.#index.get(path)?.modified ?? 0 };
  }

  #toast(message: string): void {
    this.#toastId += 1;
    this.toasts = [...this.toasts, { id: this.#toastId, message }];
  }

  /** Flushes the open note before another one is shown. */
  #leave(next: string): void {
    const session = this.#sessions.get(this.item);
    if (!session || this.item === next) return;
    void session.flush().then(() => this.#retire(session));
  }

  /** Drops a session that is not shown and has nothing left to save. */
  #retire(session: SaveSession): void {
    if (session.path === this.item || this.#sessions.get(session.path) !== session) return;
    if (!session.idle || session.dirty) return;
    session.dispose();
    this.#sessions.delete(session.path);
  }

  /**
   * Saves and drops every session of the current workspace. Resolves when
   * they are done, or returns `null` right away when nothing is pending.
   */
  #closeSessions(): Promise<void> | null {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.saveStatus = null;
    if (sessions.length === 0 && this.#pendingCloses === 0) return null;
    const io = this.#io;
    this.#io = { open: true };
    const previous = this.#closing;
    this.#pendingCloses += 1;
    for (const session of sessions) this.#closingSessions.add(session);
    this.#closing = (async () => {
      await previous;
      await this.#withTimeout(Promise.all(sessions.map((session) => session.flush())));
      // Edits still unsaved now were refused once and then given up.
      io.open = false;
      for (const session of sessions) {
        session.dispose();
        this.#closingSessions.delete(session);
      }
      this.#pendingCloses -= 1;
    })();
    return this.#closing;
  }

  #watchClose(): void {
    if (this.#stopCloseHandler) return;
    this.#storage
      .onCloseRequested(() => this.#confirmClose())
      .then((stop) => {
        if (this.#disposed) stop();
        else this.#stopCloseHandler = stop;
      })
      // Without the hook the window closes normally; edits are still saved on blur.
      .catch(() => undefined);
  }

  /** Saves before the window closes; keeps it open once if something could not be saved. */
  async #confirmClose(): Promise<boolean> {
    // Saves of a previous workspace count as well.
    await this.#withTimeout(Promise.all([this.flush(), this.#closing]));
    const unsaved = this.#unsaved([...this.#sessions.values(), ...this.#closingSessions]);
    return this.#allow("close", unsaved, UNSAVED_ON_CLOSE);
  }

  /** Paths of sessions that still have edits to save. */
  #unsaved(sessions: Iterable<SaveSession>): string[] {
    const paths: string[] = [];
    for (const session of sessions) {
      if ((!session.idle || session.dirty) && !paths.includes(session.path))
        paths.push(session.path);
    }
    return paths;
  }

  /**
   * Whether `action` may go ahead with `unsaved` edits. It is refused with
   * `message`, unless the same action was refused just before.
   */
  #allow(action: UnsafeAction, unsaved: readonly string[], message: string): boolean {
    if (unsaved.length === 0 || this.#refused === action) {
      this.#refused = null;
      return true;
    }
    this.#refused = action;
    this.#toast(message);
    return false;
  }

  /** Waits for `work`, but never longer than the close timeout. */
  async #withTimeout(work: Promise<unknown>): Promise<void> {
    let timer: unknown = null;
    const timeout = new Promise<void>((resolve) => {
      timer = this.#timers.setTimeout(resolve, this.#closeTimeout);
    });
    await Promise.race([work, timeout]);
    this.#timers.clearTimeout(timer);
  }

  /** Storage access for sessions, refused once their workspace is closed. */
  #documentIO(): DocumentIO {
    const io = this.#io;
    const storage = this.#storage;
    return {
      async read(path): Promise<ReadOutcome> {
        if (!io.open) return { kind: "error", message: WORKSPACE_CLOSED };
        try {
          const file = await storage.readFile(path);
          return { kind: "ok", contents: file.contents, hash: file.hash };
        } catch (error) {
          const storageError = toStorageError(error);
          if (storageError.kind === "NotFound") return { kind: "missing" };
          return { kind: "error", message: storageError.message };
        }
      },
      async write(path, contents, expectedHash): Promise<WriteOutcome> {
        if (!io.open) return { kind: "error", message: WORKSPACE_CLOSED };
        try {
          const written = await storage.writeFile(path, contents, { expectedHash });
          return { kind: "ok", hash: written.hash };
        } catch (error) {
          const storageError = toStorageError(error);
          if (storageError.kind === "Conflict") return { kind: "conflict" };
          return { kind: "error", message: storageError.message };
        }
      },
    };
  }

  #createSession(path: string, file: FileContents, modified: number): SaveSession {
    const session: SaveSession = new SaveSession({
      path,
      contents: file.contents,
      hash: file.hash,
      savedAt: modified,
      io: this.#documentIO(),
      timers: this.#timers,
      ...(this.#saveDelay === undefined ? {} : { saveDelay: this.#saveDelay }),
      events: {
        status: (status) => {
          if (this.#sessions.get(path) !== session) return;
          if (path === this.item) this.saveStatus = status;
          else if (status.kind === "saved")
            void session.settled().then(() => this.#retire(session));
        },
        saved: (contents) => {
          this.#refused = null;
          this.#updateSummary(path, contents);
        },
        reloaded: (contents) => {
          this.#updateSummary(path, contents);
          if (path === this.item && this.#sessions.get(path) === session) {
            this.document = this.#ready(path, contents);
          }
        },
        removed: () => {
          if (this.#sessions.get(path) !== session) return;
          session.dispose();
          this.#sessions.delete(path);
          if (path === this.item) {
            this.document = { status: "missing", path };
            this.saveStatus = null;
          }
        },
        conflict: (copyPath) => this.#toast(conflictMessage(copyPath)),
      },
    });
    return session;
  }

  #updateSummary(path: string, contents: string): void {
    if (!this.#index.has(path)) return;
    this.#store.set(path, summarizeFile(path, contents));
    this.#schedulePublish();
  }

  #firstItem(folder: string): string | null {
    return listItems(this.workspace, folder, this.summaries)[0]?.id ?? null;
  }

  /** A missing file means defaults; an unreadable one adds a warning instead of failing. */
  async #readWorkspaceConfig(): Promise<LoadedConfig> {
    let text: string | null = null;
    const warnings: ConfigWarning[] = [];
    try {
      text = (await this.#storage.readFile(WORKSPACE_CONFIG_PATH)).contents;
    } catch (error) {
      if (!isStorageError(error, "NotFound")) {
        const message = `${WORKSPACE_CONFIG_PATH}: ${toStorageError(error).message}`;
        warnings.push({ field: "", message });
      }
    }
    const parsed = parseWorkspaceConfig(text);
    return { config: parsed.value, warnings: [...warnings, ...parsed.warnings] };
  }

  #applyConfig(loaded: LoadedConfig): void {
    this.#config = loaded.config;
    this.warnings = [...this.#settingsWarnings, ...loaded.warnings];
  }

  #rememberWorkspace(root: string): void {
    const settings = this.#settings;
    if (settings.value.workspace === root) return;
    if (!settings.writable) {
      if (this.#settingsWarnings.some((warning) => warning.message === SETTINGS_NOT_SAVED)) return;
      const warning = { field: "", message: SETTINGS_NOT_SAVED };
      this.#settingsWarnings = [...this.#settingsWarnings, warning];
      this.warnings = [...this.warnings, warning];
      return;
    }
    const value: DeviceSettings = { ...settings.value, workspace: root };
    this.#settings = { ...settings, value };
    // Saving settings must never hold up the UI.
    this.#storage.writeSettings(serializeSettings(value, settings)).catch((error) => {
      const message = `settings.json: ${toStorageError(error).message}`;
      this.warnings = [...this.warnings, { field: "", message }];
    });
  }

  async #loadDocument(path: string, generation: number): Promise<void> {
    const request = ++this.#documentRequest;
    if (this.document?.path !== path) this.document = { status: "loading", path };
    const current = () =>
      generation === this.#generation && request === this.#documentRequest && this.item === path;
    try {
      const file = await this.#storage.readFile(path);
      if (!current()) return;
      const modified = this.#index.get(path)?.modified ?? 0;
      const session = this.#createSession(path, file, modified);
      this.#sessions.set(path, session);
      this.document = { status: "ready", path, text: file.contents, modified };
      this.saveStatus = session.status;
      this.#store.set(path, summarizeFile(path, file.contents));
      this.#schedulePublish();
    } catch (error) {
      if (!current()) return;
      if (isStorageError(error, "NotFound")) this.document = { status: "missing", path };
      else if (isStorageError(error, "TooLarge")) this.document = { status: "too-large", path };
      else this.document = { status: "error", path, message: toStorageError(error).message };
    }
  }

  /** Task lists first (they drive the sidebar counts), then the selected project. */
  #rank = (path: string): number => {
    if (isTaskListPath(path)) return 0;
    return path.startsWith(`${this.folder}/`) ? 1 : 2;
  };

  /** Queues summary reads; a single background loop works through them. */
  #enqueue(paths: Iterable<string>, generation: number): void {
    if (generation !== this.#generation) return;
    this.#queue.add(paths, this.#rank);
    if (this.#pumping || this.#queue.size === 0) return;
    this.#pumping = true;
    this.#pump = this.#drainQueue(generation);
  }

  async #drainQueue(generation: number): Promise<void> {
    try {
      while (generation === this.#generation) {
        const batch = this.#queue.take(this.#concurrency);
        if (batch.length === 0) break;
        await Promise.all(batch.map((path) => this.#summarize(path, generation)));
      }
    } finally {
      if (generation === this.#generation) this.#pumping = false;
    }
  }

  async #summarize(path: string, generation: number): Promise<void> {
    const entry = this.#index.get(path);
    if (!entry) return;
    // The open note's read also produces its summary.
    const doc = this.document;
    if (path === this.item && doc?.path === path && doc.status !== "error") return;
    if (entry.size > MAX_SUMMARY_BYTES) {
      this.#store.set(path, fallbackSummary(path));
      this.#schedulePublish();
      return;
    }
    let text: string;
    try {
      text = (await this.#storage.readFile(path)).contents;
    } catch {
      // Unreadable files keep their fallback title; a later change retries them.
      return;
    }
    if (generation !== this.#generation || !this.#index.has(path)) return;
    this.#store.set(path, summarizeFile(path, text));
    this.#schedulePublish();
  }

  #schedulePublish(): void {
    if (this.#publishPending) return;
    this.#publishPending = true;
    this.#schedule(() => this.#publish());
  }

  #publish(): void {
    if (!this.#publishPending) return;
    this.#publishPending = false;
    this.summaries = this.#store.view();
  }

  #onChange(event: ChangeEvent, generation: number): void {
    this.#changes = this.#changes.then(() => this.#applyChange(event, generation));
  }

  async #applyChange(event: ChangeEvent, generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    if (event.rescan || this.#needsRescan) {
      await this.#rescan(generation);
      return;
    }
    const configChanged = event.paths.includes(WORKSPACE_CONFIG_PATH);
    const result = applyChange(this.#files, event);
    // Size and time can stay the same after an edit; for the open note
    // any notification is checked against its contents.
    const openTouched = this.item !== "" && event.entries.some((entry) => entry.path === this.item);
    const nothing = result.updated.length === 0 && result.removed.length === 0;
    if (!configChanged && !openTouched && nothing) return;
    if (configChanged) {
      const config = await this.#readWorkspaceConfig();
      if (generation !== this.#generation) return;
      this.#applyConfig(config);
    }
    this.#replaceFiles(result.files, result.updated, result.removed, openTouched, generation);
  }

  /** Lists the workspace again. On failure the model stays as it was and a notice is shown. */
  async #rescan(generation: number): Promise<void> {
    let config: LoadedConfig;
    let files: FileEntry[];
    try {
      [config, files] = await Promise.all([this.#readWorkspaceConfig(), this.#storage.listFiles()]);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#needsRescan = true;
      this.notice = refreshErrorMessage(error);
      return;
    }
    if (generation !== this.#generation) return;
    this.#needsRescan = false;
    this.notice = null;
    this.#applyConfig(config);
    const diff = diffFiles(this.#files, files);
    // A rescan cannot tell whether the open note changed; re-read it.
    this.#replaceFiles(files, [...diff.added, ...diff.changed], diff.removed, true, generation);
  }

  /** Rebuilds the model from a new listing and refreshes what depends on it. */
  #replaceFiles(
    files: FileEntry[],
    updated: string[],
    removed: string[],
    reloadOpen: boolean,
    generation: number,
  ): void {
    this.#files = files;
    this.workspace = buildWorkspace(files, this.#config);
    const shown = this.#index;

    // Forget files that are gone or now ignored.
    if (this.#store.retain((path) => shown.has(path))) this.#schedulePublish();

    if (this.folder !== ALL_TASKS && !findProject(this.workspace, this.folder)) {
      this.#select(INBOX);
    } else if (this.item === "") {
      if (this.#firstItem(this.folder) !== null) this.#select(this.folder);
    } else if (removed.includes(this.item)) {
      // A session decides: unsaved edits re-create the file.
      const session = this.#sessions.get(this.item);
      if (session) void session.externalChange();
      else this.document = { status: "missing", path: this.item };
    } else if (!shown.has(this.item)) {
      // Hidden by a new ignore pattern.
      this.#select(this.folder);
    } else if (reloadOpen || updated.includes(this.item)) {
      const session = this.#sessions.get(this.item);
      if (session) void session.externalChange();
      else void this.#loadDocument(this.item, generation);
    }

    // Notes still being saved in the background.
    for (const [path, session] of this.#sessions) {
      if (path === this.item) continue;
      if (reloadOpen || updated.includes(path) || removed.includes(path)) {
        void session.externalChange();
      }
    }

    this.#enqueue(pathsToSummarize(shown.keys(), updated, this.#store.view()), generation);
  }
}
