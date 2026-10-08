import { parseTaskLine } from "$lib/core/tasks";
import type { Block, FolderFixture, NoteFixture } from "./fixtures";
import { inbox, projects } from "./fixtures";

/** Sidebar entry that is not a folder. */
export const ALL_TASKS = "all-tasks";

export type ListItem =
  | { kind: "tasks"; id: string; label: string; openCount: number }
  | { kind: "note"; id: string; note: NoteFixture };

export interface OpenDocument {
  folder: string;
  file: string;
  age: string;
  body: Block[];
}

const folders: FolderFixture[] = [inbox, ...projects];

function findFolder(name: string): FolderFixture | undefined {
  return folders.find((folder) => folder.name === name);
}

export function openTaskCount(folder: FolderFixture): number {
  return folder.tasks.filter((line) => parseTaskLine(line)?.done === false).length;
}

export function totalOpenTasks(): number {
  return folders.reduce((sum, folder) => sum + openTaskCount(folder), 0);
}

function tasksItem(folder: FolderFixture, label: string): ListItem {
  return {
    kind: "tasks",
    id: `${folder.name}/tasks.md`,
    label,
    openCount: openTaskCount(folder),
  };
}

/** Items shown in the list pane: the task list first, then notes. */
export function listItems(selection: string): ListItem[] {
  if (selection === ALL_TASKS) {
    return folders
      .filter((folder) => openTaskCount(folder) > 0)
      .map((folder) => tasksItem(folder, `${folder.name}/tasks.md`));
  }
  const folder = findFolder(selection);
  if (!folder) return [];
  const items: ListItem[] = [];
  if (folder.tasks.length > 0) items.push(tasksItem(folder, "tasks.md"));
  for (const note of folder.notes) items.push({ kind: "note", id: note.path, note });
  return items;
}

export function listTitle(selection: string): string {
  if (selection === ALL_TASKS) return "all-tasks";
  return selection === inbox.name ? "~/inbox" : `${selection}/`;
}

export function listSummary(selection: string): string {
  if (selection === ALL_TASKS) {
    const count = listItems(ALL_TASKS).length;
    return `${totalOpenTasks()} open · ${count} ${count === 1 ? "list" : "lists"}`;
  }
  const folder = findFolder(selection);
  if (!folder) return "";
  const notes = folder.notes.length;
  const tasks = openTaskCount(folder);
  return `${notes} ${notes === 1 ? "note" : "notes"} · ${tasks} ${tasks === 1 ? "task" : "tasks"}`;
}

export function openDocument(id: string): OpenDocument | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return undefined;
  const folderName = id.slice(0, slash);
  const file = id.slice(slash + 1);
  const folder = findFolder(folderName);
  if (!folder) return undefined;
  if (file === "tasks.md") {
    return {
      folder: folder.name,
      file,
      age: "now",
      body: [{ kind: "tasks", lines: folder.tasks }],
    };
  }
  const note = folder.notes.find((candidate) => candidate.path === id);
  if (!note) return undefined;
  return { folder: folder.name, file: note.file, age: note.age, body: note.body };
}
