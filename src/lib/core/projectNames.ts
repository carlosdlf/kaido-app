/**
 * Names for new projects. A project is a top-level folder, so its name
 * follows the note file name rules (without the `.md` extension) and must
 * not clash with the folders the workspace treats specially.
 */

import type { KeyPress } from "./newNote";
import { portableNameProblem, stemProblem, utf8Length, type NameValidation } from "./noteNames";
import { ARCHIVE_DIR, INBOX, TASKS_FILE } from "./workspace";

/** Longest project name accepted, in UTF-8 bytes. */
export const MAX_PROJECT_NAME_BYTES = 100;

const invalid = (reason: string): NameValidation => ({ ok: false, reason });

/**
 * Checks a name typed for a new project and returns the folder name to use
 * (trimmed), or why it is refused. `existing` are the current project names,
 * compared case-insensitively since many file systems ignore case.
 */
export function validateProjectName(input: string, existing: Iterable<string>): NameValidation {
  const name = input.trim();
  const problem = portableNameProblem(name) ?? stemProblem(name);
  if (problem !== null) return invalid(problem);
  const key = name.toLowerCase();
  if (key === INBOX) return invalid(`${INBOX} already exists.`);
  if (key === ARCHIVE_DIR || name.startsWith("_")) {
    return invalid("Project names cannot start with _.");
  }
  if (key === "node_modules") return invalid("node_modules is ignored in workspaces.");
  if (utf8Length(name) > MAX_PROJECT_NAME_BYTES) return invalid("This name is too long.");
  for (const project of existing) {
    if (project.toLowerCase() === key) return invalid(`A project named ${project} already exists.`);
  }
  return { ok: true, name };
}

/** Where a new project's task list goes. */
export function projectTasksPath(name: string): string {
  return `${name}/${TASKS_FILE}`;
}

/** `Ctrl+Shift+N`, or `Cmd+Shift+N` on macOS. */
export function isNewProjectShortcut(event: KeyPress, mac: boolean): boolean {
  if (event.key.toLowerCase() !== "n" || event.altKey || !event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** How the new project shortcut is announced (`aria-keyshortcuts`) and shown. */
export function newProjectShortcutLabels(mac: boolean): { aria: string; hint: string } {
  return mac ? { aria: "Meta+Shift+N", hint: "⌘⇧N" } : { aria: "Control+Shift+N", hint: "^⇧N" };
}
