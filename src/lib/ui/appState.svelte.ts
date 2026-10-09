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
 *
 * Renaming and deleting notes run in the same queue as change events, after
 * the note's pending edits are saved. The model is updated right away, so
 * the watcher's later report of the app's own change is a no-op.
 *
 * Task lists are also kept parsed in a task index, read in the background
 * with the summaries and kept current from change events and the app's own
 * edits. Task edits (toggle, add, edit, delete, move) change the list's
 * text right away and are saved through the list's session like editor
 * edits: the open list's session, or one created on demand from the index
 * for the All tasks view, dropped again once everything is on disk.
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
import { nextAfterRemoval, renamedPath, validateNoteName } from "$lib/core/noteNames";
import { projectTasksPath, validateProjectName } from "$lib/core/projectNames";
import { linkedNote, noteLink, noteNameFromTask, textWithoutLinks } from "$lib/core/taskLinks";
import * as taskOps from "$lib/core/taskDocument";
import type {
  InsertPosition,
  RemovedLines,
  TaskDocument,
  TaskEdit,
  TaskRef,
} from "$lib/core/taskDocument";
import { NO_TASK_DOCS, TaskIndex, type TaskDocs } from "$lib/core/taskIndex";
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
  StorageError,
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
  /** Label of the toast's action button, e.g. `Undo`. */
  action?: string;
}

export type ProjectOutcome =
  | { kind: "created"; name: string }
  /** The name cannot be used; the reason is shown next to it. */
  | { kind: "invalid"; reason: string }
  /** Creating failed for another reason, already reported in a toast. */
  | { kind: "failed" };

/** Asks the task views to focus a task (by line) or, with `line: null`, the new task input. */
export interface TaskFocusRequest {
  id: number;
  path: string;
  line: number | null;
}

export type RenameOutcome =
  | { kind: "renamed"; path: string }
  /** The name cannot be used; the reason is shown next to it. */
  | { kind: "invalid"; reason: string }
  /** Renaming failed for another reason, already reported in a toast. */
  | { kind: "failed" };

/** Tells the editor that cached state moved to another path or must be dropped. */
export type EditorPathChange =
  { kind: "rename"; from: string; to: string } | { kind: "forget"; path: string };

interface DeletedNote {
  path: string;
  /** What the note contained, including edits that could not be saved. */
  contents: string;
  generation: number;
}

