/** What the sidebar and list pane show for a workspace model. */

import { countOpenTasks, fileStem, noteTitle } from "./markdown";
import { INBOX, isTaskListPath, type Project, type Workspace } from "./workspace";

/** Sidebar entry that groups the task lists of every project. */
export const ALL_TASKS = "all-tasks";

/** Data read from a file's contents. Loaded in the background, so it may be missing. */
export interface FileSummary {
  title: string;
  openTasks: number;
}

export type Summaries = ReadonlyMap<string, FileSummary>;

export type ListItem =
  | {
      kind: "tasks";
      /** Workspace-relative path, used as a stable id. */
      id: string;
      label: string;
      /** `null` until the file has been read. */
      openCount: number | null;
    }
  | {
      kind: "note";
      id: string;
      /** Path relative to the project. */
      name: string;
      /** `null` until the file has been read. */
      title: string | null;
      modified: number;
    };

export interface SidebarEntry {
  name: string;
  /** Open tasks in the project's `tasks.md`; `null` while unknown. */
  openCount: number | null;
}

function openCount(project: Project, summaries: Summaries): number | null {
  if (!project.tasks) return 0;
  return summaries.get(project.tasks.path)?.openTasks ?? null;
}

export function sidebarEntries(workspace: Workspace, summaries: Summaries): SidebarEntry[] {
  return workspace.projects.map((project) => ({
    name: project.name,
    openCount: openCount(project, summaries),
  }));
}

/** Sum of open tasks, or `null` while any count is still unknown. */
export function totalOpen(entries: readonly SidebarEntry[]): number | null {
  let total = 0;
  for (const entry of entries) {
    if (entry.openCount === null) return null;
    total += entry.openCount;
  }
  return total;
}

function tasksItem(project: Project, label: string, summaries: Summaries): ListItem[] {
  if (!project.tasks) return [];
  return [
    { kind: "tasks", id: project.tasks.path, label, openCount: openCount(project, summaries) },
  ];
}

/** Items in the list pane: the task list first, then notes. */
export function listItems(
  workspace: Workspace,
  selection: string,
  summaries: Summaries,
): ListItem[] {
  if (selection === ALL_TASKS) {
    return workspace.projects
      .filter((project) => openCount(project, summaries) !== 0)
      .flatMap((project) => tasksItem(project, `${project.name}/tasks.md`, summaries));
  }
  const project = workspace.projects.find((candidate) => candidate.name === selection);
  if (!project) return [];
  return [
    ...tasksItem(project, "tasks.md", summaries),
    ...project.notes.map((note): ListItem => ({
      kind: "note",
      id: note.path,
      name: note.name,
      title: summaries.get(note.path)?.title ?? null,
      modified: note.modified,
    })),
  ];
}

