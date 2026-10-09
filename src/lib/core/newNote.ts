/** Where a new note goes, what it is called and which keys create it. */

import { ALL_TASKS } from "./views";
import { INBOX } from "./workspace";

/** How many names `newNotePath` tries before giving up. */
export const MAX_UNTITLED_NAMES = 1000;

/** The project that receives a new note for the current sidebar selection. */
export function newNoteFolder(selection: string): string {
  return selection === ALL_TASKS || selection === "" ? INBOX : selection;
}

/** `untitled.md` for the first candidate, then `untitled 2.md`, `untitled 3.md`… */
export function untitledName(index: number): string {
  return index <= 1 ? "untitled.md" : `untitled ${index}.md`;
}

/**
 * The first `<folder>/untitled.md`, `<folder>/untitled 2.md`… that `isTaken`
 * does not reject, or `null` when the first `limit` names are all taken.
 */
export function newNotePath(
  folder: string,
  isTaken: (path: string) => boolean,
  limit = MAX_UNTITLED_NAMES,
): string | null {
  for (let index = 1; index <= limit; index += 1) {
    const path = `${folder}/${untitledName(index)}`;
    if (!isTaken(path)) return path;
  }
  return null;
}

/** The parts of a keyboard event that shortcuts look at. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** `Ctrl+N`, or `Cmd+N` on macOS, without other modifiers. */
export function isNewNoteShortcut(event: KeyPress, mac: boolean): boolean {
  if (event.key.toLowerCase() !== "n" || event.altKey || event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** How the new note shortcut is announced (`aria-keyshortcuts`) and shown. */
export function newNoteShortcutLabels(mac: boolean): { aria: string; hint: string } {
  return mac ? { aria: "Meta+N", hint: "⌘N" } : { aria: "Control+N", hint: "^N" };
}
