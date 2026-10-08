/**
 * The workspace model: which files are projects, task lists and notes.
 *
 * Rules:
 * - A project is a top-level folder. `inbox` always exists, even when the
 *   folder does not.
 * - `<project>/tasks.md` is the project's task list. `tasks.md` anywhere else
 *   is an ordinary note.
 * - Any other `.md` file inside a project is a note, including files in
 *   subfolders, which keep their path relative to the project (`api/auth.md`).
 * - Loose `.md` files at the workspace root belong to `inbox`.
 * - Folders inside `_archive/` are archived projects, built with the same
 *   rules. Loose files directly in `_archive/` are not shown.
 * - Names starting with `.` and `node_modules` are ignored at any depth, as
 *   are paths matching the workspace ignore patterns.
 * - Only files ending in `.md` (any case) count; everything else is ignored.
 */

import { createIgnoreMatcher, type PathMatcher } from "./glob";

/** File metadata, as listed by storage. Paths are workspace-relative and `/`-separated. */
export interface FileEntry {
  path: string;
  size: number;
  /** Last modification time in milliseconds since the Unix epoch. */
  modified: number;
}

export interface NoteEntry extends FileEntry {
  /** Path relative to the project folder, e.g. `api/auth.md`. */
  name: string;
}

export interface Project {
  /** Folder name; `inbox` for the default project. */
  name: string;
  /** The project's `tasks.md`, or `null` if it has none yet. */
  tasks: FileEntry | null;
  /** Notes sorted by `name`. */
  notes: NoteEntry[];
}

export interface Workspace {
  /** `inbox` first, then the other projects by name. */
  projects: Project[];
  /** Projects inside `_archive/`, by name. */
  archived: Project[];
}

export interface WorkspaceOptions {
  /** Extra ignore patterns from the workspace configuration. */
  ignore: readonly string[];
}

export const INBOX = "inbox";
export const ARCHIVE_DIR = "_archive";
export const TASKS_FILE = "tasks.md";
/** Workspace-relative location of the workspace configuration file. */
export const WORKSPACE_CONFIG_PATH = ".kaido/config.json";

export type PathRole =
  | { kind: "tasks"; project: string; archived: boolean }
  | { kind: "note"; project: string; archived: boolean; name: string };

const MARKDOWN = /\.md$/i;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Locale-aware, case-insensitive order with a stable tie-break. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function isHidden(segment: string): boolean {
  return segment === "" || segment.startsWith(".") || segment === "node_modules";
}

/** Builds the ignore check used by `classifyPath`. */
export function createPathFilter(options: WorkspaceOptions): PathMatcher {
  return createIgnoreMatcher(options.ignore);
}

/** Classifies a workspace-relative path, or returns `null` if it is not shown. */
export function classifyPath(path: string, isIgnored: PathMatcher): PathRole | null {
  if (!MARKDOWN.test(path)) return null;
  const segments = path.split("/");
  if (segments.some(isHidden) || isIgnored(path)) return null;

  let archived = false;
  let rest = segments;
  if (segments[0] === ARCHIVE_DIR) {
    // Loose files directly in `_archive/` have no project.
    if (segments.length < 3) return null;
    archived = true;
    rest = segments.slice(1);
  }

  const [first = "", ...inside] = rest;
  if (inside.length === 0) {
    // A loose file at the workspace root.
    return { kind: "note", project: INBOX, archived, name: first };
  }
  const name = inside.join("/");
  if (name === TASKS_FILE) return { kind: "tasks", project: first, archived };
  return { kind: "note", project: first, archived, name };
}

const ACCEPT_ALL: PathMatcher = () => false;

/** Whether the path is a project's task list (`<project>/tasks.md`, archived or not). */
export function isTaskListPath(path: string): boolean {
  return classifyPath(path, ACCEPT_ALL)?.kind === "tasks";
}

function emptyProject(name: string): Project {
  return { name, tasks: null, notes: [] };
}

function sortProjects(projects: Map<string, Project>): Project[] {
  const list = [...projects.values()];
  for (const project of list) project.notes.sort((a, b) => compareNames(a.name, b.name));
  return list.sort((a, b) => compareNames(a.name, b.name));
}

