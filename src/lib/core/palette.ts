/**
 * What the search palette shows for its input: search results, commands
 * (input starting with `>`) or tags (input starting with `#`, not
 * available yet).
 */

export type PaletteMode =
  | { kind: "search"; query: string }
  | { kind: "commands"; query: string }
  | { kind: "tags"; query: string };

export const TAGS_UNAVAILABLE = "Tags are not available yet";

export function paletteMode(input: string): PaletteMode {
  const trimmed = input.trimStart();
  if (trimmed.startsWith(">")) return { kind: "commands", query: trimmed.slice(1).trim() };
  if (trimmed.startsWith("#")) return { kind: "tags", query: trimmed.slice(1).trim() };
  return { kind: "search", query: input.trim() };
}

export type PaletteCommandId =
  "new-note" | "new-project" | "sync-now" | "toggle-hide-done" | "switch-view";

export interface PaletteCommand {
  id: PaletteCommandId;
  label: string;
}

/** Every palette command, in the order they are listed. */
export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: "new-note", label: "New note" },
  { id: "new-project", label: "New project" },
  { id: "sync-now", label: "Sync now" },
  { id: "toggle-hide-done", label: "Hide or show done tasks" },
  { id: "switch-view", label: "Switch list / text" },
];

/** Commands whose label contains `query`, ignoring case. */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...commands];
  return commands.filter((command) => command.label.toLowerCase().includes(needle));
}
