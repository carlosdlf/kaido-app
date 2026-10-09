/** What the task views show for parsed task lists. */

import {
  openTaskCount,
  taskDetail,
  type TaskBlock,
  type TaskDocument,
  type TaskLine,
} from "./taskDocument";
import { linkedNote, withoutLink, type LinkedNote } from "./taskLinks";

/** A row of a task view. */
export type TaskRow =
  | { kind: "heading"; key: string; title: string; level: number }
  | { kind: "project"; key: string; project: string; path: string; count: number }
  | {
      kind: "task";
      key: string;
      path: string;
      line: number;
      /** The line as written, to find the task again if the text changes meanwhile. */
      raw: string;
      done: boolean;
      /** The task text as written, Markdown included. */
      text: string;
      /** What the row shows: the text without the linked note's link. */
      display: string;
      /** A subtask, shown indented one level whatever its depth. */
      nested: boolean;
      /** The task's detail text; `null` for subtasks, which have none. */
      detail: string | null;
      /** Done and total subtasks, for a task with subtasks. */
      progress: { done: number; total: number } | null;
      link: LinkedNote | null;
    };

export type TaskItemRow = Extract<TaskRow, { kind: "task" }>;

export interface RowOptions {
  /** Leave done tasks (and done subtasks) out. */
  hideDone: boolean;
  /** Whether a workspace path is an existing note, for linked notes. */
  exists: (path: string) => boolean;
}

function taskRow(
  path: string,
  task: TaskLine,
  options: RowOptions,
  block: { doc: TaskDocument; block: TaskBlock } | null,
): TaskItemRow {
  const link = linkedNote(task.text, path, options.exists);
  const subtasks = block?.block.subtasks ?? [];
  return {
    kind: "task",
    key: `${path}:${task.line}`,
    path,
    line: task.line,
    raw: task.raw,
    done: task.done,
    text: task.text,
    display: link ? withoutLink(task.text, link) : task.text,
    nested: block === null,
    detail: block ? taskDetail(block.doc, block.block) : null,
    progress:
      subtasks.length > 0
        ? { done: subtasks.filter((sub) => sub.done).length, total: subtasks.length }
        : null,
    link,
  };
}

function pushBlock(
  rows: TaskRow[],
  path: string,
  doc: TaskDocument,
  block: TaskBlock,
  options: RowOptions,
): void {
  rows.push(taskRow(path, block, options, { doc, block }));
  for (const task of block.subtasks) {
    if (!(options.hideDone && task.done)) rows.push(taskRow(path, task, options, null));
  }
}

function visible(block: TaskBlock, options: RowOptions): boolean {
  return !(options.hideDone && block.done);
}

/**
 * Rows of a project's task view: tasks in file order, done ones in place,
 * under their headings. Headings without shown tasks are left out.
 */
export function taskRows(path: string, doc: TaskDocument, options: RowOptions): TaskRow[] {
  const rows: TaskRow[] = [];
  let section = -1;
  for (const block of doc.blocks) {
    if (!visible(block, options)) continue;
    if (block.section !== section) {
      section = block.section;
      const heading = doc.sections[section];
      if (heading) {
        rows.push({
          kind: "heading",
          key: `${path}#${heading.line}`,
          title: heading.title,
          level: heading.level,
        });
      }
    }
    pushBlock(rows, path, doc, block, options);
  }
  return rows;
}

/** A task list for the All tasks view. */
export interface TaskGroup {
  project: string;
  path: string;
  doc: TaskDocument;
}

/**
 * Rows of the All tasks view: each list with shown tasks under a project
 * header with its open count, without headings.
 */
export function allTaskRows(groups: readonly TaskGroup[], options: RowOptions): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const group of groups) {
    const blocks = group.doc.blocks.filter((block) => visible(block, options));
    if (blocks.length === 0) continue;
    rows.push({
      kind: "project",
      key: `${group.path}#project`,
      project: group.project,
      path: group.path,
      count: openTaskCount(group.doc),
    });
    for (const block of blocks) pushBlock(rows, group.path, group.doc, block, options);
  }
  return rows;
}
