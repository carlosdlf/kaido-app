/**
 * Light Markdown scanning for list views: note titles and open task counts.
 *
 * Front matter at the very top (`---` … `---`) and fenced code blocks
 * (``` or ~~~) are skipped, so a `# comment` in a shell snippet is not a
 * title and a checkbox inside a code sample is not a task.
 */

import { parseTaskLine } from "./tasks";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#[ \t]+(.*)$/;
const FRONT_MATTER_END = /\n(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/;

/** Titles come from the start of a note; longer heads are not scanned. */
export const TITLE_SCAN_LIMIT = 4096;

/** Offset just past the front matter, 0 if there is none, or -1 if it is not closed. */
function frontMatterEnd(text: string): number {
  const firstBreak = text.indexOf("\n");
  const first = (firstBreak === -1 ? text : text.slice(0, firstBreak)).trimEnd();
  if (first !== "---") return 0;
  const closing = FRONT_MATTER_END.exec(text.slice(firstBreak));
  if (!closing) return -1;
  return firstBreak + closing.index + closing[0].length;
}

/**
 * Calls `visit` for each line outside front matter and code blocks, without
 * splitting the whole text first; stops as soon as `visit` returns true.
 */
function scanProse(text: string, visit: (line: string) => boolean, start = 0): void {
  let fence: string | null = null;
  let position = start;
  while (position <= text.length) {
    const lineBreak = text.indexOf("\n", position);
    const end = lineBreak === -1 ? text.length : lineBreak;
    const raw = text.slice(position, end);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    position = end + 1;

    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      fence = marker;
    } else if (visit(line)) {
      return;
    }
  }
}

function proseStart(text: string): number {
  // Without a closing delimiter it is not front matter, just a rule.
  return Math.max(frontMatterEnd(text), 0);
}

/** Removes an optional closing sequence (`# Title ##`), in linear time. */
export function headingText(raw: string): string {
  const text = raw.trim();
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === "#") end -= 1;
  if (end === 0) return "";
  const before = text.charAt(end - 1);
  return before === " " || before === "\t" ? text.slice(0, end).trimEnd() : text;
}

export function fileStem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "");
}

/**
 * The note's first level-one heading, or its file name without `.md`. Only
 * the first `TITLE_SCAN_LIMIT` characters are scanned.
 */
export function noteTitle(path: string, text: string): string {
  const head = text.length > TITLE_SCAN_LIMIT ? text.slice(0, TITLE_SCAN_LIMIT) : text;
  const start = frontMatterEnd(head);
  // Front matter that runs past the scanned head hides any title.
  if (start === -1 && head.length < text.length) return fileStem(path);
  let title = "";
  scanProse(
    head,
    (line) => {
      const match = HEADING.exec(line);
      if (!match) return false;
      title = headingText(match[1] ?? "");
      return title !== "";
    },
    Math.max(start, 0),
  );
  return title || fileStem(path);
}

/** Number of unchecked task lines. */
export function countOpenTasks(text: string): number {
  let count = 0;
  scanProse(
    text,
    (line) => {
      if (parseTaskLine(line)?.done === false) count += 1;
      return false;
    },
    proseStart(text),
  );
  return count;
}