interface DeletedTask {
  path: string;
  removed: RemovedLines;
  generation: number;
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

export function nameTakenMessage(name: string): string {
  return `A note named ${name} already exists.`;
}

export const NAME_IGNORED = "Notes with this name are hidden by the workspace ignore patterns.";
export const NOTE_GONE = "This note no longer exists.";

export function renameFailedMessage(name: string, message: string): string {
  return `${name} could not be renamed: ${message}`;
}

export function deletedMessage(name: string): string {
  return `Deleted ${name}`;
}

export function deleteConflictMessage(name: string): string {
  return `${name} changed on disk and was not deleted.`;
}

export function deleteFailedMessage(name: string, message: string): string {
  return `${name} could not be deleted: ${message}`;
}

export function restoreTakenMessage(name: string): string {
  return `${name} already exists, so the deleted note was not restored.`;
}

export function restoreFailedMessage(name: string, message: string): string {
  return `${name} could not be restored: ${message}`;
}

export function taskDeletedMessage(text: string): string {
  return text === "" ? "Deleted a task" : `Deleted task: ${text}`;
}

export const TASK_CHANGED = "The task changed on disk, so nothing was changed.";

export function oversizedTasksMessage(paths: readonly string[]): string {
  return `Not shown here (larger than 1 MiB): ${paths.join(", ")}`;
}

export const SPACED_NAME = "Names cannot start or end with a space.";

export function notLinkedMessage(name: string): string {
  return `Created ${name}; the task changed, so it was not linked.`;
}

export function missingNoteMessage(name: string): string {
  return `${name} does not exist.`;
}

export const NOTE_NOT_SHOWN = "this path is not shown as a note in the workspace.";

export const TASK_NOT_RESTORED =
  "The task list is no longer available, so the task was not restored.";

export const PROJECT_IGNORED =
  "Projects with this name are hidden by the workspace ignore patterns.";

export function projectExistsMessage(name: string): string {
  return `A project named ${name} already exists.`;
}

export function createProjectFailedMessage(message: string): string {
  return `The project could not be created: ${message}`;
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
  /** Renamed and deleted notes, in order, so the editor can move or drop their state. */
  editorChanges: readonly EditorPathChange[] = $state.raw([]);
  /** Parsed task lists by path, including edits not saved yet. */
  taskDocs: TaskDocs = $state.raw(NO_TASK_DOCS);
  /** The selected task list is shown in the text editor instead of the task view. */
  taskTextMode: boolean = $state(false);
  /** Task lists (and `ALL_TASKS`) whose done tasks are hidden. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced, never mutated
  hideDone: ReadonlySet<string> = $state.raw(new Set());
  /** The latest request for the task views to move focus, or `null`. */
  taskFocus: TaskFocusRequest | null = $state.raw(null);

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
  /** Deleted notes that an undo toast can restore, by toast id. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  readonly #deleted = new Map<number, DeletedNote>();
  /** Deleted tasks that an undo toast can restore, by toast id. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  readonly #deletedTasks = new Map<number, DeletedTask>();
  /** Other toast actions, by toast id. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  readonly #toastActions = new Map<number, () => Promise<void>>();
  /** Tasks a note is being created from, by path and line text. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  readonly #creatingFromTask = new Set<string>();
  readonly #tasks = new TaskIndex();
  /** Edits made through task list sessions created on demand, to apply again after a conflict. */
  readonly #taskEdits = new WeakMap<SaveSession, ((doc: TaskDocument) => TaskEdit | null)[]>();
  #tasksChanged = false;
  #taskFocusId = 0;
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
    this.#dropUndo();
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
      this.#tasks.clear();
      this.#tasksChanged = false;
      this.taskDocs = this.#tasks.view();
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced, never mutated
      this.hideDone = new Set();
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
    this.taskTextMode = false;
    // A pending focus request belongs to what was shown before.
    this.taskFocus = null;
    if (path === ALL_TASKS) {
      // The All tasks view reads the task index; there is no document.
      this.#documentRequest += 1;
      this.document = null;
      this.saveStatus = null;
      return;
    }
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
      this.#openCreated(written, "", folder);
      this.editorFocusRequest += 1;
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

  /**
   * Renames a note within its folder to the name the user typed. Pending
   * edits are saved first; an open note keeps its buffer, undo history and
   * selection under the new path.
   */
  async renameNote(path: string, input: string): Promise<RenameOutcome> {
    if (this.phase.kind !== "ready") return { kind: "failed" };
    // An unchanged name is no rename, even one this app would not accept.
    const typed = input.trim();
    const current = baseName(path);
    if (typed === current || `${typed}.md` === current) return { kind: "renamed", path };
    const validation = validateNoteName(input);
    if (!validation.ok) return { kind: "invalid", reason: validation.reason };
    const name = validation.name;
    const to = renamedPath(path, name);
    const generation = this.#generation;
    return this.#serial(async (): Promise<RenameOutcome> => {
      if (generation !== this.#generation) return { kind: "failed" };
      if (!this.#isNote(path)) return { kind: "invalid", reason: NOTE_GONE };
      if (this.#nameTaken(path, to)) return { kind: "invalid", reason: nameTakenMessage(name) };
      if (classifyPath(to, createPathFilter(this.#config)) === null)
        return { kind: "invalid", reason: NAME_IGNORED };

      const session = this.#sessions.get(path);
      try {
        if (session) {
          await session.exclusive(async () => {
            const written = await this.#storage.renameFile(path, to);
            session.moveTo(written.path, written.hash);
            // Moved before the session's next step, which reports under the new path.
            if (generation === this.#generation) this.#applyRename(path, written, session);
          });
        } else {
          const written = await this.#storage.renameFile(path, to);
          if (generation === this.#generation) this.#applyRename(path, written, null);
        }
      } catch (error) {
        if (generation !== this.#generation) return { kind: "failed" };
        const storageError = toStorageError(error);
        if (storageError.kind === "Conflict") {
          return { kind: "invalid", reason: nameTakenMessage(name) };
        }
        this.#toast(renameFailedMessage(baseName(path), storageError.message));
        return { kind: "failed" };
      }
      if (generation !== this.#generation) return { kind: "failed" };
      return { kind: "renamed", path: to };
    });
  }

  /**
   * Deletes a note after saving its pending edits, selects the next item and
   * shows a toast that can undo it. Failures show a toast and change nothing.
   */
  async deleteNote(path: string): Promise<void> {
    if (this.phase.kind !== "ready") return;
    const generation = this.#generation;
    await this.#serial(async () => {
      if (generation !== this.#generation || !this.#isNote(path)) return;
      const name = baseName(path);
      const session = this.#sessions.get(path);
      let contents: string;
      try {
        if (session) {
          contents = await session.exclusive(async () => {
            const hash = session.hash;
            if (hash === null) throw new StorageError("NotFound", `${path} does not exist.`);
            await this.#storage.deleteFile(path, hash);
            // The latest buffer, including edits that could not be saved.
            return session.text;
          });
        } else {
          const file = await this.#storage.readFile(path);
          await this.#storage.deleteFile(path, file.hash);
          contents = file.contents;
        }
      } catch (error) {
        if (generation !== this.#generation) return;
        const storageError = toStorageError(error);
        if (storageError.kind === "Conflict") {
          this.#toast(deleteConflictMessage(name));
          // Show what is on disk now.
          void session?.externalChange();
        } else {
          this.#toast(deleteFailedMessage(name, storageError.message));
        }
        return;
      }
      if (generation !== this.#generation) return;
      this.#applyDelete(path, session ?? null);
      const id = this.#toast(deletedMessage(name), "Undo");
      this.#deleted.set(id, { path, contents, generation });
    });
  }

  /**
   * Restores the note deleted with toast `id`, without replacing a file that
   * took its name meanwhile, and selects it.
   */
  async undoDelete(id: number): Promise<"note" | "task" | null> {
    const task = this.#deletedTasks.get(id);
    if (task) {
      this.dismissToast(id);
      if (task.generation !== this.#generation) return null;
      const edit = this.#editTasks(task.path, null, (doc) =>
        taskOps.restoreLines(doc, task.removed),
      );
      if (edit) this.#requestTaskFocus(task.path, edit.focus);
      else this.#toast(TASK_NOT_RESTORED);
      return "task";
    }
    const deleted = this.#deleted.get(id);
    if (!deleted) return null;
    this.dismissToast(id);
    await this.#serial(async () => {
      if (deleted.generation !== this.#generation) return;
      const name = baseName(deleted.path);
      let written: WrittenFile;
      try {
        written = await this.#storage.writeFile(deleted.path, deleted.contents, {
          expectedHash: null,
        });
      } catch (error) {
        if (deleted.generation !== this.#generation) return;
        const storageError = toStorageError(error);
        this.#toast(
          storageError.kind === "Conflict"
            ? restoreTakenMessage(name)
            : restoreFailedMessage(name, storageError.message),
        );
        return;
      }
      if (deleted.generation !== this.#generation) return;
      const role = classifyPath(deleted.path, createPathFilter(this.#config));
      // A note hidden by the ignore patterns meanwhile is restored but not shown.
      if (role?.kind !== "note" || role.archived) return;
      this.#openCreated(written, deleted.contents, role.project);
    });
    return "note";
  }

  /** The toast of the most recent delete that can still be undone, or `null`. */
  get latestUndo(): number | null {
    let latest: number | null = null;
    for (const id of [...this.#deleted.keys(), ...this.#deletedTasks.keys()])
      latest = latest === null ? id : Math.max(latest, id);
    return latest;
  }

  /*
   * Task edits address a task by `TaskRef` (its line and the line's text as
   * shown). If the list changed meanwhile and the task cannot be found by
   * its text, nothing changes and a toast says so.
   */

  /** Flips the done state of a task of the list `path`. */
  toggleTask(path: string, ref: TaskRef): void {
    this.#editTasks(path, ref, (doc) => taskOps.toggleTask(doc, ref));
  }

  /** Adds an open task; resolves to a reference to it, or `null` if nothing was added. */
  addTask(path: string, text: string, position: InsertPosition): TaskRef | null {
    const ref = typeof position === "object" && "after" in position ? position.after : null;
    const edit = this.#editTasks(path, ref, (doc) => taskOps.insertTask(doc, text, position));
    if (edit?.focus == null) return null;
    return taskOps.refAt(taskOps.parseTaskDocument(edit.text), edit.focus);
  }

  /** Replaces the detail of a top-level task (its non-task indented lines). */
  setTaskDetail(path: string, ref: TaskRef, detail: string): void {
    this.#editTasks(path, ref, (doc) => taskOps.setTaskDetail(doc, ref, detail));
  }

  /** Replaces the text of a task. Empty text changes nothing. */
  editTask(path: string, ref: TaskRef, text: string): void {
    this.#editTasks(path, ref, (doc) => taskOps.editTaskText(doc, ref, text));
  }

  /**
   * Moves an open task above the previous (`-1`) or below the next (`1`)
   * open task of its section; resolves to its new line.
   */
  moveTask(path: string, ref: TaskRef, direction: -1 | 1): number | null {
    return (
      this.#editTasks(path, ref, (doc) => taskOps.moveTask(doc, ref, direction))?.focus ?? null
    );
  }

  /**
   * Deletes a task with its subtasks and shows a toast that can undo it.
   * Resolves to the line of the task that takes its place.
   */
  deleteTask(path: string, ref: TaskRef): number | null {
    let removed: RemovedLines | null = null;
    let text = "";
    const edit = this.#editTasks(path, ref, (doc) => {
      const line = taskOps.locateTask(doc, ref);
      text = line === null ? "" : (taskOps.taskAt(doc, line)?.text ?? "");
      const deletion = taskOps.deleteTask(doc, ref);
      removed = deletion?.removed ?? null;
      return deletion;
    });
    if (!edit || removed === null) return null;
    const id = this.#toast(taskDeletedMessage(text), "Undo");
    this.#deletedTasks.set(id, { path, removed, generation: this.#generation });
    return edit.focus;
  }

  /** Hides or shows the done tasks of a list, or of All tasks with `ALL_TASKS`. */
  toggleHideDone(key: string): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced, never mutated
    const next = new Set(this.hideDone);
    if (!next.delete(key)) next.add(key);
    this.hideDone = next;
  }

  /** Whether `path` is a note shown in the workspace. */
  hasNote(path: string): boolean {
    return this.#isNote(path);
  }

  /** Selects a note in its project and moves focus into the editor. */
  openNote(path: string): void {
    const role = classifyPath(path, createPathFilter(this.#config));
    if (role?.kind !== "note" || role.archived || !this.#isNote(path)) return;
    this.folder = role.project;
    this.selectItem(path);
    this.editorFocusRequest += 1;
  }

  /**
   * Opens the note a task links to. A link to a note that does not exist
   * shows a toast offering to create it. Nothing happens without a link.
   */
  openTaskNote(path: string, ref: TaskRef): void {
    const doc = this.#currentTasks(path);
    const line = doc ? taskOps.locateTask(doc, ref) : null;
    const task = doc && line !== null ? taskOps.taskAt(doc, line) : null;
    if (!task) {
      if (doc) this.#toast(TASK_CHANGED);
      return;
    }
    const link = linkedNote(task.text, path, (candidate) => this.#isNote(candidate));
    if (!link) return;
    if (link.exists) {
      this.openNote(link.path);
      return;
    }
    const id = this.#toast(missingNoteMessage(baseName(link.path)), "Create");
    const title = textWithoutLinks(task.text);
    const generation = this.#generation;
    this.#toastActions.set(id, () => this.#createLinkedNote(link.path, title, generation));
  }

  /**
   * Creates a note named after a task in the task's project folder, with
   * the task text as its title, links it from the task and opens it.
   */
  async createNoteFromTask(path: string, ref: TaskRef): Promise<void> {
    if (this.phase.kind !== "ready") return;
    // One note per task at a time, e.g. when the menu item is chosen twice quickly.
    const key = `${path}\n${ref.raw}`;
    if (this.#creatingFromTask.has(key)) return;
    this.#creatingFromTask.add(key);
    try {
      await this.#createNoteFromTask(path, ref);
    } finally {
      this.#creatingFromTask.delete(key);
    }
  }

  async #createNoteFromTask(path: string, ref: TaskRef): Promise<void> {
    const doc = this.#currentTasks(path);
    const line = doc ? taskOps.locateTask(doc, ref) : null;
    const task = doc && line !== null ? taskOps.taskAt(doc, line) : null;
    if (!task) {
      this.#toast(TASK_CHANGED);
      return;
    }
    const folder = path.slice(0, path.lastIndexOf("/"));
    const stem = noteNameFromTask(task.text);
    const contents = `# ${textWithoutLinks(task.text) || stem}\n`;
    const generation = this.#generation;
    const isIgnored = createPathFilter(this.#config);
    const tried: string[] = [];
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local to this call, never rendered
      const taken = new Set(this.#files.map((file) => file.path.toLowerCase()));
      const candidate = newNotePath(
        folder,
        (candidatePath) => {
          const key = candidatePath.toLowerCase();
          return (
            taken.has(key) || tried.includes(key) || classifyPath(candidatePath, isIgnored) === null
          );
        },
        undefined,
        stem,
      );
      if (candidate === null) break;
      let written: WrittenFile;
      try {
        written = await this.#storage.writeFile(candidate, contents, { expectedHash: null });
      } catch (error) {
        if (generation !== this.#generation) return;
        const storageError = toStorageError(error);
        if (storageError.kind === "Conflict") {
          tried.push(candidate.toLowerCase());
          continue;
        }
        this.#toast(createNoteFailedMessage(storageError.message));
        return;
      }
      if (generation !== this.#generation) return;
      const suffix = noteLink(baseName(written.path));
      // Found by its text again: the list may have changed while the note was written.
      const linked = this.#editTasks(path, null, (current) => {
        const at = taskOps.locateTask(current, ref);
        const now = at === null ? null : taskOps.taskAt(current, at);
        return now ? taskOps.editTaskText(current, ref, `${now.text} ${suffix}`) : null;
      });
      if (!linked) this.#toast(notLinkedMessage(baseName(written.path)));
      this.#openCreated(written, contents, folder.split("/")[0] ?? INBOX);
      this.editorFocusRequest += 1;
      return;
    }
    if (generation === this.#generation) this.#toast(NO_FREE_NOTE_NAME);
  }

  /** Runs a toast's action button: undo a delete, or create a missing note. */
  async runToastAction(id: number): Promise<"note" | "task" | "create" | null> {
    const action = this.#toastActions.get(id);
    if (!action) return this.undoDelete(id);
    this.dismissToast(id);
    await action();
    return "create";
  }

  /**
   * Shows the selected task list in the text editor (`true`) or as the task
   * view. Both use the same session, so nothing is saved or read to switch.
   */
  setTaskTextMode(on: boolean): void {
    const path = this.item;
    if (!isTaskListPath(path) || on === this.taskTextMode) return;
    const session = this.#sessions.get(path);
    if (session && on) {
      // The task view's edits are in the buffer, not in the shown document.
      this.document = this.#ready(path, session.text);
    } else if (session) {
      this.#syncTasks(session);
      this.#publishTasks();
    }
    this.taskTextMode = on;
  }

  /**
   * Creates a project folder with an empty task list (create-only), then
   * selects it and asks the task view to focus its new task input.
   */
  async createProject(input: string): Promise<ProjectOutcome> {
    if (this.phase.kind !== "ready") return { kind: "failed" };
    const generation = this.#generation;
    return this.#serial(async (): Promise<ProjectOutcome> => {
      if (generation !== this.#generation) return { kind: "failed" };
      const validation = validateProjectName(
        input,
        this.workspace.projects.map((project) => project.name),
      );
      if (!validation.ok) return { kind: "invalid", reason: validation.reason };
      const name = validation.name;
      const path = projectTasksPath(name);
      if (classifyPath(path, createPathFilter(this.#config))?.kind !== "tasks")
        return { kind: "invalid", reason: PROJECT_IGNORED };
      let written: WrittenFile;
      try {
        written = await this.#storage.writeFile(path, "", { expectedHash: null });
      } catch (error) {
        if (generation !== this.#generation) return { kind: "failed" };
        const storageError = toStorageError(error);
        if (storageError.kind === "Conflict")
          return { kind: "invalid", reason: projectExistsMessage(name) };
        this.#toast(createProjectFailedMessage(storageError.message));
        return { kind: "failed" };
      }
      if (generation !== this.#generation) return { kind: "failed" };
      this.#openCreated(written, "", name);
      this.#tasks.set(path, "", written.hash);
      this.#publishTasks();
      this.#requestTaskFocus(path, null);
      return { kind: "created", name };
    });
  }

  /** Shows a short message. */
  notify(message: string): void {
    this.#toast(message);
  }

  dismissToast(id: number): void {
    this.#deleted.delete(id);
    this.#toastActions.delete(id);
    this.#deletedTasks.delete(id);
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
    this.taskTextMode = false;
    this.taskFocus = null;
    this.document = null;
    this.saveStatus = null;
    if (first !== null) this.selectItem(first);
  }

  /**
   * Adds a note this app just created to the model without waiting for the
   * watcher, and opens it with a session based on the creation write. The
   * watcher's later report carries the same metadata, so it changes nothing.
   */
  #openCreated(written: WrittenFile, contents: string, folder: string): void {
    const { hash, ...entry } = written;
    const path = entry.path;
    this.#files = [...this.#files.filter((file) => file.path !== path), entry];
    this.workspace = buildWorkspace(this.#files, this.#config);
    this.#store.set(path, summarizeFile(path, contents));
    this.#schedulePublish();

    this.#leave(path);
    // A session left from a note deleted at this path is replaced.
    this.#sessions.get(path)?.dispose();
    const session = this.#createSession(path, { contents, hash }, entry.modified);
    this.#sessions.set(path, session);
    // Drop reads still in flight for the previous selection.
    this.#documentRequest += 1;
    this.folder = folder;
    this.item = path;
    this.taskTextMode = false;
    this.document = { status: "ready", path, text: contents, modified: entry.modified };
    this.saveStatus = session.status;
  }

  /**
   * Applies a task edit to the current text of the list at `path` (its
   * session's buffer), records it in the session and shows it right away.
   */
  #editTasks(
    path: string,
    ref: TaskRef | null,
    edit: (doc: TaskDocument) => TaskEdit | null,
  ): TaskEdit | null {
    if (this.phase.kind !== "ready") return null;
    const session = this.#taskSession(path);
    if (!session) return null;
    const current = session.text;
    const indexed = this.#tasks.get(path)?.doc;
    const before = indexed?.text === current ? indexed : taskOps.parseTaskDocument(current);
    if (ref !== null && taskOps.locateTask(before, ref) === null) {
      this.#toast(TASK_CHANGED);
      return null;
    }
    const result = edit(before);
    if (!result) return null;
    const text = result.text;
    this.#refused = null;
    session.edit(() => text);
    this.#taskEdits.get(session)?.push(edit);
    const doc = this.#tasks.set(path, text, null);
    this.#store.set(path, summarizeFile(path, text, doc));
    // The text editor shows this list: hand it the new text like a change from disk.
    if (path === this.item && this.taskTextMode) this.document = this.#ready(path, text);
    this.#publishTasks();
    return result;
  }

  /**
   * The session of a shown task list: the existing one, or a new one based
   * on the index entry when it matches a known disk version.
   */
  #taskSession(path: string): SaveSession | null {
    if (!isTaskListPath(path) || !this.#index.has(path)) return null;
    const live = this.#sessions.get(path);
    if (live) return live;
    const indexed = this.#tasks.get(path);
    if (!indexed || indexed.hash === null) return null;
    const modified = this.#index.get(path)?.modified ?? 0;
    // Its base may be older than the disk: on a conflict the edits are
    // applied again to the newer version once, before keeping both.
    const edits: ((doc: TaskDocument) => TaskEdit | null)[] = [];
    const session = this.#createSession(
      path,
      { contents: indexed.doc.text, hash: indexed.hash },
      modified,
      (disk) => {
        let text = disk;
        for (const edit of edits) {
          const result = edit(taskOps.parseTaskDocument(text));
          if (!result) return null;
          text = result.text;
        }
        return text;
      },
    );
    this.#taskEdits.set(session, edits);
    this.#sessions.set(path, session);
    return session;
  }

  /** Puts a task list session's buffer into the index and the summaries. */
  #syncTasks(session: SaveSession): void {
    const path = session.path;
    if (!isTaskListPath(path) || !this.#index.has(path)) return;
    const text = session.text;
    const doc = this.#tasks.set(path, text, session.dirty ? null : session.hash);
    this.#store.set(path, summarizeFile(path, text, doc));
    this.#tasksChanged = true;
  }

  /** Publishes task lists and summaries now, for edits that must show at once. */
  #publishTasks(): void {
    this.#tasksChanged = true;
    this.#publishPending = true;
    this.#publish();
  }

  #requestTaskFocus(path: string, line: number | null): void {
    this.#taskFocusId += 1;
    this.taskFocus = { id: this.#taskFocusId, path, line };
  }

  /** Runs `task` in the change queue, so watcher reports wait until it is done. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#changes.then(task);
    this.#changes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A note shown in the workspace (not a task list). */
  #isNote(path: string): boolean {
    return this.#index.has(path) && !isTaskListPath(path);
  }

  /**
   * Whether `to` belongs to something other than `from`: a listed file, an
   * open note whose file is gone but whose edits are kept, or the selected
   * item shown as missing. Many file systems ignore case, so names are
   * compared that way and only a case-only rename may match.
   */
  #nameTaken(from: string, to: string): boolean {
    const key = to.toLowerCase();
    if (key === from.toLowerCase()) return false;
    const same = (path: string) => path.toLowerCase() === key;
    return (
      this.#files.some((file) => same(file.path)) ||
      [...this.#sessions.keys()].some(same) ||
      same(this.item)
    );
  }

  /** Moves a renamed note in the model, its summary, session and selection. */
  #applyRename(from: string, written: WrittenFile, session: SaveSession | null): void {
    const entry: FileEntry = {
      path: written.path,
      size: written.size,
      modified: written.modified,
    };
    const to = entry.path;
    const summary = this.#store.view().get(from);
    this.#files = [...this.#files.filter((file) => file.path !== from && file.path !== to), entry];
    this.workspace = buildWorkspace(this.#files, this.#config);
    this.#store.retain((path) => path !== from);
    if (session) {
      this.#store.set(to, summarizeFile(to, session.text));
    } else {
      // A title taken from the file name changes; read it again.
      if (summary) this.#store.set(to, summary);
      this.#enqueue([to], this.#generation);
    }
    this.#schedulePublish();

    if (session) {
      if (this.#sessions.get(from) === session) this.#sessions.delete(from);
      const stale = this.#sessions.get(to);
      if (stale !== session) stale?.dispose();
      this.#sessions.set(to, session);
    }
    this.editorChanges = [...this.editorChanges, { kind: "rename", from, to }];

    if (this.item !== from) return;
    this.item = to;
    const doc = this.document;
    if (doc?.path !== from) return;
    if (session && doc.status === "ready") {
      // The buffer, so the editor sees no change and keeps its history.
      this.document = { status: "ready", path: to, text: session.text, modified: entry.modified };
    } else if (doc.status === "loading") {
      void this.#loadDocument(to, this.#generation);
    } else {
      this.document = { ...doc, path: to };
    }
  }

  /** Removes a deleted note from the model and selects the next item if it was selected. */
  #applyDelete(path: string, session: SaveSession | null): void {
    const ids = listItems(this.workspace, this.folder, this.summaries).map((item) => item.id);
    const next = this.item === path ? nextAfterRemoval(ids, path) : null;
    this.#files = this.#files.filter((file) => file.path !== path);
    this.workspace = buildWorkspace(this.#files, this.#config);
    if (this.#store.retain((other) => other !== path)) this.#schedulePublish();
    if (session) {
      session.dispose();
      if (this.#sessions.get(path) === session) this.#sessions.delete(path);
    }
    this.editorChanges = [...this.editorChanges, { kind: "forget", path }];
    if (this.item !== path) return;
    this.#documentRequest += 1;
    this.item = "";
    this.document = null;
    this.saveStatus = null;
    if (next !== null) this.selectItem(next);
  }

  /** Undo toasts belong to the workspace they were shown in. */
  #dropUndo(): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local to this call, never rendered
    const ids = new Set([
      ...this.#deleted.keys(),
      ...this.#deletedTasks.keys(),
      ...this.#toastActions.keys(),
    ]);
    if (ids.size === 0) return;
    this.#deleted.clear();
    this.#deletedTasks.clear();
    this.#toastActions.clear();
    this.toasts = this.toasts.filter((toast) => !ids.has(toast.id));
  }

  /** The current text of a task list (its session's buffer when it has one), parsed. */
  #currentTasks(path: string): TaskDocument | null {
    const session = this.#sessions.get(path);
    const indexed = this.#tasks.get(path)?.doc ?? null;
    if (!session) return indexed;
    const text = session.text;
    return indexed?.text === text ? indexed : taskOps.parseTaskDocument(text);
  }

  /** Creates a note a task links to but that does not exist, then opens it. */
  async #createLinkedNote(path: string, title: string, generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    // A hand-written link may name a file the app would not create.
    const name = validateNoteName(baseName(path));
    if (!name.ok || name.name !== baseName(path)) {
      this.#toast(createNoteFailedMessage(name.ok ? SPACED_NAME : name.reason));
      return;
    }
    const role = classifyPath(path, createPathFilter(this.#config));
    if (role?.kind !== "note" || role.archived) {
      this.#toast(createNoteFailedMessage(NOTE_NOT_SHOWN));
      return;
    }
    const contents = title === "" ? "" : `# ${title}\n`;
    let written: WrittenFile;
    try {
      written = await this.#storage.writeFile(path, contents, { expectedHash: null });
    } catch (error) {
      if (generation !== this.#generation) return;
      const storageError = toStorageError(error);
      this.#toast(
        storageError.kind === "Conflict"
          ? nameTakenMessage(baseName(path))
          : createNoteFailedMessage(storageError.message),
      );
      return;
    }
    if (generation !== this.#generation) return;
    this.#openCreated(written, contents, role.project);
    this.editorFocusRequest += 1;
  }

  #ready(path: string, text: string): DocumentState {
    return { status: "ready", path, text, modified: this.#index.get(path)?.modified ?? 0 };
  }

  #toast(message: string, action?: string): number {
    this.#toastId += 1;
    const toast: Toast =
      action === undefined
        ? { id: this.#toastId, message }
        : { id: this.#toastId, message, action };
    this.toasts = [...this.toasts, toast];
    return this.#toastId;
  }

  /** Flushes the open note before another one is shown. */
  #leave(next: string): void {
    if (this.item === ALL_TASKS && next !== ALL_TASKS) {
      // Lists edited from All tasks are saved now and dropped once written.
      for (const session of [...this.#sessions.values()]) {
        if (session.path !== next) void session.flush().then(() => this.#retire(session));
      }
      return;
    }
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

  #createSession(
    path: string,
    file: FileContents,
    modified: number,
    rebase?: (disk: string) => string | null,
  ): SaveSession {
    const session: SaveSession = new SaveSession({
      path,
      contents: file.contents,
      hash: file.hash,
      savedAt: modified,
      io: this.#documentIO(),
      timers: this.#timers,
      ...(this.#saveDelay === undefined ? {} : { saveDelay: this.#saveDelay }),
      ...(rebase === undefined ? {} : { rebase }),
      events: {
        rebased: () => {
          this.#syncTasks(session);
          this.#publishTasks();
        },
        // A rename moves the session, so its current path is read each time.
        status: (status) => {
          if (this.#sessions.get(session.path) !== session) return;
          if (session.path === this.item) this.saveStatus = status;
          else if (status.kind === "saved")
            void session.settled().then(() => this.#retire(session));
        },
        saved: (contents) => {
          this.#refused = null;
          this.#updateSummary(session, contents);
        },
        reloaded: (contents) => {
          const current = session.path;
          this.#updateSummary(session, contents);
          if (current === this.item && this.#sessions.get(current) === session) {
            this.document = this.#ready(current, contents);
          }
        },
        removed: () => {
          const current = session.path;
          if (this.#sessions.get(current) !== session) return;
          session.dispose();
          this.#sessions.delete(current);
          if (current === this.item) {
            this.document = { status: "missing", path: current };
            this.saveStatus = null;
          }
        },
        conflict: (copyPath) => this.#toast(conflictMessage(copyPath)),
      },
    });
    return session;
  }

  #updateSummary(session: SaveSession, contents: string): void {
    const path = session.path;
    if (!this.#index.has(path)) return;
    // A task list shows its buffer, which may be ahead of what was saved.
    if (isTaskListPath(path)) this.#syncTasks(session);
    else this.#store.set(path, summarizeFile(path, contents));
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
      const live = this.#sessions.get(path);
      if (live) {
        // A task edit started a session meanwhile; its buffer is newer.
        this.document = this.#ready(path, live.text);
        this.saveStatus = live.status;
        return;
      }
      const modified = this.#index.get(path)?.modified ?? 0;
      const session = this.#createSession(path, file, modified);
      this.#sessions.set(path, session);
      this.document = { status: "ready", path, text: file.contents, modified };
      this.saveStatus = session.status;
      if (isTaskListPath(path)) {
        const doc = this.#tasks.set(path, file.contents, file.hash);
        this.#store.set(path, summarizeFile(path, file.contents, doc));
        this.#publishTasks();
      } else {
        this.#store.set(path, summarizeFile(path, file.contents));
        this.#schedulePublish();
      }
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
      // A list that grew too large is no longer kept parsed; All tasks says so.
      if (!this.#sessions.has(path) && this.#tasks.delete(path)) this.#tasksChanged = true;
      this.#schedulePublish();
      return;
    }
    let file: FileContents;
    try {
      file = await this.#storage.readFile(path);
    } catch {
      // Unreadable files keep their fallback title; a later change retries them.
      return;
    }
    if (generation !== this.#generation || !this.#index.has(path)) return;
    if (isTaskListPath(path)) {
      // A list with a session is kept current by it, edits included.
      if (this.#sessions.has(path)) return;
      const doc = this.#tasks.set(path, file.contents, file.hash);
      this.#store.set(path, summarizeFile(path, file.contents, doc));
      this.#tasksChanged = true;
    } else {
      this.#store.set(path, summarizeFile(path, file.contents));
    }
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
    if (this.#tasksChanged) {
      this.#tasksChanged = false;
      this.taskDocs = this.#tasks.view();
    }
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
    if (this.#tasks.retain((path) => shown.has(path))) {
      this.#tasksChanged = true;
      this.#schedulePublish();
    }

    if (this.folder !== ALL_TASKS && !findProject(this.workspace, this.folder)) {
      this.#select(INBOX);
    } else if (this.item === ALL_TASKS) {
      // The All tasks view follows the task index; there is no document to reload.
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
