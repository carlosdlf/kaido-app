/** Shortcuts that switch views. */

import type { KeyPress } from "./newNote";

/** `Ctrl+Shift+M`, or `Cmd+Shift+M` on macOS: show the task list as a list or as text. */
export function isViewModeShortcut(event: KeyPress, mac: boolean): boolean {
  if (event.key.toLowerCase() !== "m" || event.altKey || !event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** How the view mode shortcut is announced (`aria-keyshortcuts`) and shown. */
export function viewModeShortcutLabels(mac: boolean): { aria: string; hint: string } {
  return mac ? { aria: "Meta+Shift+M", hint: "⌘⇧M" } : { aria: "Control+Shift+M", hint: "^⇧M" };
}

/** `Ctrl+Shift+S`, or `Cmd+Shift+S` on macOS: sync now. */
export function isSyncShortcut(event: KeyPress, mac: boolean): boolean {
  if (event.key.toLowerCase() !== "s" || event.altKey || !event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** How the sync shortcut is announced (`aria-keyshortcuts`) and shown. */
export function syncShortcutLabels(mac: boolean): { aria: string; hint: string } {
  return mac ? { aria: "Meta+Shift+S", hint: "⌘⇧S" } : { aria: "Control+Shift+S", hint: "^⇧S" };
}
