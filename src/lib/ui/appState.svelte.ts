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
 *
 * The search index is fed from the same reads and edits: every note text
 * that becomes known (background reads, opened notes, saves) is indexed,
 * renames and deletes move or drop it, and task lists are indexed again
 * whenever the task index is published. Archived projects are left out.
 * Notes saved while typing are indexed when the app is idle, never on the
 * input path.
 *
 * Quick capture asks the main window to add a task or create a note; it is
 * written through the same sessions and model updates as edits made here,
 * without changing what is shown.
 *
 * Once a workspace is loaded, a `SyncScheduler` commits changes (the app's
 * own writes and changes reported by the watcher) and syncs with the
 * upstream in the background. It stops when another workspace opens or the
 * app closes, after pending saves are written; no sync starts while closing.
 *
 * Device settings are read on start and saved in the background whenever
 * the app changes one, as a patch of the changed field on top of the file
 * as last read; changes made to the file by another program are read again
 * and applied. New workspaces are created or cloned through
 * storage before they are opened like any other folder.
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
import { ChangeHints, commitMessage, listingLookup } from "$lib/core/commitMessage";
import type { CommitResult, SyncResult } from "$lib/core/git";
import { newNoteFolder, newNotePath } from "$lib/core/newNote";
import { nextAfterRemoval, renamedPath, validateNoteName } from "$lib/core/noteNames";
import { projectTasksPath, validateProjectName } from "$lib/core/projectNames";
import { linkedNote, noteLink, noteNameFromTask, textWithoutLinks } from "$lib/core/taskLinks";
import { retargetLinks } from "$lib/core/linkRetarget";
import { applyMove, isInside, movedPath, reverseMoves, type PathMove } from "$lib/core/pathMoves";
import { serializeTask } from "$lib/core/tasks";
import * as taskOps from "$lib/core/taskDocument";
import type {
  InsertPosition,
  RemovedLines,
  SourceLine,
  TaskDocument,
  TaskEdit,
  TaskRef,
} from "$lib/core/taskDocument";
import {
  SyncScheduler,
  type GitErrorKind,
  type GitOutcome,
  type SyncSchedulerOptions,
  type SyncSnapshot,
} from "$lib/core/syncScheduler";
import { conflictsKeptMessage } from "$lib/core/syncStatus";
import { NO_TASK_DOCS, TaskIndex, type TaskDocs } from "$lib/core/taskIndex";
import { SearchIndex, type SearchResult } from "$lib/core/searchIndex";
import { LruCache } from "$lib/core/lru";
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
  ARCHIVE_DIR,
  buildWorkspace,
  classifyPath,
  createPathFilter,
  diffFiles,
  findProject,
  findProjectByKey,
  INBOX,
  isArchivedKey,
  isTaskListPath,
  projectKey,
  projectKeyOf,
  projectNameOf,
  WORKSPACE_CONFIG_PATH,
  workspaceFiles,
  type ChangeEvent,
  type FileEntry,
  type Workspace,
} from "$lib/core/workspace";
import type { ConfigWarning, ParseResult } from "$lib/config/parse";
import {
  ALL_TASKS_KEY,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  effectiveSettings,
  hideDoneOf,
  isOpenedWorkspace,
  parseSettings,
  reloadSettings,
  serializeSettings,
  withDismissedSetup,
  withHideDone,
  withOpenedWorkspace,
  withoutRecentWorkspace,
  type DeviceSettings,
  type EffectiveSettings,
} from "$lib/config/settings";
import { sameAccelerator } from "$lib/core/accelerator";
import { folderNameProblem, joinPath } from "$lib/core/workspaceLocation";
import { parseWorkspaceConfig, type WorkspaceConfig } from "$lib/config/workspaceConfig";
import {
  isStorageError,
  StorageError,
  toStorageError,
  trackWrites,
  type CaptureHost,
  type CaptureKind,
  type CaptureProjects,
  type FileContents,
  type GitVersion,
  type ScaffoldResult,
  type ShortcutChange,
  type ShortcutStatus,
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

/** Asks the editor to show a line of a note, e.g. the first search match. */
export interface EditorRevealRequest {
  id: number;
  path: string;
  line: number;
}

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

/** What a toast button other than Undo does, with the file it is about. */
interface ToastAction {
  path: string;
  /** The file exists (it moves along with moves), or is still to be created. */
  exists: boolean;
  run: (path: string) => Promise<void>;
}

/** A move an undo toast can take back. */
type MoveUndo =
  /** A note now at `to`, which goes back to `from`. */
  | { kind: "note"; from: string; to: string; generation: number }
  /** A project folder now at `to`, which goes back to `from`. */
  | { kind: "folder"; from: string; to: string; generation: number }
  /** A task block moved from the list `source` to `target`, where it starts at `inserted`. */
  | {
      kind: "task";
      source: string;
      target: string;
      removed: RemovedLines;
      inserted: TaskRef;
      /** The block's lines as they were put into `target`. */
      lines: readonly string[];
      generation: number;
    };

/** Moving a note or task: done, refused with a reason, or failed (already reported). */
export type MoveOutcome =
  { kind: "moved"; path: string } | { kind: "invalid"; reason: string } | { kind: "failed" };

/** What a folder move did. */
type FolderOutcome = "moved" | "conflict" | "failed";

/** What a project holds, for the delete confirmation. */
export interface ProjectContents {
  notes: number;
  tasks: number;
}

export interface AppStateOptions {
  /** Runs the initial background work after the first render. */
  defer?: (task: () => void) => void;
  /** Schedules publishing loaded summaries; called at most once per pending update. */
  schedule?: (task: () => void) => void;
  /** Runs work that can wait until the app is idle, such as indexing saved notes for search. */
  idle?: (task: () => void) => void;
  /** Files read in parallel while loading titles and counts. */
  concurrency?: number;
  /** Clock and timers for autosave. */
  timers?: Timers;
  /** Delay after the last edit before saving. */
  saveDelay?: number;
  /** Longest wait for pending saves when the app closes or switches workspaces. */
  closeTimeout?: number;
  /** Delays of the git sync scheduler. */
  sync?: Partial<
    Pick<SyncSchedulerOptions, "commitDelay" | "syncInterval" | "focusSyncAge" | "backoffDelays">
  >;
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

function defaultIdle(task: () => void): void {
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(() => task(), { timeout: 2_000 });
  else setTimeout(task, 200);
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

export function noteExistsThereMessage(name: string): string {
  return `A note named ${name} already exists there.`;
}

export const MOVE_IGNORED = "Notes there are hidden by the workspace ignore patterns.";
export const TASKS_RESERVED = "tasks.md is reserved for task lists.";

export function movedNoteMessage(name: string, folder: string): string {
  return `Moved ${name} to ${folder}/`;
}

export function moveFailedMessage(name: string, message: string): string {
  return `${name} could not be moved: ${message}`;
}

export function movedTaskMessage(project: string): string {
  return `Moved task to ${project}`;
}

export function taskMoveFailedMessage(project: string, message: string): string {
  return `The task could not be moved to ${project}: ${message}`;
}

export function taskNotMovedBackMessage(message: string): string {
  return `The task could not be moved back: ${message}`;
}

export function linksNotUpdatedMessage(paths: readonly string[]): string {
  return `Links in ${paths.join(", ")} could not be updated`;
}

export function unsavedMoveMessage(paths: readonly string[]): string {
  return `Changes to ${paths.join(", ")} could not be saved, so nothing was changed.`;
}

export function renamedProjectMessage(from: string, to: string): string {
  return `Renamed project ${from} to ${to}`;
}

export function archivedProjectMessage(name: string): string {
  return `Archived ${name}`;
}

export function unarchivedProjectMessage(name: string): string {
  return `Unarchived ${name}`;
}

export function archivedExistsMessage(name: string): string {
  return `An archived project named ${name} already exists.`;
}

export function unarchiveTakenMessage(existing: string, name: string): string {
  return `A project named ${existing} already exists, so ${name} was not unarchived.`;
}

export function projectTrashedMessage(name: string): string {
  return `Project ${name} moved to the trash`;
}

/** How the backend says a folder was kept because the system trash cannot take it. */
const TRASH_UNAVAILABLE_PREFIX = "The system trash is not available for this folder";

export function deleteProjectFailedMessage(name: string, error: StorageError): string {
  if (error.kind === "Io" && error.message.startsWith(TRASH_UNAVAILABLE_PREFIX)) {
    return `Could not delete ${name}: the system trash is not available here. Nothing was deleted.`;
  }
  return `Could not delete ${name}: ${error.message}`;
}

export function projectActionFailedMessage(name: string, action: string, message: string): string {
  return `${name} could not be ${action}: ${message}`;
}

export const SHORTCUT_TAKEN = "Quick capture shortcut is in use by another app";
export const OPEN_WORKSPACE_FIRST = "Open a workspace in Kaido first";
export const NOTHING_TO_CAPTURE = "Type something to capture.";

export function capturedTaskMessage(project: string): string {
  return `Added to ${project}`;
}

export function capturedNoteMessage(path: string): string {
  return `Note created: ${path}`;
}

/** A capture written to a workspace that was closed while it was being written. */
export function capturedElsewhereMessage(message: string, root: string): string {
  return `${message} (in ${root}, which is no longer open)`;
}

/** Captures remembered by id, so one delivered twice is answered without writing again. */
export const HANDLED_CAPTURES = 100;

export function missingProjectMessage(project: string): string {
  return `The project ${project} no longer exists.`;
}

export function captureTaskFailedMessage(project: string, message: string): string {
  return `The task could not be added to ${project}: ${message}`;
}

export const TASK_LIST_TOO_LARGE = "its task list is larger than 1 MiB.";
export const TASK_LIST_HIDDEN = "its task list is hidden by the workspace ignore patterns.";
export const TASK_LIST_UNAVAILABLE = "its task list could not be read.";
export const TASK_LIST_APPEARED = "its task list was just created on disk. Try again.";

/** What a capture did, as told to the capture window. */
export interface CaptureOutcome {
  ok: boolean;
  message: string;
}

type NewNote =
  | { kind: "written"; written: WrittenFile }
  | { kind: "failed"; message: string }
  /** The workspace changed meanwhile; nothing more to do. `written` if the note was created anyway. */
  | { kind: "stale"; written?: WrittenFile };

const GIT_ERROR_KINDS: Partial<Record<string, GitErrorKind>> = {
  GitUnavailable: "unavailable",
  GitPaused: "paused",
  GitNetwork: "network",
  GitAuth: "auth",
};

/** Runs a git call and reports a failure as an outcome for the scheduler. */
async function gitOutcome<T>(work: () => Promise<T>): Promise<GitOutcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    const storageError = toStorageError(error);
    return {
      ok: false,
      kind: GIT_ERROR_KINDS[storageError.kind] ?? "failed",
      message: storageError.message,
    };
  }
}

/** Whether a shortcut change registered `wanted` (or turned the shortcut off for `null`). */
function shortcutApplied(change: ShortcutChange, wanted: string | null): boolean {
  if (wanted === null) return !change.registered;
  return change.registered && sameAccelerator(change.shortcut, wanted);
}

function toStatus(change: ShortcutChange): ShortcutStatus {
  return { registered: change.registered, shortcut: change.shortcut };
}

function withPath(paths: ReadonlySet<string>, path: string): ReadonlySet<string> {
  return new Set([...paths, path]);
}

function withoutPath(paths: ReadonlySet<string>, path: string): ReadonlySet<string> {
  return new Set([...paths].filter((item) => item !== path));
}

/** Actions that are refused once while edits cannot be saved. */
type UnsafeAction = "close" | "switch";

const SETTINGS_NOT_SAVED =
  "settings.json was left unchanged, so this workspace will not be reopened next time. Fix or remove the file to let Kaido save it.";

export const SETTINGS_CHANGES_NOT_SAVED =
  "settings.json was left unchanged, so changed settings are not saved. Fix or remove the file to let Kaido save it.";

export const SETTINGS_INVALID =
  "Some settings could not be read; defaults are used for them. See the settings warnings.";

export const SETTINGS_CHANGED_INVALID =
  "Some changed settings could not be read; their current values are kept. See the settings warnings.";

export const SETTINGS_KEEP_CHANGING = "Could not save settings: settings.json keeps changing";

/** Writes retried after settings.json changed since it was last read. */
export const SETTINGS_WRITE_RETRIES = 3;

/** A change the app makes to the device settings, applied field by field. */
type SettingsPatch = (settings: DeviceSettings) => DeviceSettings;

/** Adds warnings whose message is not there yet. */
function withWarnings(warnings: ConfigWarning[], added: ConfigWarning[]): ConfigWarning[] {
  const messages = new Set(warnings.map((warning) => warning.message));
  return [...warnings, ...added.filter((warning) => !messages.has(warning.message))];
}

export const SHORTCUT_IN_USE = "That shortcut is in use by another app";
export const CAPTURE_UNAVAILABLE = "Quick capture is not available in this window.";

export function setupDoneMessage(paths: readonly string[]): string {
  return paths.length === 0 ? "Nothing to set up" : `Set up ${paths.join(" and ")}`;
}

export function setupFailedMessage(message: string): string {
  return `The setup files could not be updated: ${message}`;
}

export const CLONE_CANCELLED = "Cloning was cancelled.";

export function gitSetupFailedMessage(message: string): string {
  return `The workspace was created, but git could not be set up: ${message}`;
}
export const ENTER_URL = "Enter the URL of a git repository.";
export const CHOOSE_FOLDER = "Choose a folder for it first.";

/** The outcome of the folder picker, for forms that show errors next to it. */
export type PickedFolder =
  { kind: "picked"; path: string } | { kind: "cancelled" } | { kind: "failed"; message: string };

/** Creating or cloning a workspace: opened (or being opened), refused with a reason, or cancelled. */
export type NewWorkspaceOutcome =
  { kind: "opened" } | { kind: "invalid"; message: string } | { kind: "cancelled" };

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
  /** Git state of the open workspace, or `null` before syncing starts. */
  sync: SyncSnapshot | null = $state.raw(null);
  /** The latest request for the editor to show a line, or `null`. */
  editorReveal: EditorRevealRequest | null = $state.raw(null);
  /** Bumped when search results may have changed, so an open search can run again. */
  searchRevision: number = $state(0);
  /** Device settings as stored (without defaults). */
  deviceSettings: DeviceSettings = $state.raw(parseSettings(null).value);
  /** Device settings with defaults filled in. */
  readonly settings: EffectiveSettings = $derived(effectiveSettings(this.deviceSettings));
  /** Recent workspaces that were not found when last opened. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced, never mutated
  missingWorkspaces: ReadonlySet<string> = $state.raw(new Set());
  /** Whether git is installed, once checked. */
  gitInfo: GitVersion | null = $state.raw(null);
  /** Setup files the open workspace lacks lines in, or `null` until checked. */
  setupMissing: readonly string[] | null = $state.raw(null);
  /** The setup banner is shown: lines are missing and it was not dismissed here. */
  readonly setupBanner: boolean = $derived(
    this.phase.kind === "ready" &&
      (this.setupMissing?.length ?? 0) > 0 &&
      !(this.deviceSettings.dismissedSetup ?? []).includes(this.phase.root),
  );
  /** The quick capture shortcut as registered, or `null` when unknown. */
  captureShortcut: ShortcutStatus | null = $state.raw(null);

  readonly #storage: Storage;
  readonly #defer: (task: () => void) => void;
  readonly #schedule: (task: () => void) => void;
  readonly #idle: (task: () => void) => void;
  readonly #concurrency: number;
  readonly #timers: Timers;
  readonly #saveDelay: number | undefined;
  readonly #closeTimeout: number;
  readonly #syncOptions: AppStateOptions["sync"];
  /** Commits and syncs the open workspace; `null` before it is loaded. */
  #scheduler: SyncScheduler | null = null;
  /** What the app did to files since the last commit, for commit messages. */
  #hints = new ChangeHints();
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
  /** Moves that an undo toast can take back, by toast id. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  readonly #moveUndos = new Map<number, MoveUndo>();
  /** Other toast actions, by toast id. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  readonly #toastActions = new Map<number, ToastAction>();
  /** The folder being moved or deleted, and when that is done (moves run one at a time). */
  #moving: { folder: string; done: Promise<void> } | null = null;
  /** Tasks a note is being created from, by path and line text. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  readonly #creatingFromTask = new Set<string>();
  readonly #tasks = new TaskIndex();
  readonly #search = new SearchIndex();
  /** The workspace whose projects the search index has. */
  #searchWorkspace: Workspace | null = null;
  #revealId = 0;
  /** Edits made through task list sessions created on demand, to apply again after a conflict. */
  readonly #taskEdits = new WeakMap<SaveSession, ((doc: TaskDocument) => TaskEdit | null)[]>();
  #tasksChanged = false;
  #taskFocusId = 0;
  /** The settings file as last read or written: the base app changes are patched onto. */
  #settingsFile: ParseResult<DeviceSettings> = parseSettings(null);
  #settingsWarnings: ConfigWarning[] = [];
  #configWarnings: ConfigWarning[] = [];
  /** The settings file's text as last read or written, to skip reports of the app's own writes. */
  #settingsText: string | null = null;
  #settingsLoaded = false;
  /** Settings writes and reloads, one at a time and in order. */
  #settingsWork: Promise<void> = Promise.resolve();
  /** Changes shown already but not written yet, applied again over a reloaded file. */
  #pendingSettings: SettingsPatch[] = [];
  #stopSettingsWatch: Unsubscribe | null = null;
  #captureHost: CaptureHost | null = null;
  /** Capture shortcut checks and changes, one at a time. */
  #shortcutWork: Promise<unknown> = Promise.resolve();
  #cloneCancelled = false;
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
    this.#storage = trackWrites(storage, {
      written: (path, created) => {
        if (created) this.#hints.created(path);
        this.#scheduler?.changed();
      },
      renamed: (from, to) => {
        this.#hints.renamed(from, to);
        this.#scheduler?.changed();
      },
      deleted: (path) => {
        this.#hints.deleted(path);
        this.#scheduler?.changed();
      },
      folderRenamed: (from, to) => {
        this.#hints.folderRenamed(from, to);
        this.#scheduler?.changed();
      },
      folderDeleted: (path) => {
        this.#hints.folderDeleted(path);
        this.#scheduler?.changed();
      },
    });
    this.#syncOptions = options.sync;
    this.#defer = options.defer ?? defaultDefer;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#idle = options.idle ?? defaultIdle;
    this.#concurrency = options.concurrency ?? 8;
    this.#timers = options.timers ?? systemTimers;
    this.#saveDelay = options.saveDelay;
    this.#closeTimeout = options.closeTimeout ?? 5_000;
  }

  /** Reads device settings and reopens the last workspace, if any. */
  async start(): Promise<void> {
    this.#watchClose();
    this.#watchSettings();
    try {
      const text = await this.#storage.readSettings();
      this.#settingsText = text;
      this.#settingsFile = parseSettings(text);
      this.#settingsWarnings = this.#settingsFile.warnings;
    } catch (error) {
      // Without readable settings, start fresh but never overwrite the file.
      this.#settingsFile = { ...parseSettings(null), writable: false };
      this.#settingsWarnings = [
        { field: "", message: `settings.json: ${toStorageError(error).message}` },
      ];
    }
    this.deviceSettings = this.#settingsFile.value;
    this.#settingsLoaded = true;
    this.warnings = this.#settingsWarnings;
    if (this.#settingsWarnings.length > 0) this.#toast(SETTINGS_INVALID);
    void this.#syncCaptureShortcut(true);
    const path = this.deviceSettings.workspace;
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
    const stopping = this.#stopSync();
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
    this.setupMissing = null;
    try {
      // Pending saves must land in the workspace they belong to, and git
      // must be done with it before the backend switches.
      if (closing) await closing;
      await this.#withTimeout(stopping);
      this.#hints = new ChangeHints();
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
      this.#search.clear();
      this.#searchWorkspace = null;
      this.summaries = this.#store.view();
      this.#tasks.clear();
      this.#tasksChanged = false;
      this.taskDocs = this.#tasks.view();
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced, never mutated
      this.hideDone = new Set(this.#hideDoneKeys(root));
      this.notice = null;
      this.#select(INBOX);
      this.phase = { kind: "ready", root };
      this.#rememberWorkspace(root);
      this.#background = new Promise((resolve) => {
        this.#defer(() => {
          this.#enqueue([...this.#index.keys()], generation);
          this.#startSync(generation);
          void this.#checkSetup(generation);
          resolve();
        });
      });
    } catch (error) {
      // A newer open overtook this one; it owns the state now.
      if (generation !== this.#generation || toStorageError(error).kind === "Superseded") return;
      this.#unwatch?.();
      this.#unwatch = null;
      const kind = toStorageError(error).kind;
      if (kind === "NotFound" || kind === "NotADirectory") {
        this.missingWorkspaces = withPath(this.missingWorkspaces, path);
      }
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
    if (path !== "" && path !== ALL_TASKS) this.#search.touch(path);
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
    // A project being moved gets the note where it ends up.
    const moved = this.#moveOf(newNoteFolder(this.folder));
    if (moved) await moved;
    if (generation !== this.#generation || this.phase.kind !== "ready") return;
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
      const moves: PathMove[] = [{ from: path, to, folder: false }];
      this.#remapUndo(moves);
      await this.#retargetAll(moves);
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
  async undoDelete(id: number): Promise<"note" | "task" | "project" | null> {
    const move = this.#moveUndos.get(id);
    if (move) {
      this.dismissToast(id);
      await this.#undoMove(move);
      return move.kind === "folder" ? "project" : move.kind;
    }
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

  /** The toast of the most recent note or task change that can still be undone, or `null`. */
  get latestUndo(): number | null {
    let latest: number | null = null;
    const moves = [...this.#moveUndos].filter(([, undo]) => undo.kind !== "folder");
    for (const id of [
      ...this.#deleted.keys(),
      ...this.#deletedTasks.keys(),
      ...moves.map(([key]) => key),
    ])
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
    this.#saveHideDone();
  }

  /** Whether `path` is a note shown in the workspace. */
  hasNote(path: string): boolean {
    return this.#isNote(path);
  }

  /** Selects a note in its project and moves focus into the editor. */
  openNote(path: string): void {
    const role = classifyPath(path, createPathFilter(this.#config));
    if (role?.kind !== "note" || !this.#isNote(path)) return;
    this.folder = projectKey(role.project, role.archived);
    this.selectItem(path);
    this.editorFocusRequest += 1;
  }

  /**
   * Searches notes, tasks and projects. An empty query lists the recently
   * opened notes and lists, then the projects.
   */
  search(query: string): SearchResult[] {
    if (this.phase.kind !== "ready") return [];
    if (this.#searchWorkspace !== this.workspace) {
      this.#searchWorkspace = this.workspace;
      this.#search.setProjects(this.workspace.projects.map((project) => project.name));
    }
    return this.#search.search(query);
  }

  /**
   * Opens a search result: a note in the editor (at the first match when
   * only its text matched), a task focused in its list, or a project's
   * task list.
   */
  openSearchResult(result: SearchResult): void {
    if (this.phase.kind !== "ready") return;
    switch (result.kind) {
      case "note":
        this.openNote(result.path);
        if (result.line !== undefined && this.item === result.path) {
          this.#revealId += 1;
          this.editorReveal = { id: this.#revealId, path: result.path, line: result.line };
        }
        return;
      case "task":
        this.#openTask(result.path, result.line ?? 0, result.raw ?? "");
        return;
      case "list":
        this.#openList(result.path);
        return;
      case "project":
        this.#openProject(result.path);
        return;
    }
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
    this.#toastActions.set(id, {
      path: link.path,
      exists: false,
      run: (path) => this.#createLinkedNote(path, title, generation),
    });
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
    const created = await this.#writeNewNote(folder, stem, contents);
    if (created.kind === "stale") return;
    if (created.kind === "failed") {
      this.#toast(created.message);
      return;
    }
    const written = created.written;
    const suffix = noteLink(baseName(written.path));
    // Found by its text again: the list may have changed while the note was written.
    const linked = this.#editTasks(path, null, (current) => {
      const at = taskOps.locateTask(current, ref);
      const now = at === null ? null : taskOps.taskAt(current, at);
      return now ? taskOps.editTaskText(current, ref, `${now.text} ${suffix}`) : null;
    });
    if (!linked) this.#toast(notLinkedMessage(baseName(written.path)));
    this.#openCreated(written, contents, projectKeyOf(written.path));
    this.editorFocusRequest += 1;
  }

  /**
   * Creates `<folder>/<stem>.md` (or `<stem> 2.md`, … when taken) with
   * `contents`, never replacing a file. A name taken on disk meanwhile
   * moves on to the next one.
   */
  async #writeNewNote(folder: string, stem: string, contents: string): Promise<NewNote> {
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
      try {
        const written = await this.#storage.writeFile(candidate, contents, { expectedHash: null });
        return generation === this.#generation
          ? { kind: "written", written }
          : { kind: "stale", written };
      } catch (error) {
        if (generation !== this.#generation) return { kind: "stale" };
        const storageError = toStorageError(error);
        if (storageError.kind === "Conflict") {
          tried.push(candidate.toLowerCase());
          continue;
        }
        return { kind: "failed", message: createNoteFailedMessage(storageError.message) };
      }
    }
    if (generation !== this.#generation) return { kind: "stale" };
    return { kind: "failed", message: NO_FREE_NOTE_NAME };
  }

  /**
   * Connects quick capture: captures sent by the capture window are written
   * and answered, and its requests for the project list are answered. Says
   * once if the capture shortcut could not be registered.
   */
  connectCapture(host: CaptureHost): Unsubscribe {
    let stopped = false;
    const stops: Unsubscribe[] = [];
    const keep = (subscription: Promise<Unsubscribe>) => {
      subscription
        .then((stop) => {
          if (stopped) stop();
          else stops.push(stop);
        })
        // Without the subscription quick capture does nothing; the app works on.
        .catch(() => undefined);
    };
    // A capture delivered again gets the first answer instead of being written twice.
    const handled = new LruCache<string, Promise<CaptureOutcome>>(HANDLED_CAPTURES);
    keep(
      host.onSubmit((submit) => {
        let outcome = handled.get(submit.id);
        if (!outcome) {
          outcome = this.capture(submit.kind, submit.text, submit.project);
          handled.set(submit.id, outcome);
        }
        void outcome.then((answer) =>
          host.sendResult({ id: submit.id, ...answer }).catch(() => undefined),
        );
      }),
    );
    keep(
      host.onProjectsRequest(() => {
        host.sendProjects(this.captureProjects()).catch(() => undefined);
      }),
    );
    this.#captureHost = host;
    void this.#syncCaptureShortcut(true);
    return () => {
      stopped = true;
      if (this.#captureHost === host) this.#captureHost = null;
      for (const stop of stops) stop();
    };
  }

  /** The projects quick capture can add to, the inbox first. */
  captureProjects(): CaptureProjects {
    if (this.phase.kind !== "ready") return { projects: [], workspaceOpen: false };
    return {
      projects: this.workspace.projects.map((project) => project.name),
      workspaceOpen: true,
    };
  }

  /**
   * Adds `text` as an open task at the end of a project's task list
   * (creating the list if there is none), or creates a note named after it.
   * The selection does not change; a toast tells what was done. When the
   * workspace is closed while the capture is written, the answer says where
   * it went.
   */
  async capture(kind: CaptureKind, text: string, project: string): Promise<CaptureOutcome> {
    if (this.phase.kind !== "ready") return { ok: false, message: OPEN_WORKSPACE_FIRST };
    if (taskOps.cleanTaskText(text) === "") return { ok: false, message: NOTHING_TO_CAPTURE };
    const generation = this.#generation;
    const root = this.phase.root;
    return this.#serial(async (): Promise<CaptureOutcome> => {
      if (generation !== this.#generation) return { ok: false, message: WORKSPACE_CLOSED };
      if (!findProject(this.workspace, project)) {
        return { ok: false, message: missingProjectMessage(project) };
      }
      const outcome =
        kind === "task"
          ? await this.#captureTask(project, text)
          : await this.#captureNote(project, text);
      if (generation === this.#generation) return outcome;
      if (!outcome.ok) return { ok: false, message: WORKSPACE_CLOSED };
      return { ok: true, message: capturedElsewhereMessage(outcome.message, root) };
    });
  }

  async #captureTask(project: string, text: string): Promise<CaptureOutcome> {
    const path = projectTasksPath(project);
    const fail = (reason: string) => ({
      ok: false,
      message: captureTaskFailedMessage(project, reason),
    });
    if (classifyPath(path, createPathFilter(this.#config))?.kind !== "tasks") {
      return fail(TASK_LIST_HIDDEN);
    }
    const generation = this.#generation;
    const entry = this.#index.get(path);
    if (!entry) {
      const contents = `${serializeTask({ done: false, text: taskOps.cleanTaskText(text) })}\n`;
      let written: WrittenFile;
      try {
        written = await this.#storage.writeFile(path, contents, { expectedHash: null });
      } catch (error) {
        const storageError = toStorageError(error);
        // The watcher reports the new list soon; adding to it now could lose the task.
        return fail(storageError.kind === "Conflict" ? TASK_LIST_APPEARED : storageError.message);
      }
      // Written, but to a workspace that is no longer open.
      if (generation !== this.#generation)
        return { ok: true, message: capturedTaskMessage(project) };
      this.#addCreated(written, contents);
      this.#tasks.set(path, contents, written.hash);
      this.#publishTasks();
    } else {
      if (!this.#sessions.has(path) && !this.#tasks.get(path)) {
        // Not read in the background yet.
        if (entry.size > MAX_SUMMARY_BYTES) return fail(TASK_LIST_TOO_LARGE);
        let file: FileContents;
        try {
          file = await this.#storage.readFile(path);
        } catch (error) {
          return fail(toStorageError(error).message);
        }
        if (generation !== this.#generation) return { ok: false, message: WORKSPACE_CLOSED };
        if (!this.#sessions.has(path) && !this.#tasks.get(path)) {
          this.#tasks.set(path, file.contents, file.hash);
        }
      }
      const edit = this.#editTasks(path, null, (doc) => taskOps.insertTask(doc, text, "end"));
      if (!edit) return fail(TASK_LIST_UNAVAILABLE);
    }
    const message = capturedTaskMessage(project);
    this.#toast(message);
    return { ok: true, message };
  }

  async #captureNote(project: string, text: string): Promise<CaptureOutcome> {
    const stem = noteNameFromTask(text);
    const contents = `# ${textWithoutLinks(text) || stem}\n`;
    const created = await this.#writeNewNote(project, stem, contents);
    if (created.kind === "stale") {
      if (!created.written) return { ok: false, message: WORKSPACE_CLOSED };
      return { ok: true, message: capturedNoteMessage(created.written.path) };
    }
    if (created.kind === "failed") return { ok: false, message: created.message };
    const path = this.#addCreated(created.written, contents).path;
    const message = capturedNoteMessage(path);
    const id = this.#toast(message, "Open");
    this.#toastActions.set(id, { path, exists: true, run: async (at) => this.openNote(at) });
    return { ok: true, message };
  }

  /** Runs a toast's action button: undo a delete, or create a missing note. */
  async runToastAction(id: number): Promise<"note" | "task" | "project" | "create" | null> {
    const action = this.#toastActions.get(id);
    if (!action) return this.undoDelete(id);
    this.dismissToast(id);
    await action.run(action.path);
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

  /**
   * Moves a note into another folder of the workspace, keeping its file
   * name. An open note keeps its text, history and save state, and links to
   * it from task lists are updated. A toast can undo it.
   */
  async moveNote(path: string, folder: string): Promise<MoveOutcome> {
    if (this.phase.kind !== "ready") return { kind: "failed" };
    const name = baseName(path);
    const to = folder === "" ? name : `${folder}/${name}`;
    if (to === path) return { kind: "moved", path };
    const generation = this.#generation;
    return this.#serial(async (): Promise<MoveOutcome> => {
      if (generation !== this.#generation) return { kind: "failed" };
      const outcome = await this.#moveNoteTo(path, to);
      if (outcome.kind !== "moved" || generation !== this.#generation) return outcome;
      const id = this.#toast(movedNoteMessage(name, folder), "Undo");
      this.#moveUndos.set(id, { kind: "note", from: path, to: outcome.path, generation });
      return outcome;
    });
  }

  /** Moves a note to `to`; runs in the change queue. */
  async #moveNoteTo(path: string, to: string): Promise<MoveOutcome> {
    const generation = this.#generation;
    const name = baseName(to);
    if (!this.#isNote(path)) return { kind: "invalid", reason: NOTE_GONE };
    if (this.#nameTaken(path, to)) {
      return { kind: "invalid", reason: noteExistsThereMessage(name) };
    }
    const role = classifyPath(to, createPathFilter(this.#config));
    if (role?.kind === "tasks") return { kind: "invalid", reason: TASKS_RESERVED };
    if (role === null) return { kind: "invalid", reason: MOVE_IGNORED };
    const selected = this.item === path;
    const session = this.#sessions.get(path);
    try {
      if (session) {
        await session.exclusive(async () => {
          const written = await this.#storage.moveFile(path, to);
          session.moveTo(written.path, written.hash);
          if (generation === this.#generation) this.#applyRename(path, written, session);
        });
      } else {
        const written = await this.#storage.moveFile(path, to);
        if (generation === this.#generation) this.#applyRename(path, written, null);
      }
    } catch (error) {
      if (generation !== this.#generation) return { kind: "failed" };
      const storageError = toStorageError(error);
      if (storageError.kind === "Conflict") {
        return { kind: "invalid", reason: noteExistsThereMessage(name) };
      }
      this.#toast(moveFailedMessage(baseName(path), storageError.message));
      return { kind: "failed" };
    }
    if (generation !== this.#generation) return { kind: "failed" };
    // The open note stays open, now in the project it moved to.
    if (selected && this.item === to) this.folder = projectKeyOf(to);
    const moves: PathMove[] = [{ from: path, to, folder: false }];
    this.#remapUndo(moves);
    await this.#retargetAll(moves);
    return { kind: "moved", path: to };
  }

  /**
   * Moves a top-level task with its detail and subtasks to the end of
   * another project's task list (created when missing). Links in it are
   * rewritten for the new list. A toast can undo it.
   */
  async moveTaskToProject(path: string, ref: TaskRef, project: string): Promise<MoveOutcome> {
    if (this.phase.kind !== "ready") return { kind: "failed" };
    const target = projectTasksPath(project);
    if (target === path) return { kind: "moved", path };
    const generation = this.#generation;
    return this.#serial(async (): Promise<MoveOutcome> => {
      if (generation !== this.#generation) return { kind: "failed" };
      if (!findProject(this.workspace, project)) {
        return { kind: "invalid", reason: missingProjectMessage(project) };
      }
      const problem = await this.#ensureTaskList(target);
      if (generation !== this.#generation) return { kind: "failed" };
      if (problem !== null) {
        return { kind: "invalid", reason: taskMoveFailedMessage(project, problem) };
      }
      const doc = this.#currentTasks(path);
      const line = doc ? taskOps.locateTask(doc, ref) : null;
      const block = doc && line !== null ? taskOps.blockOf(doc, line) : null;
      const removal = doc && block?.line === line ? taskOps.deleteTask(doc, ref) : null;
      if (!removal) {
        this.#toast(TASK_CHANGED);
        return { kind: "failed" };
      }
      const blockText = taskOps.joinLines(removal.removed.lines);
      const moved = retargetLinks(blockText, path, [], target)?.text ?? blockText;
      const lines = taskOps.splitLines(moved);
      const added = this.#editTasks(target, null, (current) => taskOps.appendLines(current, lines));
      if (added?.focus == null) {
        this.#toast(taskMoveFailedMessage(project, TASK_LIST_UNAVAILABLE));
        return { kind: "failed" };
      }
      const inserted = { line: added.focus, raw: lines[0]?.text ?? "" };
      // The task leaves its list only once it is safely in the other one.
      const failure = await this.#saveNow(target);
      if (generation !== this.#generation) return { kind: "failed" };
      if (failure !== null) {
        this.#editTasks(target, null, (current) => taskOps.deleteAppendedTask(current, inserted));
        this.#toast(taskMoveFailedMessage(project, failure));
        return { kind: "failed" };
      }
      let removed: RemovedLines | null = null;
      this.#editTasks(path, ref, (current) => {
        const deletion = taskOps.deleteTask(current, ref);
        // Changed while the other list was saved: it stays where it is.
        if (!deletion || taskOps.joinLines(deletion.removed.lines) !== blockText) return null;
        removed = deletion.removed;
        return deletion;
      });
      if (removed === null) {
        // Never leave the task in both lists.
        this.#editTasks(target, null, (current) => taskOps.deleteAppendedTask(current, inserted));
        this.#toast(TASK_CHANGED);
        return { kind: "failed" };
      }
      const id = this.#toast(movedTaskMessage(project), "Undo");
      this.#moveUndos.set(id, {
        kind: "task",
        source: path,
        target,
        removed,
        inserted,
        lines: lines.map((line) => line.text),
        generation,
      });
      return { kind: "moved", path: target };
    });
  }

  /**
   * Makes sure the task list at `path` can be edited: created (empty,
   * create-only) when missing, read when not read yet. Returns why it
   * cannot, or `null`.
   */
  async #ensureTaskList(path: string): Promise<string | null> {
    if (classifyPath(path, createPathFilter(this.#config))?.kind !== "tasks") {
      return TASK_LIST_HIDDEN;
    }
    const generation = this.#generation;
    const entry = this.#index.get(path);
    if (!entry) {
      let written: WrittenFile;
      try {
        written = await this.#storage.writeFile(path, "", { expectedHash: null });
      } catch (error) {
        const storageError = toStorageError(error);
        return storageError.kind === "Conflict" ? TASK_LIST_APPEARED : storageError.message;
      }
      if (generation !== this.#generation) return WORKSPACE_CLOSED;
      this.#addCreated(written, "");
      this.#tasks.set(path, "", written.hash);
      this.#publishTasks();
      return null;
    }
    if (this.#sessions.has(path) || this.#tasks.get(path)) return null;
    if (entry.size > MAX_SUMMARY_BYTES) return TASK_LIST_TOO_LARGE;
    let file: FileContents;
    try {
      file = await this.#storage.readFile(path);
    } catch (error) {
      return toStorageError(error).message;
    }
    if (generation !== this.#generation) return WORKSPACE_CLOSED;
    if (!this.#sessions.has(path) && !this.#tasks.get(path)) {
      this.#tasks.set(path, file.contents, file.hash);
    }
    return null;
  }

  /** How many notes and tasks a project has, for the delete confirmation. */
  projectContents(key: string): ProjectContents {
    const project = findProjectByKey(this.workspace, key);
    if (!project) return { notes: 0, tasks: 0 };
    const path = project.tasks?.path;
    const doc = path === undefined ? null : this.#currentTasks(path);
    const tasks =
      path === undefined ? 0 : (doc?.blocks.length ?? this.summaries.get(path)?.openTasks ?? 0);
    return { notes: project.notes.length, tasks };
  }

  /**
   * Renames an active or archived project (its folder) to the typed name.
   * Open notes keep their state; links to its notes are updated. A toast
   * can undo it.
   */
  async renameProject(key: string, input: string): Promise<RenameOutcome> {
    if (this.phase.kind !== "ready") return { kind: "failed" };
    const archived = isArchivedKey(key);
    const name = projectNameOf(key);
    if (input.trim() === name) return { kind: "renamed", path: key };
    const others = (archived ? this.workspace.archived : this.workspace.projects)
      .map((project) => project.name)
      .filter((other) => other !== name);
    const validation = validateProjectName(input, others);
    if (!validation.ok) return { kind: "invalid", reason: validation.reason };
    const to = projectKey(validation.name, archived);
    if (classifyPath(projectTasksPath(to), createPathFilter(this.#config))?.kind !== "tasks") {
      return { kind: "invalid", reason: PROJECT_IGNORED };
    }
    const generation = this.#generation;
    return this.#serial(async (): Promise<RenameOutcome> => {
      if (generation !== this.#generation || !findProjectByKey(this.workspace, key)) {
        return { kind: "failed" };
      }
      const outcome = await this.#moveFolder(key, to, "renamed");
      if (outcome === "conflict") {
        return { kind: "invalid", reason: projectExistsMessage(validation.name) };
      }
      if (outcome === "failed") return { kind: "failed" };
      const id = this.#toast(renamedProjectMessage(name, validation.name), "Undo");
      this.#moveUndos.set(id, { kind: "folder", from: key, to, generation });
      return { kind: "renamed", path: to };
    });
  }

  /** Moves a project into `_archive/`; a toast can undo it. */
  async archiveProject(name: string): Promise<void> {
    if (this.phase.kind !== "ready" || name === INBOX) return;
    const generation = this.#generation;
    await this.#serial(async () => {
      if (generation !== this.#generation || !findProject(this.workspace, name)) return;
      const taken = this.workspace.archived.find(
        (project) => project.name.toLowerCase() === name.toLowerCase(),
      );
      if (taken) {
        this.#toast(archivedExistsMessage(taken.name));
        return;
      }
      const to = projectKey(name, true);
      const outcome = await this.#moveFolder(name, to, "archived");
      if (outcome === "conflict") this.#toast(archivedExistsMessage(name));
      if (outcome !== "moved") return;
      const id = this.#toast(archivedProjectMessage(name), "Undo");
      this.#moveUndos.set(id, { kind: "folder", from: name, to, generation });
    });
  }

  /** Moves an archived project back; refused while an active project has its name. */
  async unarchiveProject(name: string): Promise<void> {
    if (this.phase.kind !== "ready") return;
    const generation = this.#generation;
    const from = projectKey(name, true);
    await this.#serial(async () => {
      if (generation !== this.#generation || !findProjectByKey(this.workspace, from)) return;
      const taken = this.workspace.projects.find(
        (project) => project.name.toLowerCase() === name.toLowerCase(),
      );
      if (taken) {
        this.#toast(unarchiveTakenMessage(taken.name, name));
        return;
      }
      const outcome = await this.#moveFolder(from, name, "unarchived");
      if (outcome === "conflict") this.#toast(unarchiveTakenMessage(name, name));
      if (outcome !== "moved") return;
      const id = this.#toast(unarchivedProjectMessage(name), "Undo");
      this.#moveUndos.set(id, { kind: "folder", from, to: name, generation });
    });
  }

  /**
   * Moves a project folder to the system trash, after saving pending edits
   * of its files. There is no undo toast: the trash is the undo.
   */
  async deleteProject(key: string): Promise<void> {
    if (this.phase.kind !== "ready" || key === INBOX) return;
    const generation = this.#generation;
    const name = projectNameOf(key);
    await this.#serial(async () => {
      if (generation !== this.#generation || !findProjectByKey(this.workspace, key)) return;
      const held = await this.#holdSessions(key);
      try {
        if (held.unsaved.length > 0) {
          this.#toast(unsavedMoveMessage(held.unsaved));
          return;
        }
        try {
          await this.#storage.deleteFolder(key);
        } catch (error) {
          if (generation === this.#generation) {
            this.#toast(deleteProjectFailedMessage(name, toStorageError(error)));
          }
          return;
        }
        if (generation !== this.#generation) return;
        this.#applyFolderDelete(key);
      } finally {
        held.release();
      }
      this.#toast(projectTrashedMessage(name));
    });
  }

  /** The toast of the most recent project move that can still be undone, or `null`. */
  get latestProjectUndo(): number | null {
    let latest: number | null = null;
    for (const [id, undo] of this.#moveUndos) {
      if (undo.kind === "folder") latest = latest === null ? id : Math.max(latest, id);
    }
    return latest;
  }

  /** Takes back the move of toast `id`. */
  async #undoMove(undo: MoveUndo): Promise<void> {
    if (undo.generation !== this.#generation) return;
    if (undo.kind === "task") {
      await this.#undoTaskMove(undo);
      return;
    }
    await this.#serial(async () => {
      if (undo.generation !== this.#generation) return;
      if (undo.kind === "note") {
        const outcome = await this.#moveNoteTo(undo.to, undo.from);
        if (outcome.kind === "invalid") this.#toast(outcome.reason);
        return;
      }
      const outcome = await this.#moveFolder(undo.to, undo.from, "moved back");
      if (outcome === "conflict") this.#toast(projectExistsMessage(projectNameOf(undo.from)));
    });
  }

  /**
   * Moves a task back: restores it in its old list, and only once that is
   * saved takes it out of the list it was moved to. Runs in the change queue.
   */
  #undoTaskMove(undo: Extract<MoveUndo, { kind: "task" }>): Promise<void> {
    return this.#serial(async () => {
      if (undo.generation !== this.#generation) return;
      const target = this.#currentTasks(undo.target);
      const line = target ? taskOps.locateTask(target, undo.inserted) : null;
      const block = target && line !== null ? taskOps.blockOf(target, line) : null;
      if (!target || !block || block.line !== line) {
        this.#toast(TASK_CHANGED);
        return;
      }
      // Lines unchanged since the move go back as they were; lines changed
      // since (e.g. by a link update) keep the change, with links for the old list.
      const now = target.lines.slice(block.line, block.end);
      const lines = now.map((current, index): SourceLine => {
        const original = undo.removed.lines[index];
        if (original && current.text === undo.lines[index]) return original;
        const eol = original?.eol ?? current.eol;
        const text = retargetLinks(current.text, undo.target, [], undo.source)?.text;
        return { text: text ?? current.text, eol };
      });
      const removed = { ...undo.removed, lines };
      const restored = this.#editTasks(undo.source, null, (doc) =>
        taskOps.restoreLines(doc, removed),
      );
      if (restored?.focus == null) {
        this.#toast(TASK_NOT_RESTORED);
        return;
      }
      const back = { line: restored.focus, raw: lines[0]?.text ?? "" };
      const failure = await this.#saveNow(undo.source);
      if (undo.generation !== this.#generation) return;
      if (failure !== null) {
        this.#editTasks(undo.source, null, (doc) => taskOps.deleteTask(doc, back));
        this.#toast(taskNotMovedBackMessage(failure));
        return;
      }
      const taken = this.#editTasks(undo.target, undo.inserted, (doc) =>
        taskOps.deleteAppendedTask(doc, undo.inserted),
      );
      if (!taken) {
        // Changed in its new list meanwhile: it stays there, and only there.
        this.#editTasks(undo.source, null, (doc) => taskOps.deleteTask(doc, back));
        return;
      }
      this.#requestTaskFocus(undo.source, restored.focus);
    });
  }

  /** When the folder move that `path` is part of is done, or `null` if none is. */
  #moveOf(path: string): Promise<void> | null {
    const moving = this.#moving;
    if (!moving || (path !== moving.folder && !isInside(path, moving.folder))) return null;
    return moving.done;
  }

  /**
   * Saves the pending edits of the session at `path` now. Returns why they
   * could not be saved, or `null` once they are on disk.
   */
  async #saveNow(path: string): Promise<string | null> {
    const session = this.#sessions.get(path);
    if (!session) return TASK_LIST_UNAVAILABLE;
    await session.flush();
    return session.status.kind === "failed" ? session.status.message : null;
  }

  /**
   * Saves pending edits of the sessions inside `folder` and holds them, so
   * none writes while the folder moves. `unsaved` are the paths whose edits
   * could not be saved.
   */
  async #holdSessions(
    folder: string,
  ): Promise<{ sessions: SaveSession[]; unsaved: string[]; release: () => void }> {
    const sessions = [...this.#sessions.values()].filter((session) =>
      isInside(session.path, folder),
    );
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    // Sessions and reads that start inside the folder meanwhile wait as well.
    const moving = { folder, done: gate };
    this.#moving = moving;
    const release = () => {
      if (this.#moving === moving) this.#moving = null;
      open();
    };
    const held = await Promise.all(
      sessions.map(
        (session) =>
          new Promise<boolean>((resolve) => {
            session
              .exclusive(async () => {
                resolve(true);
                await gate;
              })
              // A session closed meanwhile has nothing left to save.
              .catch(() => resolve(false));
          }),
      ),
    );
    const kept = sessions.filter((_, index) => held[index] === true);
    const unsaved = kept.filter((session) => session.dirty).map((session) => session.path);
    return { sessions: kept, unsaved, release };
  }

  /**
   * Moves the folder `from` to `to` after saving the pending edits inside
   * it, then updates everything that knows its paths in one step, and the
   * links that point into or out of it. Runs in the change queue.
   */
  async #moveFolder(from: string, to: string, action: string): Promise<FolderOutcome> {
    const generation = this.#generation;
    const name = projectNameOf(from);
    const held = await this.#holdSessions(from);
    try {
      if (held.unsaved.length > 0) {
        this.#toast(unsavedMoveMessage(held.unsaved));
        return "failed";
      }
      let entries: readonly FileEntry[];
      try {
        entries = (await this.#storage.renameFolder(from, to)).entries;
      } catch (error) {
        if (generation !== this.#generation) return "failed";
        const storageError = toStorageError(error);
        if (storageError.kind === "Conflict") return "conflict";
        this.#toast(projectActionFailedMessage(name, action, storageError.message));
        return "failed";
      }
      if (generation !== this.#generation) return "failed";
      this.#applyFolderMove(from, to, entries);
    } finally {
      held.release();
    }
    const moves: PathMove[] = [{ from, to, folder: true }];
    await this.#retargetAll(moves);
    return "moved";
  }

  /** Puts every path under `from` under `to`, everywhere the app keeps paths. */
  #applyFolderMove(from: string, to: string, entries: readonly FileEntry[]): void {
    const move: PathMove = { from, to, folder: true };
    const rename = (path: string) => applyMove(path, move);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local to this call, never rendered
    const fresh = new Map(entries.map((entry) => [entry.path, entry]));
    const pairs: [string, string][] = [];
    const files: FileEntry[] = [];
    for (const file of this.#files) {
      const target = rename(file.path);
      if (target === null) {
        files.push(file);
        continue;
      }
      pairs.push([file.path, target]);
      files.push(fresh.get(target) ?? { ...file, path: target });
      fresh.delete(target);
    }
    files.push(...fresh.values());
    this.#files = files;
    this.workspace = buildWorkspace(files, this.#config);

    const unread: string[] = [];
    for (const [old, target] of pairs) {
      if (!this.#store.rename(old, target)) unread.push(target);
      if (this.#tasks.rename(old, target)) this.#tasksChanged = true;
      if (isTaskListPath(target)) continue;
      if (this.#searchable(old) && this.#searchable(target)) this.#search.renameNote(old, target);
      else if (this.#searchable(old)) this.#search.removeNote(old);
      else if (this.#searchable(target)) unread.push(target);
    }
    this.#search.renameRecent(rename);

    for (const session of [...this.#sessions.values()]) {
      const target = rename(session.path);
      if (target === null) continue;
      const old = session.path;
      // Same file, same contents: nothing to check again.
      session.moveTo(target, session.hash ?? "");
      if (this.#sessions.get(old) === session) this.#sessions.delete(old);
      this.#sessions.set(target, session);
    }
    if (pairs.length > 0) {
      this.editorChanges = [
        ...this.editorChanges,
        ...pairs.map(([old, target]): EditorPathChange => ({
          kind: "rename",
          from: old,
          to: target,
        })),
      ];
    }

    if (this.folder === from) this.folder = to;
    const item = rename(this.item);
    if (item !== null) {
      this.item = item;
      const doc = this.document;
      const docPath = doc ? rename(doc.path) : null;
      if (doc && docPath !== null) {
        const session = this.#sessions.get(docPath);
        this.document =
          session && doc.status === "ready"
            ? { status: "ready", path: docPath, text: session.text, modified: doc.modified }
            : { ...doc, path: docPath };
        // A read that waited for the move starts again at the new path.
        if (doc.status === "loading") void this.#loadDocument(docPath, this.#generation);
      }
    }
    const focus = this.taskFocus;
    const focusPath = focus ? rename(focus.path) : null;
    if (focus && focusPath !== null) this.taskFocus = { ...focus, path: focusPath };
    const reveal = this.editorReveal;
    const revealPath = reveal ? rename(reveal.path) : null;
    if (reveal && revealPath !== null) this.editorReveal = { ...reveal, path: revealPath };
    this.#remapHideDone((key) => rename(key));
    this.#remapUndo([move]);

    this.#enqueue(unread, this.#generation);
    this.#publishTasks();
  }

  /** Forgets everything inside a deleted folder; selects the inbox if it was selected. */
  #applyFolderDelete(folder: string): void {
    const gone = (path: string) => isInside(path, folder);
    // Including sessions started while the delete waited.
    const sessions = [...this.#sessions.values()].filter((session) => gone(session.path));
    const removed = this.#files.filter((file) => gone(file.path)).map((file) => file.path);
    this.#files = this.#files.filter((file) => !gone(file.path));
    this.workspace = buildWorkspace(this.#files, this.#config);
    this.#store.retain((path) => !gone(path));
    this.#search.retainNotes((path) => !gone(path));
    if (this.#tasks.retain((path) => !gone(path))) this.#tasksChanged = true;
    for (const session of sessions) {
      session.dispose();
      if (this.#sessions.get(session.path) === session) this.#sessions.delete(session.path);
    }
    if (removed.length > 0) {
      this.editorChanges = [
        ...this.editorChanges,
        ...removed.map((path): EditorPathChange => ({ kind: "forget", path })),
      ];
    }
    this.#remapHideDone((key) => (gone(key) ? "" : null));
    for (const [id, undo] of [...this.#moveUndos]) {
      const paths = undo.kind === "task" ? [undo.source, undo.target] : [undo.from, undo.to];
      if (paths.some((path) => gone(path) || path === folder)) this.dismissToast(id);
    }
    for (const [id, deleted] of [...this.#deleted]) if (gone(deleted.path)) this.dismissToast(id);
    for (const [id, task] of [...this.#deletedTasks]) if (gone(task.path)) this.dismissToast(id);
    if (this.folder === folder || gone(this.item)) this.#select(INBOX);
    this.#publishTasks();
  }

  /**
   * Updates the remembered hidden done tasks after paths moved: `rename`
   * returns the new key, `""` to drop it, or `null` to keep it.
   */
  #remapHideDone(rename: (key: string) => string | null): void {
    let changed = false;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced, never mutated
    const next = new Set<string>();
    for (const key of this.hideDone) {
      const target = key === ALL_TASKS ? null : rename(key);
      if (target === null) next.add(key);
      else {
        changed = true;
        if (target !== "") next.add(target);
      }
    }
    if (!changed) return;
    this.hideDone = next;
    this.#saveHideDone();
  }

  /** Saves the hidden done tasks of the open workspace (only that field). */
  #saveHideDone(): void {
    if (this.phase.kind !== "ready") return;
    const keys = [...this.hideDone].map((item) => (item === ALL_TASKS ? ALL_TASKS_KEY : item));
    const root = this.phase.root;
    this.#updateSettings((settings) => withHideDone(settings, root, keys));
  }

  /**
   * Keeps undo toasts and toast actions pointing at the files they belong to
   * after paths moved. A path where nothing is now (a deleted note, the old
   * place of a moved note, a note still to create) only follows the folder
   * it was in; a file moved since to that path is something else.
   */
  #remapUndo(moves: readonly PathMove[]): void {
    const map = (path: string) => movedPath(path, moves);
    const folders = moves.filter((move) => move.folder);
    const mapAbsent = (path: string) => movedPath(path, folders);
    for (const [id, deleted] of this.#deleted) {
      this.#deleted.set(id, { ...deleted, path: mapAbsent(deleted.path) });
    }
    for (const [id, task] of this.#deletedTasks) {
      this.#deletedTasks.set(id, { ...task, path: map(task.path) });
    }
    for (const [id, undo] of this.#moveUndos) {
      if (undo.kind === "task") {
        this.#moveUndos.set(id, { ...undo, source: map(undo.source), target: map(undo.target) });
      } else if (undo.kind === "note") {
        this.#moveUndos.set(id, { ...undo, from: mapAbsent(undo.from), to: map(undo.to) });
      } else {
        // The folder itself moved: the undo moves it back from where it is
        // now. Its old place is a top-level name that moves with nothing.
        const to = moves.reduce((key, move) => (key === move.from ? move.to : key), undo.to);
        this.#moveUndos.set(id, { ...undo, to: map(to) });
      }
    }
    for (const [id, action] of this.#toastActions) {
      const path = action.exists ? map(action.path) : mapAbsent(action.path);
      this.#toastActions.set(id, { ...action, path });
    }
  }

  /**
   * Rewrites links in every task list that point at files `moves` moved, or
   * that leave a list `moves` moved. Lists not read yet are read first, so
   * none is missed; each list changes through its session like any task
   * edit. Lists that cannot be read or changed are named in one toast.
   */
  async #retargetAll(moves: readonly PathMove[]): Promise<void> {
    const generation = this.#generation;
    const failed = await this.#readTaskLists();
    if (generation !== this.#generation) return;
    const back = reverseMoves(moves);
    for (const path of this.#tasks.paths()) {
      if (failed.includes(path)) continue;
      const before = movedPath(path, back);
      const current = this.#currentTasks(path);
      if (!current || retargetLinks(current.text, before, moves, path) === null) continue;
      const result = this.#editTasks(path, null, (doc) => {
        const edits = retargetLinks(doc.text, before, moves, path);
        return edits ? { text: edits.text, focus: null } : null;
      });
      if (result) this.#followLinkEdit(path, current, result.text);
      else failed.push(path);
    }
    if (failed.length > 0) this.#toast(linksNotUpdatedMessage(failed.sort()));
  }

  /**
   * Reads every task list of the workspace that is not known yet (or only
   * as an unsaved text without a session). Returns the lists that cannot
   * be read: too large or unreadable.
   */
  async #readTaskLists(): Promise<string[]> {
    const generation = this.#generation;
    const unknown = (path: string) =>
      !this.#sessions.has(path) && (this.#tasks.get(path)?.hash ?? null) === null;
    const failed: string[] = [];
    const reads: Promise<void>[] = [];
    for (const [path, entry] of this.#index) {
      if (!isTaskListPath(path) || !unknown(path)) continue;
      if (entry.size > MAX_SUMMARY_BYTES) {
        failed.push(path);
        continue;
      }
      reads.push(
        this.#storage.readFile(path).then(
          (file) => {
            if (generation !== this.#generation || !this.#index.has(path) || !unknown(path)) return;
            const doc = this.#tasks.set(path, file.contents, file.hash);
            this.#setSummary(path, file.contents, doc);
            this.#tasksChanged = true;
          },
          () => void failed.push(path),
        ),
      );
    }
    await Promise.all(reads);
    if (reads.length > 0) this.#schedulePublish();
    return failed;
  }

  /** Keeps task move undos able to find a moved task whose line a link update changed. */
  #followLinkEdit(path: string, before: TaskDocument, text: string): void {
    const after = taskOps.splitLines(text);
    for (const [id, undo] of this.#moveUndos) {
      if (undo.kind !== "task" || undo.target !== path) continue;
      const line = taskOps.locateTask(before, undo.inserted);
      const raw = line === null ? undefined : after[line]?.text;
      if (line === null || raw === undefined || raw === undo.inserted.raw) continue;
      this.#moveUndos.set(id, { ...undo, inserted: { line, raw } });
    }
  }

  /** Commits pending changes and syncs now, lifting stops and retry delays. */
  syncNow(): void {
    this.#scheduler?.syncNow();
  }

  /** Checks whether git is installed, for the start screen. */
  async checkGit(): Promise<void> {
    try {
      this.gitInfo = await this.#storage.gitVersion();
    } catch {
      // Unknown; the start screen leaves the git line out.
      this.gitInfo = null;
    }
  }

  /** Asks for a folder without opening it, e.g. where to create or clone a workspace. */
  async pickFolder(): Promise<PickedFolder> {
    try {
      const path = await this.#storage.pickWorkspaceFolder();
      return path === null ? { kind: "cancelled" } : { kind: "picked", path };
    } catch (error) {
      return { kind: "failed", message: toStorageError(error).message };
    }
  }

  /**
   * Creates a new workspace in `<parent>/<name>` (a new or empty folder):
   * the inbox, the workspace config, the git setup files and a repository
   * when git is available. Then opens it.
   */
  async createWorkspace(parent: string, name: string): Promise<NewWorkspaceOutcome> {
    if (parent === "") return { kind: "invalid", message: CHOOSE_FOLDER };
    const problem = folderNameProblem(name);
    if (problem !== null) return { kind: "invalid", message: problem };
    let created: ScaffoldResult;
    try {
      created = await this.#storage.scaffoldWorkspace(joinPath(parent, name));
    } catch (error) {
      return { kind: "invalid", message: toStorageError(error).message };
    }
    await this.openWorkspace(created.root);
    // The files are there; git can be set up later, so this never blocks.
    if (created.gitError !== null) this.#toast(gitSetupFailedMessage(created.gitError));
    return { kind: "opened" };
  }

  /** Clones `url` into `<parent>/<name>` and opens it. */
  async cloneWorkspace(url: string, parent: string, name: string): Promise<NewWorkspaceOutcome> {
    const trimmed = url.trim();
    if (trimmed === "") return { kind: "invalid", message: ENTER_URL };
    if (parent === "") return { kind: "invalid", message: CHOOSE_FOLDER };
    const problem = folderNameProblem(name);
    if (problem !== null) return { kind: "invalid", message: problem };
    this.#cloneCancelled = false;
    let root: string;
    try {
      root = (await this.#storage.cloneRepository(trimmed, parent, name)).root;
    } catch (error) {
      const storageError = toStorageError(error);
      if (this.#cloneCancelled || storageError.kind === "Cancelled") return { kind: "cancelled" };
      return { kind: "invalid", message: storageError.message };
    }
    await this.openWorkspace(root);
    return { kind: "opened" };
  }

  /** Stops a running clone. */
  async cancelClone(): Promise<void> {
    this.#cloneCancelled = true;
    try {
      await this.#storage.cancelClone();
    } catch {
      // The clone ends on its own; it is reported as it ends.
    }
  }

  /** Forgets a recent workspace. */
  removeRecentWorkspace(path: string): void {
    this.#updateSettings((settings) => withoutRecentWorkspace(settings, path));
    if (this.missingWorkspaces.has(path)) {
      this.missingWorkspaces = withoutPath(this.missingWorkspaces, path);
    }
  }

  /**
   * Adds the missing `.gitattributes` and `.gitignore` lines to the open
   * workspace; the next automatic commit picks them up.
   */
  async setUpWorkspace(): Promise<void> {
    if (this.phase.kind !== "ready") return;
    const generation = this.#generation;
    let changed: string[];
    try {
      const result = await this.#storage.ensureWorkspaceFiles();
      changed = [...result.created, ...result.updated];
    } catch (error) {
      if (generation === this.#generation) {
        this.#toast(setupFailedMessage(toStorageError(error).message));
      }
      return;
    }
    if (generation !== this.#generation) return;
    this.setupMissing = [];
    this.#toast(setupDoneMessage(changed));
    // The watcher does not report these files.
    if (changed.length > 0) this.#scheduler?.changed();
  }

  /** Hides the setup banner of the open workspace for good. */
  dismissSetup(): void {
    if (this.phase.kind !== "ready") return;
    const root = this.phase.root;
    this.#updateSettings((settings) => withDismissedSetup(settings, root));
  }

  /** Turns automatic committing and syncing on or off. */
  setAutoSync(on: boolean): void {
    if (on === this.settings.autoSync) return;
    this.#updateSettings((settings) => ({ ...settings, autoSync: on }));
    this.#scheduler?.setAuto(on);
  }

  /** Sets the editor and task view text size, kept within the allowed range. */
  setEditorFontSize(size: number): void {
    if (!Number.isFinite(size)) return;
    const clamped = Math.min(
      EDITOR_FONT_SIZE_MAX,
      Math.max(EDITOR_FONT_SIZE_MIN, Math.round(size)),
    );
    if (clamped === this.settings.editorFontSize) return;
    this.#updateSettings((settings) => ({ ...settings, editorFontSize: clamped }));
  }

  /**
   * Replaces the quick capture shortcut (`null` turns it off). It is saved
   * only once registered; otherwise the old one stays and the reason is
   * returned.
   */
  async setCaptureShortcut(accelerator: string | null): Promise<string | null> {
    const host = this.#captureHost;
    if (!host) return CAPTURE_UNAVAILABLE;
    const work = this.#shortcutWork.then(async (): Promise<string | null> => {
      let change: ShortcutChange;
      try {
        change = await host.setShortcut(accelerator);
      } catch (error) {
        return toStorageError(error).message;
      }
      // On failure the previous shortcut stays registered and the settings unchanged.
      if (!shortcutApplied(change, accelerator)) return SHORTCUT_IN_USE;
      this.captureShortcut = toStatus(change);
      this.#updateSettings((settings) => ({ ...settings, captureShortcut: accelerator }));
      return null;
    });
    this.#shortcutWork = work.catch(() => undefined);
    return work;
  }

  /** The window got focus: refresh the git status and sync if it has been a while. */
  windowFocused(): void {
    this.#scheduler?.focus();
  }

  /** Resolves when no git operation is running. */
  syncIdle(): Promise<void> {
    return this.#scheduler?.idle() ?? Promise.resolve();
  }

  /** Shows a short message. */
  notify(message: string): void {
    this.#toast(message);
  }

  dismissToast(id: number): void {
    this.#deleted.delete(id);
    this.#toastActions.delete(id);
    this.#deletedTasks.delete(id);
    this.#moveUndos.delete(id);
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
    this.#stopSettingsWatch?.();
    this.#stopSettingsWatch = null;
    void this.#stopSync();
    void this.#closeSessions();
  }

  /** Starts committing and syncing the workspace loaded as `generation`. */
  #startSync(generation: number): void {
    if (generation !== this.#generation || this.#disposed || this.#scheduler) return;
    const storage = this.#storage;
    const scheduler: SyncScheduler = new SyncScheduler({
      io: {
        status: () => gitOutcome(() => storage.gitStatus()),
        commit: (message) => gitOutcome(() => storage.gitCommit(message)),
        sync: () => gitOutcome(() => storage.gitSync()),
        flush: () => this.#withTimeout(this.flush()),
        message: (changed) => {
          const onDisk = listingLookup(this.#files.map((file) => file.path));
          return commitMessage(this.#hints.describe(changed, onDisk));
        },
      },
      timers: this.#timers,
      ...this.#syncOptions,
      auto: this.settings.autoSync,
      events: {
        changed: (snapshot) => {
          if (this.#scheduler === scheduler) this.sync = snapshot;
        },
        committed: (result: CommitResult) => {
          if (this.#scheduler === scheduler) this.#hints.committed(result.paths);
        },
        synced: (result: SyncResult) => {
          if (this.#scheduler !== scheduler || result.conflicts.length === 0) return;
          this.#toast(conflictsKeptMessage(result.conflicts.map((conflict) => conflict.copy)));
        },
      },
    });
    this.#scheduler = scheduler;
    this.sync = scheduler.snapshot;
    scheduler.start();
  }

  /** Stops the scheduler; resolves when its running git operation is done. */
  #stopSync(): Promise<void> {
    const scheduler = this.#scheduler;
    this.#scheduler = null;
    this.sync = null;
    return scheduler?.stop() ?? Promise.resolve();
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
    const { hash } = written;
    const entry = this.#addCreated(written, contents);
    const path = entry.path;

    this.#leave(path);
    // A session left from a note deleted at this path is replaced.
    this.#sessions.get(path)?.dispose();
    const session = this.#createSession(path, { contents, hash }, entry.modified);
    this.#sessions.set(path, session);
    // Drop reads still in flight for the previous selection.
    this.#documentRequest += 1;
    this.folder = folder;
    this.item = path;
    this.#search.touch(path);
    this.taskTextMode = false;
    this.document = { status: "ready", path, text: contents, modified: entry.modified };
    this.saveStatus = session.status;
  }

  /** Adds a file this app just created to the model and its summary, without opening it. */
  #addCreated(written: WrittenFile, contents: string): FileEntry {
    const entry: FileEntry = { path: written.path, size: written.size, modified: written.modified };
    const path = entry.path;
    this.#files = [...this.#files.filter((file) => file.path !== path), entry];
    this.workspace = buildWorkspace(this.#files, this.#config);
    this.#setSummary(path, contents);
    this.#schedulePublish();
    return entry;
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
    this.#setSummary(path, text, doc);
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
    // Its folder is moving: edits wait and are saved where the list ends up.
    const moved = this.#moveOf(path);
    if (moved) void session.exclusive(() => moved).catch(() => undefined);
    return session;
  }

  /** Puts a task list session's buffer into the index and the summaries. */
  #syncTasks(session: SaveSession): void {
    const path = session.path;
    if (!isTaskListPath(path) || !this.#index.has(path)) return;
    const text = session.text;
    const doc = this.#tasks.set(path, text, session.dirty ? null : session.hash);
    this.#setSummary(path, text, doc);
    this.#tasksChanged = true;
  }

  /** Publishes task lists and summaries now, for edits that must show at once. */
  #publishTasks(): void {
    this.#tasksChanged = true;
    this.#publishPending = true;
    this.#publish();
  }

  /** Shows a task list as tasks, focusing its first open task (or the new task input). */
  #openList(path: string): void {
    const role = classifyPath(path, createPathFilter(this.#config));
    if (role?.kind !== "tasks" || role.archived || !this.#index.has(path)) return;
    this.folder = role.project;
    this.selectItem(path);
    this.setTaskTextMode(false);
    this.#focusFirstTask(path);
  }

  /** Shows a task in its list and focuses it, showing done tasks if it is done. */
  #openTask(path: string, line: number, raw: string): void {
    const role = classifyPath(path, createPathFilter(this.#config));
    if (role?.kind !== "tasks" || role.archived || !this.#index.has(path)) return;
    this.folder = role.project;
    this.selectItem(path);
    this.setTaskTextMode(false);
    const doc = this.#currentTasks(path);
    const at = doc ? taskOps.locateTask(doc, { line, raw }) : line;
    if (at === null) {
      this.#toast(TASK_CHANGED);
      return;
    }
    const task = doc ? taskOps.taskAt(doc, at) : null;
    if (task?.done && this.hideDone.has(path)) this.toggleHideDone(path);
    this.#requestTaskFocus(path, at);
  }

  /** Selects a project and shows its task list, if it has one. */
  #openProject(name: string): void {
    if (!findProject(this.workspace, name)) return;
    this.#select(name);
    if (isTaskListPath(this.item)) this.#focusFirstTask(this.item);
  }

  #focusFirstTask(path: string): void {
    const doc = this.#currentTasks(path);
    const first = doc?.blocks.find((block) => !block.done) ?? doc?.blocks[0];
    this.#requestTaskFocus(path, first ? first.line : null);
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
    this.#search.renameNote(from, to);
    if (session) {
      this.#setSummary(to, session.text);
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
    this.#search.removeNote(path);
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
      ...this.#moveUndos.keys(),
    ]);
    if (ids.size === 0) return;
    this.#deleted.clear();
    this.#deletedTasks.clear();
    this.#moveUndos.clear();
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

  /**
   * Saves before the window closes; keeps it open once if something could
   * not be saved. No git operation starts meanwhile, and a running one is
   * awaited (within the close timeout).
   */
  async #confirmClose(): Promise<boolean> {
    const scheduler = this.#scheduler;
    const gitIdle = scheduler?.suspend() ?? Promise.resolve();
    // Saves of a previous workspace count as well.
    await this.#withTimeout(Promise.all([this.flush(), this.#closing, gitIdle]));
    const unsaved = this.#unsaved([...this.#sessions.values(), ...this.#closingSessions]);
    const close = this.#allow("close", unsaved, UNSAVED_ON_CLOSE);
    if (close) {
      if (this.#scheduler === scheduler) void this.#stopSync();
    } else {
      scheduler?.resume();
    }
    return close;
  }

  /**
   * Paths of sessions that still have edits to save. A session that is busy
   * without edits (e.g. checking a change reported on disk) has none.
   */
  #unsaved(sessions: Iterable<SaveSession>): string[] {
    const paths: string[] = [];
    for (const session of sessions) {
      if (session.dirty && !paths.includes(session.path)) paths.push(session.path);
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
    else this.#setSummary(path, contents, undefined, true);
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
    this.#configWarnings = loaded.warnings;
    this.warnings = [...this.#settingsWarnings, ...loaded.warnings];
  }

  #rememberWorkspace(root: string): void {
    if (this.missingWorkspaces.has(root)) {
      this.missingWorkspaces = withoutPath(this.missingWorkspaces, root);
    }
    if (isOpenedWorkspace(this.deviceSettings, root)) return;
    this.#updateSettings((settings) => withOpenedWorkspace(settings, root), SETTINGS_NOT_SAVED);
  }

  /**
   * Applies a change to the device settings and saves it in the background,
   * one write at a time. A file that must not be overwritten is left alone
   * with a warning (`notSaved`), shown once.
   */
  #updateSettings(patch: SettingsPatch, notSaved = SETTINGS_CHANGES_NOT_SAVED): void {
    this.deviceSettings = patch(this.deviceSettings);
    if (!this.#settingsFile.writable) {
      this.#warnNotSaved(notSaved);
      return;
    }
    this.#pendingSettings.push(patch);
    // Saving settings must never hold up the UI.
    this.#queueSettingsWork(async () => {
      try {
        await this.#saveSettings(patch, notSaved);
      } finally {
        this.#pendingSettings = this.#pendingSettings.filter((pending) => pending !== patch);
      }
    });
  }

  #queueSettingsWork(work: () => Promise<void>): void {
    this.#settingsWork = this.#settingsWork.then(work).catch((error: unknown) => {
      const message = `settings.json: ${toStorageError(error).message}`;
      this.warnings = withWarnings(this.warnings, [{ field: "", message }]);
    });
  }

  #warnNotSaved(notSaved: string): void {
    if (this.#settingsWarnings.some((warning) => warning.message === notSaved)) return;
    const warning = { field: "", message: notSaved };
    this.#settingsWarnings = [...this.#settingsWarnings, warning];
    this.warnings = [...this.warnings, warning];
  }

  /**
   * Writes `patch` on top of the file as last read. When the file changed
   * since then, it is read and applied again and the patch retried on top
   * of it, so changes made by another program are never overwritten.
   */
  async #saveSettings(patch: SettingsPatch, notSaved: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const file = this.#settingsFile;
      if (!file.writable) {
        this.#warnNotSaved(notSaved);
        return;
      }
      const text = serializeSettings(patch(file.value), file);
      try {
        await this.#storage.writeSettings(text);
      } catch (error) {
        if (!isStorageError(toStorageError(error), "Conflict")) throw error;
        if (attempt >= SETTINGS_WRITE_RETRIES) {
          this.#toast(SETTINGS_KEEP_CHANGING);
          return;
        }
        // Without a fresh read the next attempt would fail the same way.
        if (!(await this.#readSettingsAgain())) return;
        continue;
      }
      this.#settingsText = text;
      this.#settingsFile = parseSettings(text);
      return;
    }
  }

  /** Resolves when every settings write issued so far is done. */
  settingsSaved(): Promise<void> {
    return this.#settingsWork;
  }

  #watchSettings(): void {
    if (this.#stopSettingsWatch) return;
    this.#storage
      .watchSettings(() => {
        if (this.#disposed || !this.#settingsLoaded) return;
        this.#queueSettingsWork(async () => {
          if (!this.#disposed) await this.#readSettingsAgain();
        });
      })
      .then((stop) => {
        if (this.#disposed) stop();
        else this.#stopSettingsWatch = stop;
      })
      // Without the hook, edits to the file apply on the next start.
      .catch(() => undefined);
  }

  /**
   * Reads the settings file again after another program changed it, and
   * applies it. Returns whether it could be read.
   */
  async #readSettingsAgain(): Promise<boolean> {
    let text: string | null;
    try {
      text = await this.#storage.readSettings();
    } catch (error) {
      const message = `settings.json: ${toStorageError(error).message}`;
      this.warnings = withWarnings(this.warnings, [{ field: "", message }]);
      return false;
    }
    if (this.#disposed) return false;
    if (text === this.#settingsText) return true;
    this.#settingsText = text;
    const before = this.#settingsWarnings.map((warning) => warning.message);
    const previous = this.settings;
    const reloaded = reloadSettings(this.deviceSettings, text);
    this.#settingsFile = reloaded.file;
    // A file that cannot be used changes nothing: its warning joins the current ones.
    this.#settingsWarnings = reloaded.file.writable
      ? reloaded.warnings
      : withWarnings(this.#settingsWarnings, reloaded.warnings);
    // Changes not written yet stay applied; they are written on top of this file.
    this.deviceSettings = this.#pendingSettings.reduce(
      (settings, patch) => patch(settings),
      reloaded.value,
    );
    this.warnings = [...this.#settingsWarnings, ...this.#configWarnings];
    if (this.#settingsWarnings.some((warning) => !before.includes(warning.message))) {
      this.#toast(SETTINGS_CHANGED_INVALID);
    }
    const next = this.settings;
    if (next.autoSync !== previous.autoSync) this.#scheduler?.setAuto(next.autoSync);
    if (!sameAccelerator(next.captureShortcut, previous.captureShortcut)) {
      void this.#syncCaptureShortcut(false);
    }
    if (this.phase.kind === "ready") {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced, never mutated
      this.hideDone = new Set(this.#hideDoneKeys(this.phase.root));
    }
    return true;
  }

  /** The lists of `root` with done tasks hidden, as remembered (`ALL_TASKS` for All tasks). */
  #hideDoneKeys(root: string): string[] {
    return hideDoneOf(this.deviceSettings, root).map((key) =>
      key === ALL_TASKS_KEY ? ALL_TASKS : key,
    );
  }

  /**
   * Makes the registered capture shortcut match the settings: asks what is
   * registered and changes it when it differs. Says so when the shortcut
   * cannot be registered; `initial` checks only run once both the settings
   * and the capture host are there.
   */
  #syncCaptureShortcut(initial: boolean): Promise<unknown> {
    const host = this.#captureHost;
    if (!host || !this.#settingsLoaded) return Promise.resolve();
    const work = this.#shortcutWork.then(async () => {
      if (host !== this.#captureHost || this.#disposed) return;
      const desired = this.settings.captureShortcut;
      let status: ShortcutStatus;
      let registered: boolean;
      try {
        status = await host.shortcutStatus();
        registered = status.registered && sameAccelerator(status.shortcut, desired);
        if (!sameAccelerator(status.shortcut, desired)) {
          const change = await host.setShortcut(desired);
          // On failure the previous shortcut stays registered.
          if (shortcutApplied(change, desired)) status = toStatus(change);
          registered = desired !== null && change.registered;
        }
      } catch {
        // An older backend or no capture support: the app works on without it.
        return;
      }
      if (host !== this.#captureHost || this.#disposed) return;
      this.captureShortcut = status;
      if (desired !== null && !registered) this.#toast(initial ? SHORTCUT_TAKEN : SHORTCUT_IN_USE);
    });
    this.#shortcutWork = work.catch(() => undefined);
    return work;
  }

  /** Whether the setup files of the open workspace lack lines; never changes anything. */
  async #checkSetup(generation: number): Promise<void> {
    let missing: string[];
    try {
      missing = (await this.#storage.workspaceSetupStatus()).missing;
    } catch {
      // Unknown: offer nothing rather than something wrong.
      return;
    }
    if (generation === this.#generation) this.setupMissing = missing;
  }

  async #loadDocument(path: string, generation: number): Promise<void> {
    const request = ++this.#documentRequest;
    if (this.document?.path !== path) this.document = { status: "loading", path };
    const current = () =>
      generation === this.#generation && request === this.#documentRequest && this.item === path;
    const moved = this.#moveOf(path);
    if (moved) {
      // Read where the file is once its folder moved (the move reloads it there).
      await moved;
      if (!current()) return;
    }
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
        this.#setSummary(path, file.contents, doc);
        this.#publishTasks();
      } else {
        this.#setSummary(path, file.contents);
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
      if (this.#searchable(path)) this.#search.upsertNote(path, null);
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
      this.#setSummary(path, file.contents, doc);
      this.#tasksChanged = true;
    } else {
      this.#setSummary(path, file.contents);
    }
    this.#schedulePublish();
  }

  /**
   * Sets a file's list summary and, for a note, indexes its text for search,
   * right away or (`later`) when the app is idle.
   */
  #setSummary(path: string, text: string, doc?: TaskDocument, later = false): void {
    this.#store.set(path, summarizeFile(path, text, doc));
    if (isTaskListPath(path) || !this.#searchable(path)) return;
    if (!later) this.#search.upsertNote(path, text);
    else if (this.#search.queueNote(path, text)) {
      this.#idle(() => {
        if (this.#search.queuedCount === 0) return;
        this.#search.flushQueued();
        this.searchRevision += 1;
      });
    }
  }

  /** Archived projects are not searched. */
  #searchable(path: string): boolean {
    return !path.startsWith(`${ARCHIVE_DIR}/`);
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
    this.searchRevision += 1;
    if (this.#tasksChanged) {
      this.#tasksChanged = false;
      this.taskDocs = this.#tasks.view();
      this.#search.syncTaskLists(this.taskDocs, (path) => this.#searchable(path));
    }
  }

  #onChange(event: ChangeEvent, generation: number): void {
    // The app's own writes are reported too; both restart the commit delay.
    if (generation === this.#generation) this.#scheduler?.changed();
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
    this.#search.retainNotes((path) => shown.has(path));
    if (this.#tasks.retain((path) => shown.has(path))) {
      this.#tasksChanged = true;
      this.#schedulePublish();
    }

    if (this.folder !== ALL_TASKS && !findProjectByKey(this.workspace, this.folder)) {
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
