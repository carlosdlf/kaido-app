/**
 * Notes linked from tasks.
 *
 * A task links to a note with a standard Markdown link in its text,
 * `[label](relative/path.md)`, with the path relative to the task list and
 * spaces written as `%20`, so the link also works on GitHub and in other
 * editors. The first link to an existing note is the task's linked note; a
 * task whose links all point to missing notes shows the first one as
 * missing.
 */

import { MAX_NAME_BYTES, truncateUtf8, utf8Length, validateNoteName } from "./noteNames";
import { isTaskListPath } from "./workspace";

export interface TaskLink {
  /** Where the link starts and ends in the task text. */
  start: number;
  end: number;
  label: string;
  /** Workspace path of the linked Markdown file. */
  path: string;
}

export interface LinkedNote extends TaskLink {
  /** Whether the note exists in the workspace. */
  exists: boolean;
}

/** `[label](target)` with a target without spaces or parentheses, as written by the app. */
const LINK = /\[([^\]\n]*)\]\(([^()\s]*)\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MARKDOWN = /\.md$/i;

function folderOf(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  return segments;
}

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * The workspace path a link target points to, relative to the file at
 * `from`: only relative links to `.md` files inside the workspace, never
 * URLs, absolute paths or anchors.
 */
export function resolveLinkTarget(target: string, from: string): string | null {
  const bare = target.split(/[?#]/)[0] ?? "";
  if (bare === "" || bare.startsWith("/") || SCHEME.test(bare)) return null;
  const decoded = decode(bare);
  if (decoded === null || !MARKDOWN.test(decoded)) return null;
  const segments = folderOf(from);
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

/** `[start, end)` ranges of inline code spans: a backtick run up to the next run of the same length. */
function codeSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const runs = [...text.matchAll(/`+/g)];
  for (let index = 0; index < runs.length; index += 1) {
    const open = runs[index];
    if (!open) continue;
    const length = open[0].length;
    const close = runs.findIndex((run, at) => at > index && run[0].length === length);
    if (close === -1) continue;
    const end = runs[close];
    if (!end) continue;
    spans.push([open.index, end.index + length]);
    index = close;
  }
  return spans;
}

/**
 * Links to notes in a task's text, in order. Links inside inline code and
 * links to task lists (`<project>/tasks.md`) are not note links.
 */
export function taskLinks(text: string, tasksPath: string): TaskLink[] {
  const links: TaskLink[] = [];
  const spans = codeSpans(text);
  for (const match of text.matchAll(LINK)) {
    if (spans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const path = resolveLinkTarget(match[2] ?? "", tasksPath);
    if (path === null || isTaskListPath(path)) continue;
    links.push({
      start: match.index,
      end: match.index + match[0].length,
      label: match[1] ?? "",
      path,
    });
  }
  return links;
}

/** The task's linked note: the first link to an existing note, else the first link to a missing one. */
export function linkedNote(
  text: string,
  tasksPath: string,
  exists: (path: string) => boolean,
): LinkedNote | null {
  const links = taskLinks(text, tasksPath);
  const existing = links.find((link) => exists(link.path));
  if (existing) return { ...existing, exists: true };
  const first = links[0];
  return first ? { ...first, exists: false } : null;
}

/** The task text with one link taken out, for display next to a chip. */
export function withoutLink(text: string, link: TaskLink): string {
  return `${text.slice(0, link.start)} ${text.slice(link.end)}`.replace(/\s+/g, " ").trim();
}

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f/\\<>:"|?*]/gu;
const ALL_LINKS = /\[([^\]\n]*)\]\(([^()\s]*)\)/g;

/** The name for a note created from a task, without `.md`: valid on every OS, or `untitled`. */
export function noteNameFromTask(text: string): string {
  let name = text
    .replace(ALL_LINKS, " ")
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.md$/i, "")
    .replace(/^\.+/, "");
  const room = MAX_NAME_BYTES - utf8Length(".md");
  if (utf8Length(name) > room) name = truncateUtf8(name, room);
  name = name.replace(/[\s.]+$/u, "");
  if (name === "") return "untitled";
  return validateNoteName(name).ok ? name : "untitled";
}

/** The task text without its links, e.g. for a note title. */
export function textWithoutLinks(text: string): string {
  return text.replace(ALL_LINKS, " ").replace(/\s+/g, " ").trim();
}

const ENCODED: Record<string, string> = {
  " ": "%20",
  "#": "%23",
  "%": "%25",
  "(": "%28",
  ")": "%29",
  "<": "%3C",
  ">": "%3E",
  "[": "%5B",
  "]": "%5D",
};

/**
 * A file name as a link target: spaces and the characters that would end or
 * change a CommonMark link destination (`#`, `%`, `(`, `)`, `<`, `>`, `[`,
 * `]`) are percent-encoded. Other characters, including non-ASCII ones, stay.
 */
export function encodeLinkTarget(name: string): string {
  return name.replace(/[ #%()<>[\]]/g, (char) => ENCODED[char] ?? char);
}

/** The link appended to a task after a note was created from it. */
export function noteLink(fileName: string): string {
  return `[note](${encodeLinkTarget(fileName)})`;
}
