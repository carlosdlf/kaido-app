/**
 * Parsed task lists of the whole workspace, for the All tasks view and the
 * open task counts.
 *
 * Each entry keeps the parsed text and the hash of the disk version it
 * matches, or `null` while the text has edits that are not saved yet. A
 * list is parsed once per change of its own text, never the whole workspace.
 */

import { parseTaskDocument, type TaskDocument } from "./taskDocument";
import type { TaskGroup } from "./taskRows";
import type { Workspace } from "./workspace";

export interface IndexedTasks {
  doc: TaskDocument;
  /** Hash of the disk version equal to `doc.text`, or `null` if unsaved edits differ from it. */
  hash: string | null;
}

export type TaskDocs = ReadonlyMap<string, TaskDocument>;

export const NO_TASK_DOCS: TaskDocs = new Map();

export class TaskIndex {
  readonly #entries = new Map<string, IndexedTasks>();

  get size(): number {
    return this.#entries.size;
  }

  get(path: string): IndexedTasks | undefined {
    return this.#entries.get(path);
  }

  /** Sets the text of a list; unchanged text is not parsed again. Returns the model. */
  set(path: string, text: string, hash: string | null): TaskDocument {
    const current = this.#entries.get(path)?.doc;
    const doc = current?.text === text ? current : parseTaskDocument(text);
    this.#entries.set(path, { doc, hash });
    return doc;
  }

  delete(path: string): boolean {
    return this.#entries.delete(path);
  }

  /** Removes every path for which `keep` returns false; returns whether anything was removed. */
  retain(keep: (path: string) => boolean): boolean {
    let removed = false;
    for (const path of [...this.#entries.keys()]) {
      if (!keep(path)) removed = this.#entries.delete(path) || removed;
    }
    return removed;
  }

  clear(): void {
    this.#entries.clear();
  }

  /** A snapshot of the parsed lists by path. */
  view(): TaskDocs {
    const docs = new Map<string, TaskDocument>();
    for (const [path, entry] of this.#entries) docs.set(path, entry.doc);
    return docs;
  }
}

/**
 * The task lists of active projects that have been read: the inbox first,
 * then the other projects in sidebar order. Archived projects are left out.
 */
export function taskGroups(workspace: Workspace, docs: TaskDocs): TaskGroup[] {
  const groups: TaskGroup[] = [];
  for (const project of workspace.projects) {
    const path = project.tasks?.path;
    const doc = path === undefined ? undefined : docs.get(path);
    if (path !== undefined && doc) groups.push({ project: project.name, path, doc });
  }
  return groups;
}
