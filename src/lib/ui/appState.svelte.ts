/**
 * Application state: opens the workspace, keeps the model in sync with the
 * file watcher, and loads note contents lazily.
 *
 * The first render only needs the file listing. Titles and task counts are
 * read in the background afterwards and published at most once per frame,
 * and a note's contents are read when it is selected.
 */

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
import { isStorageError, toStorageError, type Storage, type Unsubscribe } from "$lib/storage";

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

export interface AppStateOptions {
  /** Runs the initial background work after the first render. */
  defer?: (task: () => void) => void;
  /** Schedules publishing loaded summaries; called at most once per pending update. */
  schedule?: (task: () => void) => void;
  /** Files read in parallel while loading titles and counts. */
  concurrency?: number;
}

interface LoadedConfig {
  config: WorkspaceConfig;
  warnings: ConfigWarning[];
}

const EMPTY_WORKSPACE: Workspace = buildWorkspace([], { ignore: [] });

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

  readonly #storage: Storage;
  readonly #defer: (task: () => void) => void;
  readonly #schedule: (task: () => void) => void;
  readonly #concurrency: number;
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
  }

  /** Reads device settings and reopens the last workspace, if any. */
  async start(): Promise<void> {
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

  async openWorkspace(path: string): Promise<void> {
    const generation = ++this.#generation;
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
    this.item = path;
    void this.#loadDocument(path, this.#generation);
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

  /** Stops watching. The instance should not be used afterwards. */
  dispose(): void {
    this.#generation += 1;
    this.#queue.clear();
    this.#unwatch?.();
    this.#unwatch = null;
  }

  #select(folder: string): void {
    this.folder = folder;
    const first = this.#firstItem(folder);
    this.item = "";
    this.document = null;
    if (first !== null) this.selectItem(first);
  }

  #firstItem(folder: string): string | null {
    return listItems(this.workspace, folder, this.summaries)[0]?.id ?? null;
  }

  /** A missing file means defaults; an unreadable one adds a warning instead of failing. */
  async #readWorkspaceConfig(): Promise<LoadedConfig> {
    let text: string | null = null;
    const warnings: ConfigWarning[] = [];
    try {
      text = await this.#storage.readFile(WORKSPACE_CONFIG_PATH);
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
      const text = await this.#storage.readFile(path);
      if (!current()) return;
      const modified = this.#index.get(path)?.modified ?? 0;
      const shown = this.document;
      // Identical contents keep the same object, so nothing re-renders.
      if (
        shown?.status !== "ready" ||
        shown.path !== path ||
        shown.text !== text ||
        shown.modified !== modified
      ) {
        this.document = { status: "ready", path, text, modified };
      }
      this.#store.set(path, summarizeFile(path, text));
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
      text = await this.#storage.readFile(path);
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
      this.document = { status: "missing", path: this.item };
    } else if (!shown.has(this.item)) {
      // Hidden by a new ignore pattern.
      this.#select(this.folder);
    } else if (reloadOpen || updated.includes(this.item)) {
      void this.#loadDocument(this.item, generation);
    }

    this.#enqueue(pathsToSummarize(shown.keys(), updated, this.#store.view()), generation);
  }
}