export function listTitle(selection: string): string {
  if (selection === ALL_TASKS) return "all-tasks";
  return selection === INBOX ? "~/inbox" : `${selection}/`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function countLabel(count: number | null, word: string): string {
  return count === null ? `… ${word}s` : plural(count, word);
}

export function listSummary(workspace: Workspace, selection: string, summaries: Summaries): string {
  if (selection === ALL_TASKS) {
    const lists = listItems(workspace, ALL_TASKS, summaries).length;
    const open = totalOpen(sidebarEntries(workspace, summaries));
    return `${open ?? "…"} open · ${lists} ${lists === 1 ? "list" : "lists"}`;
  }
  const project = workspace.projects.find((candidate) => candidate.name === selection);
  if (!project) return "";
  return `${plural(project.notes.length, "note")} · ${countLabel(openCount(project, summaries), "task")}`;
}

/** Splits a workspace path into the folder part and the file name, for headers. */
export function splitPath(path: string): { folder: string; file: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { folder: "", file: path }
    : { folder: path.slice(0, slash + 1), file: path.slice(slash + 1) };
}

export const NO_SUMMARIES: Summaries = new Map();

/** Returns a new summary map with entries set and paths removed; the input is not changed. */
export function updateSummaries(
  summaries: Summaries,
  set: Iterable<readonly [string, FileSummary]>,
  removed: Iterable<string> = [],
): Summaries {
  const next = new Map(summaries);
  for (const [path, summary] of set) next.set(path, summary);
  for (const path of removed) next.delete(path);
  return next;
}

/** Shown files whose summary must be (re)read: updated ones and ones never read. */
export function pathsToSummarize(
  shown: Iterable<string>,
  updated: readonly string[],
  summaries: Summaries,
): string[] {
  const changed = new Set(updated);
  return [...shown].filter((path) => changed.has(path) || !summaries.has(path));
}

/** Files above this size are not read for list summaries. */
export const MAX_SUMMARY_BYTES = 1024 * 1024;

/** Title and open task count of a file. Tasks are only counted in task lists. */
export function summarizeFile(path: string, text: string): FileSummary {
  return {
    title: noteTitle(path, text),
    openTasks: isTaskListPath(path) ? countOpenTasks(text) : 0,
  };
}

/** Summary for a file that is too large to read for the list. */
export function fallbackSummary(path: string): FileSummary {
  return { title: fileStem(path), openTasks: 0 };
}

/** A read-only window onto a store's current contents. */
class SummaryView implements ReadonlyMap<string, FileSummary> {
  readonly #map: ReadonlyMap<string, FileSummary>;

  constructor(map: ReadonlyMap<string, FileSummary>) {
    this.#map = map;
  }

  get size(): number {
    return this.#map.size;
  }

  get(path: string): FileSummary | undefined {
    return this.#map.get(path);
  }

  has(path: string): boolean {
    return this.#map.has(path);
  }

  forEach(
    callback: (value: FileSummary, key: string, map: ReadonlyMap<string, FileSummary>) => void,
  ): void {
    this.#map.forEach((value, key) => callback(value, key, this));
  }

  entries(): MapIterator<[string, FileSummary]> {
    return this.#map.entries();
  }

  keys(): MapIterator<string> {
    return this.#map.keys();
  }

  values(): MapIterator<FileSummary> {
    return this.#map.values();
  }

  [Symbol.iterator](): MapIterator<[string, FileSummary]> {
    return this.#map[Symbol.iterator]();
  }
}

/**
 * Mutable summaries that are published as cheap views: `view()` returns a
 * new object over the same data, so a UI can notice changes without the
 * whole map being copied for every update.
 */
export class SummaryStore {
  readonly #map = new Map<string, FileSummary>();

  get size(): number {
    return this.#map.size;
  }

  has(path: string): boolean {
    return this.#map.has(path);
  }

  set(path: string, summary: FileSummary): void {
    this.#map.set(path, summary);
  }

  /** Removes every path for which `keep` returns false; returns whether anything was removed. */
  retain(keep: (path: string) => boolean): boolean {
    let removed = false;
    for (const path of [...this.#map.keys()]) {
      if (!keep(path)) removed = this.#map.delete(path) || removed;
    }
    return removed;
  }

  clear(): void {
    this.#map.clear();
  }

  view(): Summaries {
    return new SummaryView(this.#map);
  }
}

/**
 * A de-duplicated work queue of paths with a few priority levels. Rank 0 is
 * taken first. Adding a path that is already waiting does nothing.
 */
export class PathQueue {
  readonly #levels: string[][];
  readonly #heads: number[];
  readonly #waiting = new Set<string>();

  constructor(levels = 3) {
    this.#levels = Array.from({ length: levels }, () => []);
    this.#heads = Array.from({ length: levels }, () => 0);
  }

  get size(): number {
    return this.#waiting.size;
  }

  add(paths: Iterable<string>, rank: (path: string) => number): void {
    const last = this.#levels.length - 1;
    for (const path of paths) {
      if (this.#waiting.has(path)) continue;
      this.#waiting.add(path);
      this.#levels[Math.min(Math.max(rank(path), 0), last)]?.push(path);
    }
  }

  /** Removes and returns up to `count` paths, highest priority first. */
  take(count: number): string[] {
    const taken: string[] = [];
    for (let level = 0; level < this.#levels.length && taken.length < count; level += 1) {
      const queue = this.#levels[level] ?? [];
      let head = this.#heads[level] ?? 0;
      while (head < queue.length && taken.length < count) {
        const path = queue[head] ?? "";
        head += 1;
        if (this.#waiting.delete(path)) taken.push(path);
      }
      if (head === queue.length) {
        queue.length = 0;
        head = 0;
      }
      this.#heads[level] = head;
    }
    return taken;
  }

  /** Drops a waiting path. */
  delete(path: string): void {
    this.#waiting.delete(path);
  }

  clear(): void {
    this.#waiting.clear();
    for (const queue of this.#levels) queue.length = 0;
    this.#heads.fill(0);
  }
}
