/**
 * Note file names: what a rename accepts, and where the note ends up.
 *
 * The file name is what the user types, trimmed, with `.md` appended when it
 * has no `.md` extension. Only names that break on Linux, macOS or Windows
 * are rejected, plus `tasks.md`, which is reserved for task lists.
 */

import { TASKS_FILE } from "./workspace";

/** Longest file name most file systems accept, in UTF-8 bytes. */
export const FILE_NAME_LIMIT_BYTES = 255;

/**
 * Longest note name accepted, in UTF-8 bytes. Shorter than the file system
 * limit so conflict copies and the trash's own files for a note still fit.
 */
export const MAX_NAME_BYTES = 200;

export type NameValidation = { ok: true; name: string } | { ok: false; reason: string };

const MARKDOWN_EXTENSION = /\.md$/i;
// Control characters, including NUL and DEL.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const WINDOWS_RESERVED_CHARS = /[<>:"|?*]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function charBytes(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/** Length of `text` in UTF-8 bytes; a lone surrogate counts like any other BMP character. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) bytes += charBytes(char);
  return bytes;
}

/** The longest start of `text` that fits in `maxBytes` UTF-8 bytes, cut between code points. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += charBytes(char);
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}

/** Length of the name without its `.md` extension, e.g. to preselect it for editing. */
export function stemLength(name: string): number {
  return MARKDOWN_EXTENSION.test(name) ? name.length - 3 : name.length;
}

const invalid = (reason: string): NameValidation => ({ ok: false, reason });

/**
 * Why a trimmed file or folder name breaks on some OS (empty, separators,
 * control or reserved characters, a leading dot), or `null`.
 */
export function portableNameProblem(trimmed: string): string | null {
  if (trimmed === "") return "Enter a name.";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "Names cannot contain / or \\.";
  if (CONTROL.test(trimmed)) return "Names cannot contain control characters.";
  if (WINDOWS_RESERVED_CHARS.test(trimmed)) return 'Names cannot contain < > : " | ? or *.';
  if (trimmed.startsWith(".")) return "Names cannot start with a dot.";
  return null;
}

/**
 * Why a name without its extension breaks on Windows (a trailing space or
 * dot, a device name such as `CON`, also before another extension), or `null`.
 */
export function stemProblem(stem: string): string | null {
  if (/[\s.]$/u.test(stem)) return "Names cannot end with a space or a dot.";
  const device = (stem.split(".")[0] ?? "").trimEnd();
  if (WINDOWS_DEVICE.test(device)) return `${device.toUpperCase()} is a reserved name on Windows.`;
  return null;
}

/** Checks a name typed for a note and returns the file name to use, or why it is refused. */
export function validateNoteName(input: string): NameValidation {
  const trimmed = input.trim();
  const problem = portableNameProblem(trimmed);
  if (problem !== null) return invalid(problem);

  const name = MARKDOWN_EXTENSION.test(trimmed) ? trimmed : `${trimmed}.md`;
  const stemIssue = stemProblem(name.slice(0, stemLength(name)));
  if (stemIssue !== null) return invalid(stemIssue);
  if (name.toLowerCase() === TASKS_FILE) {
    return invalid(`${TASKS_FILE} is reserved for task lists.`);
  }
  if (utf8Length(name) > MAX_NAME_BYTES) return invalid("This name is too long.");
  return { ok: true, name };
}

/** The path of a note renamed to `name`, in the same folder. */
export function renamedPath(path: string, name: string): string {
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${name}`;
}

/**
 * The item to select after `removed` leaves the list `ids`: the next one,
 * else the previous one, else `null`.
 */
export function nextAfterRemoval(ids: readonly string[], removed: string): string | null {
  const index = ids.indexOf(removed);
  if (index === -1) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}