/** Builds the workspace model from a file listing. Pure and order-independent. */
export function buildWorkspace(files: readonly FileEntry[], options: WorkspaceOptions): Workspace {
  const isIgnored = createPathFilter(options);
  const active = new Map<string, Project>([[INBOX, emptyProject(INBOX)]]);
  const archived = new Map<string, Project>();

  for (const file of files) {
    const role = classifyPath(file.path, isIgnored);
    if (!role) continue;
    const projects = role.archived ? archived : active;
    let project = projects.get(role.project);
    if (!project) {
      project = emptyProject(role.project);
      projects.set(role.project, project);
    }
    if (role.kind === "tasks") project.tasks = file;
    else project.notes.push({ ...file, name: role.name });
  }

  const inbox = active.get(INBOX) ?? emptyProject(INBOX);
  active.delete(INBOX);
  return { projects: [inbox, ...sortProjects(active)], archived: sortProjects(archived) };
}

/** Every file shown in the workspace, keyed by path. */
export function workspaceFiles(workspace: Workspace): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>();
  for (const project of [...workspace.projects, ...workspace.archived]) {
    if (project.tasks) files.set(project.tasks.path, project.tasks);
    for (const note of project.notes) files.set(note.path, note);
  }
  return files;
}

export function findProject(workspace: Workspace, name: string): Project | undefined {
  return workspace.projects.find((project) => project.name === name);
}

/** Payload of a filesystem change notification. */
export interface ChangeEvent {
  /** Changed, created or removed paths. */
  paths: readonly string[];
  /** Fresh metadata for every path in `paths` that still exists; the others were removed. */
  entries: readonly FileEntry[];
  /** The watcher lost track; only a new listing is reliable. */
  rescan: boolean;
}

/**
 * Whether storage lists this path: a Markdown file outside hidden folders
 * and `node_modules`. Archive and ignore rules are applied later, by
 * `classifyPath`.
 */
export function isListablePath(path: string): boolean {
  return MARKDOWN.test(path) && !path.split("/").some(isHidden);
}

/**
 * Whether storage may read or write this path: a listable note or the
 * workspace configuration file. Change notifications cover the same paths.
 */
export function isStoragePath(path: string): boolean {
  return isListablePath(path) || path === WORKSPACE_CONFIG_PATH;
}

export interface ChangeResult {
  /** The listing with the change applied. */
  files: FileEntry[];
  /** Paths that are new or whose size or modification time changed. */
  updated: string[];
  /** Paths that were listed before and are gone now. */
  removed: string[];
}

/**
 * Applies a change notification to a file listing using the fresh metadata
 * it carries, so no new listing is needed. Entries with unchanged metadata,
 * such as echoes of the app's own writes, are not reported as updated.
 * Paths that a listing would not include are skipped.
 */
export function applyChange(files: readonly FileEntry[], event: ChangeEvent): ChangeResult {
  const next = new Map(files.map((file) => [file.path, file]));
  const fresh = new Map(event.entries.map((entry) => [entry.path, entry]));
  const result: ChangeResult = { files: [], updated: [], removed: [] };
  for (const path of new Set(event.paths)) {
    if (!isListablePath(path)) continue;
    const old = next.get(path);
    const entry = fresh.get(path);
    if (entry) {
      if (!old || old.size !== entry.size || old.modified !== entry.modified) {
        result.updated.push(path);
      }
      next.set(path, entry);
    } else if (old) {
      next.delete(path);
      result.removed.push(path);
    }
  }
  result.files = [...next.values()];
  return result;
}

export interface FileDiff {
  added: string[];
  removed: string[];
  /** Present in both listings with a different size or modification time. */
  changed: string[];
}

/** Compares two listings by path, size and modification time. */
export function diffFiles(before: readonly FileEntry[], after: readonly FileEntry[]): FileDiff {
  const previous = new Map(before.map((file) => [file.path, file]));
  const diff: FileDiff = { added: [], removed: [], changed: [] };
  for (const file of after) {
    const old = previous.get(file.path);
    if (!old) diff.added.push(file.path);
    else if (old.size !== file.size || old.modified !== file.modified) diff.changed.push(file.path);
    previous.delete(file.path);
  }
  diff.removed = [...previous.keys()];
  return diff;
}
