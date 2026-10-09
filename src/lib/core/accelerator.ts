/**
 * Global shortcuts as accelerator strings (`CommandOrControl+Alt+Space`):
 * recording one from a key press, checking stored ones and showing them.
 */

import type { KeyPress } from "./newNote";

/** A key press with its physical key (`KeyA`, `Digit1`, `Space`), independent of the layout. */
export interface CodedKeyPress extends KeyPress {
  code: string;
}

/** Modifier names in the order they are written. */
const MODIFIER_ORDER = ["CommandOrControl", "Control", "Super", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

/** Accepted spellings of each modifier, lowercased. */
const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  cmdorcontrol: "CommandOrControl",
  commandorctrl: "CommandOrControl",
  control: "Control",
  ctrl: "Control",
  super: "Super",
  command: "Super",
  cmd: "Super",
  meta: "Super",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

/** Physical keys that are not letters, digits or function keys, by `KeyboardEvent.code`. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backquote",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
]);

/** How named keys are shown. */
const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

const MAX_ACCELERATOR_LENGTH = 100;

/** The accelerator key for a physical key (`KeyA` → `A`), or `null` if it cannot be used. */
export function acceleratorKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED_KEYS.has(code) ? code : null;
}

function normalizeKey(key: string): string | null {
  if (/^[A-Za-z]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  const fromCode = acceleratorKey(key);
  if (fromCode !== null) return fromCode;
  const lower = key.toLowerCase();
  const named = [...NAMED_KEYS].find((name) => name.toLowerCase() === lower);
  if (named) return named;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  return fn ? `F${fn[1]}` : null;
}

export interface ParsedAccelerator {
  modifiers: Modifier[];
  key: string;
}

/**
 * Splits an accelerator into its modifiers (in a fixed order) and its key.
 * `null` when it is malformed or has no modifier besides `Shift`, since a
 * global shortcut without one would take over normal typing.
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  if (accelerator.length === 0 || accelerator.length > MAX_ACCELERATOR_LENGTH) return null;
  const parts = accelerator.split("+");
  const keyPart = parts.pop();
  if (keyPart === undefined || parts.length === 0) return null;
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }
  if ([...modifiers].every((modifier) => modifier === "Shift")) return null;
  const key = normalizeKey(keyPart.trim());
  if (key === null) return null;
  return { modifiers: MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key };
}

/** Whether `accelerator` is a usable global shortcut. */
export function isValidAccelerator(accelerator: string): boolean {
  return parseAccelerator(accelerator) !== null;
}

/** The canonical spelling of an accelerator, for comparing two of them; `null` if invalid. */
export function normalizeAccelerator(accelerator: string): string | null {
  const parsed = parseAccelerator(accelerator);
  return parsed ? [...parsed.modifiers, parsed.key].join("+") : null;
}

/** Whether two accelerators (or `null`, no shortcut) mean the same shortcut. */
export function sameAccelerator(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return (normalizeAccelerator(a) ?? a) === (normalizeAccelerator(b) ?? b);
}

export type RecordedShortcut =
  | { kind: "shortcut"; accelerator: string }
  /** `Backspace` alone: turn the shortcut off. */
  | { kind: "disable" }
  /** `Esc` alone: stop recording without a change. */
  | { kind: "cancel" }
  /** Only modifiers so far, or a key without a modifier: keep listening. */
  | { kind: "incomplete" };

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

/**
 * What a key press means while a shortcut is being recorded. `Ctrl` (or
 * `Cmd` on macOS) is stored as `CommandOrControl`, so the shortcut reads the
 * same on every platform; `Ctrl` on macOS and the Windows or Super key
 * elsewhere are stored as `Control` and `Super`.
 */
export function recordShortcut(event: CodedKeyPress, mac: boolean): RecordedShortcut {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (plain && event.key === "Escape") return { kind: "cancel" };
  if (plain && event.key === "Backspace") return { kind: "disable" };
  if (MODIFIER_KEYS.has(event.key)) return { kind: "incomplete" };
  const key = acceleratorKey(event.code);
  if (key === null) return { kind: "incomplete" };
  const modifiers: Modifier[] = [];
  const primary = mac ? event.metaKey : event.ctrlKey;
  const secondary = mac ? event.ctrlKey : event.metaKey;
  if (primary) modifiers.push("CommandOrControl");
  if (secondary) modifiers.push(mac ? "Control" : "Super");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  const accelerator = [...modifiers, key].join("+");
  return isValidAccelerator(accelerator)
    ? { kind: "shortcut", accelerator: normalizeAccelerator(accelerator) ?? accelerator }
    : { kind: "incomplete" };
}

const MAC_LABELS: Record<Modifier, string> = {
  CommandOrControl: "⌘",
  Control: "⌃",
  Super: "⌘",
  Alt: "⌥",
  Shift: "⇧",
};

const OTHER_LABELS: Record<Modifier, string> = {
  CommandOrControl: "Ctrl",
  Control: "Ctrl",
  Super: "Super",
  Alt: "Alt",
  Shift: "Shift",
};

/** The keys of an accelerator as shown to the user, e.g. `["Ctrl", "Alt", "Space"]`. */
export function acceleratorKeys(accelerator: string, mac: boolean): string[] {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return [accelerator];
  const labels = mac ? MAC_LABELS : OTHER_LABELS;
  return [...parsed.modifiers.map((modifier) => labels[modifier]), keyLabel(parsed.key)];
}

function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? key;
}
