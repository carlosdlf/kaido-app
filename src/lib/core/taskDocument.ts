/**
 * Task lists (`<project>/tasks.md`) as task blocks, and the edits the task
 * views make to them.
 *
 * A task block is a task line at the start of a line (`- [ ] text`,
 * `* [x] text`, `+ [X] text`) plus every following line that is indented:
 * subtasks and continuation lines. Blank lines followed by more indented
 * lines stay in the block (a loose list item); the block ends before the
 * next non-blank line that does not start with a space or a tab.
 *
 * Everything else (headings, paragraphs, blank lines, front matter, code)
 * is kept byte for byte. Edits are line-level and as small as possible, so
 * they merge well: toggling changes one character, adding inserts one line,
 * deleting removes the block's lines and moving swaps two blocks. Each line
 * keeps its own line break; new lines use the file's separator (the kind of
 * its first line break, `\n` without any).
 *
 * Tasks are addressed by a `TaskRef`: the index of their line plus the
 * line's exact text. If the text moved (an edit from disk or the text
 * editor), the edit relocates to the one task line with that text, and
 * does nothing when there is no such line or more than one. Every edit
 * returns the new text and the line of the task to focus afterwards.
 */

import { headingText } from "./markdown";
import { serializeTask } from "./tasks";

/** One line of the file and the line break that ends it (`""` for a last line without one). */
export interface SourceLine {
  readonly text: string;
  readonly eol: string;
}

export interface TaskLine {
  /** Index of the task's line in the file; the task's id until the text changes. */
  line: number;
  done: boolean;
  text: string;
  /** The whole line as written, used to find the task again after the text changed. */
  raw: string;
}

/** Points at a task: its line and the exact text that line had. */
export interface TaskRef {
  line: number;
  raw: string;
}

export interface TaskBlock extends TaskLine {
  /** One past the last line of the block. */
  end: number;
  /** Indented task lines inside the block, at any depth. */
  subtasks: TaskLine[];
  /** Index into `sections` of the heading above the block, or `-1`. */
  section: number;
}

export interface TaskSection {
  /** Line of the heading. */
  line: number;
  level: number;
  title: string;
}

export interface TaskDocument {
  /** The text the model was built from. */
  readonly text: string;
  readonly lines: readonly SourceLine[];
  /** Line separator for new lines. */
  readonly separator: string;
  /** Top-level task blocks in file order. */
  readonly blocks: readonly TaskBlock[];
  /** Headings in file order. */
  readonly sections: readonly TaskSection[];
  /** Line of a fenced code block that is still open at the end of the file, or `null`. */
  readonly openFence: number | null;
}

/** The result of an edit: the new text and the line of the task to focus, if any. */
export interface TaskEdit {
  text: string;
  focus: number | null;
}

/** Lines taken out by a delete, so an undo can put them back. */
export interface RemovedLines {
  /** Where the lines started. */
  index: number;
  lines: readonly SourceLine[];
  /** The whole text right after the delete. */
  textAfter: string;
  /** The line just before the removed lines, and the one just after, if any. */
  previous: string | null;
  next: string | null;
}

export interface TaskDeletion extends TaskEdit {
  removed: RemovedLines;
}

const LINE_BREAK = /\r\n?|\n/g;
/**
 * Bullet, space, brackets with a state, then whitespace or the end. Only the
 * fixed-length prefix is matched, so parsing stays linear for any input.
 */
const TASK = /^([ \t]*)[-*+] \[([ xX])\](?=[ \t]|$)/;
/** Length of `- [ ]`. */
const MARKER_LENGTH = 5;
/** Offset of the state character after the indentation: bullet, space, `[`. */
const STATE_OFFSET = 3;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Inside a block, fences are indented with the block's content. */
const BLOCK_FENCE = /^[ \t]*(`{3,}|~{3,})/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** Lines that start something other than a paragraph: list items and block quotes. */
const NOT_PARAGRAPH = /^ {0,3}(?:[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const FRONT_MATTER_END = /^(?:---|\.\.\.)[ \t]*$/;
const LINE_BREAKS_IN_TEXT = /[\r\n\u2028\u2029]+/g;

/** The line separator of a text: the kind of its first line break, `\n` without any. */
export function lineSeparator(text: string): string {
  return /\r\n?|\n/.exec(text)?.[0] ?? "\n";
}

/** Splits text into lines, each with the line break that ends it. */
export function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  LINE_BREAK.lastIndex = 0;
  for (let match = LINE_BREAK.exec(text); match; match = LINE_BREAK.exec(text)) {
    lines.push({ text: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: "" });
  return lines;
}

export function joinLines(lines: readonly SourceLine[]): string {
  let text = "";
  for (const line of lines) text += line.text + line.eol;
  return text;
}

interface ParsedLine {
  indent: string;
  done: boolean;
  text: string;
}

function parseLine(text: string): ParsedLine | null {
  const match = TASK.exec(text);
  if (!match) return null;
  const indent = match[1] ?? "";
  return {
    indent,
    done: match[2] !== " ",
    text: text.slice(indent.length + MARKER_LENGTH).trim(),
  };
}

function isIndented(text: string): boolean {
  return text.startsWith(" ") || text.startsWith("\t");
}

/** Index of the line closing the front matter that opens the file, or -1. */
function frontMatterEnd(lines: readonly SourceLine[]): number {
  if (lines[0]?.text.trimEnd() !== "---") return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONT_MATTER_END.test(lines[index]?.text ?? "")) return index;
  }
  return -1;
}

function closes(marker: string | undefined, fence: string): boolean {
  return marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length;
}

function taskLine(index: number, task: ParsedLine, raw: string): TaskLine {
  return { line: index, done: task.done, text: task.text, raw };
}

/**
 * Builds the model of a task list.
 *
 * Headings are ATX headings (`# Title`) and setext headings (a paragraph
 * underlined with `===` or `---`). A `---` after a blank line, a task or a
 * list item is a thematic break, as in CommonMark. Fenced code opened inside
 * a block ends with the block.
 */
export function parseTaskDocument(text: string): TaskDocument {
  const lines = splitLines(text);
  const blocks: TaskBlock[] = [];
  const sections: TaskSection[] = [];
  let block: TaskBlock | null = null;
  let fence: string | null = null;
  let fenceLine = -1;
  let fenceInBlock = false;
  /** First line of the paragraph being read outside blocks, or `null`. */
  let paragraph: number | null = null;
  /** Lines right after a block continue its item lazily, so they cannot be underlined. */
  let lazy = false;
  let blankInBlock = false;

  for (let index = frontMatterEnd(lines) + 1; index < lines.length; index += 1) {
    const line = lines[index]?.text ?? "";
    const blank = line.trim() === "";

    if (block) {
      if (blank) {
        blankInBlock = true;
        continue;
      }
      if (isIndented(line)) {
        block.end = index + 1;
        const marker = BLOCK_FENCE.exec(line)?.[1];
        if (fence !== null) {
          if (closes(marker, fence)) fence = null;
          continue;
        }
        if (marker) {
          fence = marker;
          fenceInBlock = true;
          continue;
        }
        const task = parseLine(line);
        if (task) block.subtasks.push(taskLine(index, task, line));
        continue;
      }
      block = null;
      lazy = !blankInBlock;
      if (fenceInBlock) {
        fence = null;
        fenceInBlock = false;
      }
    }

    if (fence !== null) {
      if (closes(FENCE.exec(line)?.[1], fence)) fence = null;
      continue;
    }
    if (blank) {
      paragraph = null;
      lazy = false;
      continue;
    }
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      fence = marker;
      fenceLine = index;
      paragraph = null;
      continue;
    }
    const task = parseLine(line);
    if (task && task.indent === "") {
      block = {
        ...taskLine(index, task, line),
        end: index + 1,
        subtasks: [],
        section: sections.length - 1,
      };
      blocks.push(block);
      blankInBlock = false;
      paragraph = null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      sections.push({
        line: index,
        level: heading[1]?.length ?? 1,
        title: headingText(heading[2] ?? ""),
      });
      paragraph = null;
      continue;
    }
    const underline = SETEXT.exec(line)?.[1];
    if (underline && paragraph !== null) {
      const title = lines
        .slice(paragraph, index)
        .map((source) => source.text.trim())
        .join(" ");
      sections.push({ line: paragraph, level: underline[0] === "=" ? 1 : 2, title });
      paragraph = null;
      continue;
    }
    if (lazy || NOT_PARAGRAPH.test(line) || (paragraph === null && line.startsWith("    "))) {
      paragraph = null;
      continue;
    }
    paragraph ??= index;
  }

  const openFence = fence !== null && !fenceInBlock ? fenceLine : null;
  return { text, lines, separator: lineSeparator(text), blocks, sections, openFence };
}

/** Open top-level tasks; subtasks are not counted. */
export function openTaskCount(doc: TaskDocument): number {
  let count = 0;
  for (const block of doc.blocks) if (!block.done) count += 1;
  return count;
}

/** The block whose line or one of whose subtasks is `line`. */
export function blockOf(doc: TaskDocument, line: number): TaskBlock | null {
  for (const block of doc.blocks) {
    if (block.line === line || block.subtasks.some((task) => task.line === line)) return block;
  }
  return null;
}

/** The task (top-level or subtask) on `line`. */
export function taskAt(doc: TaskDocument, line: number): TaskLine | null {
  const block = blockOf(doc, line);
  if (!block) return null;
  return block.line === line ? block : (block.subtasks.find((task) => task.line === line) ?? null);
}

/** Every task of the list, top-level and subtasks, in file order. */
function allTasks(doc: TaskDocument): TaskLine[] {
  const tasks: TaskLine[] = [];
  for (const block of doc.blocks) tasks.push(block, ...block.subtasks);
  return tasks;
}

/**
 * The line of the task `ref` points at: its own line if that still has the
 * same text, else the one task line with exactly that text. `null` when the
 * task is gone or the text is not unique.
 */
export function locateTask(doc: TaskDocument, ref: TaskRef): number | null {
  if (doc.lines[ref.line]?.text === ref.raw && taskAt(doc, ref.line)) return ref.line;
  let found: number | null = null;
  for (const task of allTasks(doc)) {
    if (task.raw !== ref.raw) continue;
    if (found !== null) return null;
    found = task.line;
  }
  return found;
}

/** The reference to the task on `line`. */
export function refAt(doc: TaskDocument, line: number): TaskRef {
  return { line, raw: doc.lines[line]?.text ?? "" };
}

/** Collapses line breaks and trims, so the text always fits on one line. */
export function cleanTaskText(input: string): string {
  return input.replace(LINE_BREAKS_IN_TEXT, " ").trim();
}

function replaceLine(doc: TaskDocument, index: number, text: string): string {
  const lines = doc.lines.slice();
  const line = lines[index];
  if (!line) return doc.text;
  lines[index] = { text, eol: line.eol };
  return joinLines(lines);
}

/** Flips the done state of the task, changing only the state character. */
export function toggleTask(doc: TaskDocument, ref: TaskRef): TaskEdit | null {
  const line = locateTask(doc, ref);
  const source = line === null ? undefined : doc.lines[line]?.text;
  if (line === null || source === undefined) return null;
  const task = parseLine(source);
  if (!task) return null;
  const offset = task.indent.length + STATE_OFFSET;
  const state = task.done ? " " : "x";
  const text = source.slice(0, offset) + state + source.slice(offset + 1);
  return { text: replaceLine(doc, line, text), focus: line };
}

function isBlank(char: string): boolean {
  return char === " " || char === "\t";
}

/**
 * Replaces the text of the task on `line`, keeping its indentation, bullet,
 * state, the spacing after the checkbox and trailing whitespace. Empty text
 * or unchanged text is no edit.
 */
export function editTaskText(doc: TaskDocument, ref: TaskRef, input: string): TaskEdit | null {
  const line = locateTask(doc, ref);
  const source = line === null ? undefined : doc.lines[line]?.text;
  const current = line === null ? null : taskAt(doc, line);
  const text = cleanTaskText(input);
  if (line === null || source === undefined || !current || text === "" || text === current.text)
    return null;
  const task = parseLine(source);
  if (!task) return null;
  const prefixEnd = task.indent.length + MARKER_LENGTH;
  let start = prefixEnd;
  while (start < source.length && isBlank(source.charAt(start))) start += 1;
  let end = source.length;
  while (end > start && isBlank(source.charAt(end - 1))) end -= 1;
  const spacing = start > prefixEnd ? source.slice(prefixEnd, start) : " ";
  const next = source.slice(0, prefixEnd) + spacing + text + source.slice(end);
  return { text: replaceLine(doc, line, next), focus: line };
}

/**
 * Inserts `inserted` before line `index`. A line that was last without a
 * line break gets the file's separator, and so does an inserted last line
 * without one that is not at the end anymore.
 */
function insertLines(
  doc: TaskDocument,
  index: number,
  inserted: readonly SourceLine[],
): SourceLine[] {
  const lines = doc.lines.slice();
  const at = Math.min(Math.max(index, 0), lines.length);
  const added = inserted.slice();
  const last = added[added.length - 1];
  if (last && last.eol === "" && at < lines.length) {
    added[added.length - 1] = { text: last.text, eol: doc.separator };
  }
  const before = lines[at - 1];
  if (before && before.eol === "") lines[at - 1] = { text: before.text, eol: doc.separator };
  lines.splice(at, 0, ...added);
  return lines;
}

/** Where `insertTask` puts a new task. */
export type InsertPosition =
  /**
   * After the block of this task; with `nested`, as the last subtask of
   * that block instead.
   */
  | { after: TaskRef; nested?: boolean }
  /** At the end of the section with this index (`-1`: before the first heading). */
  | { section: number }
  /** At the end of the file. */
  | "end";

function sectionEnd(doc: TaskDocument, section: number): number {
  const next = doc.sections[section + 1];
  const limit = next ? next.line : doc.lines.length;
  const start = section >= 0 ? (doc.sections[section]?.line ?? -1) + 1 : 0;
  let end = limit;
  // Blank lines before the next heading stay between the task and the heading.
  while (end > start && (doc.lines[end - 1]?.text.trim() ?? "") === "" && next) end -= 1;
  return end;
}

function insertIndex(doc: TaskDocument, position: InsertPosition): number | null {
  let index: number | null;
  if (position === "end") index = doc.lines.length;
  else if ("after" in position) {
    const line = locateTask(doc, position.after);
    const block = line === null ? null : blockOf(doc, line);
    // A subtask never goes into a code block left open inside the task's block.
    const fence = block && position.nested === true ? openFenceInBlock(doc, block) : null;
    index = fence ?? block?.end ?? null;
  } else if (position.section < -1 || position.section >= doc.sections.length) index = null;
  else index = sectionEnd(doc, position.section);
  // Lines after an unclosed fence are code; the task goes before the fence.
  if (index !== null && doc.openFence !== null && index > doc.openFence) index = doc.openFence;
  return index;
}

/**
 * Adds an open task with `input` as its text. A file whose last line has no
 * line break keeps it that way when the task goes at the end. A file ending
 * in a fenced code block that is never closed gets the task before that
 * fence, since anything after it would be code. Empty text is no edit.
 */
export function insertTask(
  doc: TaskDocument,
  input: string,
  position: InsertPosition,
): TaskEdit | null {
  const text = cleanTaskText(input);
  const index = insertIndex(doc, position);
  if (text === "" || index === null) return null;
  const lastWithoutBreak = doc.lines[doc.lines.length - 1]?.eol === "";
  const eol = index === doc.lines.length && lastWithoutBreak ? "" : doc.separator;
  let line = serializeTask({ done: false, text });
  if (typeof position === "object" && "after" in position && position.nested === true) {
    const at = locateTask(doc, position.after);
    const block = at === null ? null : blockOf(doc, at);
    if (block) line = contentIndent(doc, block, "subtask") + line;
  }
  const lines = insertLines(doc, index, [{ text: line, eol }]);
  return { text: joinLines(lines), focus: index };
}

/**
 * The indentation for new lines in a block: of its detail lines for detail,
 * of its subtasks for subtasks, else of the other kind, else two spaces.
 */
function contentIndent(doc: TaskDocument, block: TaskBlock, kind: "detail" | "subtask"): string {
  const detail = detailParts(doc, block)
    .lines.map((index) => doc.lines[index]?.text ?? "")
    .find((text) => text.trim() !== "");
  const subtask = block.subtasks[0]?.raw;
  const source = (kind === "detail" ? (detail ?? subtask) : (subtask ?? detail)) ?? "";
  const width = indentWidth(source);
  return width > 0 ? source.slice(0, width) : "  ";
}

/** A block's detail lines and its first-level subtasks with the lines below them. */
interface DetailParts {
  /** Indices of the block's lines that are neither tasks nor inside a subtask. */
  lines: number[];
  /** `[start, end)` line ranges of first-level subtasks, in order. */
  subtrees: [number, number][];
}

function detailParts(doc: TaskDocument, block: TaskBlock): DetailParts {
  const subtasks = new Set(block.subtasks.map((task) => task.line));
  const parts: DetailParts = { lines: [], subtrees: [] };
  let index = block.line + 1;
  while (index < block.end) {
    if (subtasks.has(index)) {
      let end = subtaskEnd(doc, block, index);
      // Blank lines after a subtask belong to whatever follows.
      while (end > index + 1 && (doc.lines[end - 1]?.text.trim() ?? "") === "") end -= 1;
      parts.subtrees.push([index, end]);
      index = end;
    } else {
      parts.lines.push(index);
      index += 1;
    }
  }
  return parts;
}

function trimBlankEnds(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start += 1;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(start, end);
}

interface DetailLine {
  /** The line as written. */
  raw: string;
  /** The line without the detail's common indentation; empty for blank lines. */
  text: string;
}

/** A block's detail lines, without blank lines at either end, and their common indentation. */
function readDetail(doc: TaskDocument, block: TaskBlock): { lines: DetailLine[]; indent: string } {
  const raws = detailParts(doc, block).lines.map((index) => doc.lines[index]?.text ?? "");
  let width = Infinity;
  let indent = "";
  for (const raw of raws) {
    if (raw.trim() === "") continue;
    const own = indentWidth(raw);
    if (own < width) {
      width = own;
      indent = raw.slice(0, own);
    }
  }
  const lines = raws.map((raw) => ({ raw, text: raw.trim() === "" ? "" : raw.slice(width) }));
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.text === "") start += 1;
  while (end > start && lines[end - 1]?.text === "") end -= 1;
  return { lines: lines.slice(start, end), indent };
}

/**
 * The detail of a top-level task: the indented lines of its block that are
 * not tasks and not under a subtask, without their common indentation and
 * without blank lines at either end. Empty when there is none.
 */
export function taskDetail(doc: TaskDocument, block: TaskBlock): string {
  return readDetail(doc, block)
    .lines.map((line) => line.text)
    .join("\n");
}

/** The fence marker still open at the end of `lines`, or `null`. */
function openFenceIn(lines: readonly string[]): string | null {
  let fence: string | null = null;
  for (const line of lines) {
    const marker = BLOCK_FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (closes(marker, fence)) fence = null;
    } else if (marker) {
      fence = marker;
    }
  }
  return fence;
}

/**
 * Replaces the detail of a top-level task. The detail lines go right after
 * the task line, followed by the subtasks in their order. Lines the user did
 * not change keep their bytes; new or changed lines get the detail's
 * indentation (the prefix of its least indented line, else the block's
 * subtask indentation, else two spaces). Blank lines inside the detail are
 * kept; whitespace-only lines become empty. A fenced code block left open
 * is closed at the end of the detail, so the subtasks after it stay tasks.
 * Unchanged detail is no edit.
 */
export function setTaskDetail(doc: TaskDocument, ref: TaskRef, input: string): TaskEdit | null {
  const line = locateTask(doc, ref);
  const block = doc.blocks.find((candidate) => candidate.line === line);
  const task = line === null ? undefined : doc.lines[line];
  if (!block || !task || line === null) return null;
  const typed = input.split(/\r\n?|\n/).map((part) => (part.trim() === "" ? "" : part));
  const detail = trimBlankEnds(typed);
  if (detail.join("\n") === taskDetail(doc, block)) return null;
  const fence = openFenceIn(detail);
  if (fence !== null) detail.push(fence);
  const current = readDetail(doc, block);
  const indent = current.indent || contentIndent(doc, block, "detail");
  let next = 0;
  const written = detail.map((text) => {
    // Unchanged lines are matched in order and keep their exact bytes.
    for (let index = next; index < current.lines.length; index += 1) {
      const known = current.lines[index];
      if (known?.text === text) {
        next = index + 1;
        return known.raw;
      }
    }
    return text === "" ? "" : indent + text;
  });
  const parts = detailParts(doc, block);
  const rebuilt: SourceLine[] = [
    task,
    ...written.map((text) => ({ text, eol: doc.separator })),
    ...parts.subtrees.flatMap(([start, end]) => doc.lines.slice(start, end)),
  ];
  const finalEol = doc.lines[doc.lines.length - 1]?.eol ?? "";
  const lines = [...doc.lines.slice(0, block.line), ...rebuilt, ...doc.lines.slice(block.end)].map(
    (source, index, all): SourceLine => {
      const eol = index === all.length - 1 ? finalEol : source.eol || doc.separator;
      return eol === source.eol ? source : { text: source.text, eol };
    },
  );
  return { text: joinLines(lines), focus: line };
}

/** The line that opens a fenced code block still open at the end of a block, or `null`. */
function openFenceInBlock(doc: TaskDocument, block: TaskBlock): number | null {
  let fence: string | null = null;
  let opened: number | null = null;
  for (let index = block.line + 1; index < block.end; index += 1) {
    const marker = BLOCK_FENCE.exec(doc.lines[index]?.text ?? "")?.[1];
    if (fence !== null) {
      if (closes(marker, fence)) {
        fence = null;
        opened = null;
      }
    } else if (marker) {
      fence = marker;
      opened = index;
    }
  }
  return opened;
}

function indentWidth(text: string): number {
  let width = 0;
  while (width < text.length && isBlank(text.charAt(width))) width += 1;
  return width;
}

/** Lines of the subtask on `line`: itself and the lines indented deeper below it, within its block. */
function subtaskEnd(doc: TaskDocument, block: TaskBlock, line: number): number {
  const width = indentWidth(doc.lines[line]?.text ?? "");
  let end = line + 1;
  while (end < block.end) {
    const text = doc.lines[end]?.text ?? "";
    if (text.trim() !== "" && indentWidth(text) <= width) break;
    end += 1;
  }
  return end;
}

/**
 * Removes the task on `line`: a top-level task with its whole block, a
 * subtask with the lines indented deeper below it. Focus goes to the task
 * that takes its place, else the one before it.
 */
export function deleteTask(doc: TaskDocument, ref: TaskRef): TaskDeletion | null {
  const line = locateTask(doc, ref);
  const block = line === null ? null : blockOf(doc, line);
  if (line === null || !block) return null;
  const start = line;
  const end = block.line === line ? block.end : subtaskEnd(doc, block, line);
  const removedLines = doc.lines.slice(start, end);
  const lines = doc.lines.slice();
  lines.splice(start, end - start);
  const text = joinLines(lines);
  return {
    text,
    focus: focusAfterRemoval(text, start),
    removed: {
      index: start,
      lines: removedLines,
      textAfter: text,
      previous: doc.lines[start - 1]?.text ?? null,
      next: doc.lines[end]?.text ?? null,
    },
  };
}

function focusAfterRemoval(text: string, index: number): number | null {
  const next = parseTaskDocument(text);
  let previous: number | null = null;
  for (const block of next.blocks) {
    for (const task of [block, ...block.subtasks]) {
      if (task.line >= index) return task.line;
      previous = task.line;
    }
  }
  return previous;
}

/** The only line with exactly this text, or -1. Blank lines never count. */
function uniqueLine(doc: TaskDocument, raw: string | null): number {
  if (raw === null || raw.trim() === "") return -1;
  let found = -1;
  for (let index = 0; index < doc.lines.length; index += 1) {
    if (doc.lines[index]?.text !== raw) continue;
    if (found !== -1) return -1;
    found = index;
  }
  return found;
}

/** Moves an insertion point that falls inside a block to the block's start or end. */
function outsideBlocks(doc: TaskDocument, index: number, toEnd: boolean): number {
  for (const block of doc.blocks) {
    if (block.line < index && index < block.end) return toEnd ? block.end : block.line;
  }
  return index;
}

/**
 * Where deleted lines go back. Unchanged text since the delete: exactly
 * where they were. Otherwise after the line that preceded them, else before
 * the line that followed them (when that line is unique), else at the old
 * index within the file. A top-level block never lands inside another block.
 */
function restoreIndex(doc: TaskDocument, removed: RemovedLines): number {
  if (doc.text === removed.textAfter) return removed.index;
  const nested = isIndented(removed.lines[0]?.text ?? "");
  const place = (index: number, toEnd: boolean) =>
    nested ? index : outsideBlocks(doc, index, toEnd);
  if (removed.previous === null) return place(0, false);
  const previous = uniqueLine(doc, removed.previous);
  if (previous !== -1) return place(previous + 1, true);
  const next = uniqueLine(doc, removed.next);
  if (next !== -1) return place(next, false);
  return place(Math.min(removed.index, doc.lines.length), true);
}

/** Puts deleted lines back; see `restoreIndex` for where. */
export function restoreLines(doc: TaskDocument, removed: RemovedLines): TaskEdit | null {
  if (removed.lines.length === 0) return null;
  const index = restoreIndex(doc, removed);
  const lines = insertLines(doc, index, removed.lines);
  return { text: joinLines(lines), focus: index };
}

/**
 * Swaps the open top-level task on `line` with the previous (`-1`) or next
 * (`1`) open top-level task of the same section. Done tasks and other lines
 * between them stay where they are; done tasks never move.
 */
export function moveTask(doc: TaskDocument, ref: TaskRef, direction: -1 | 1): TaskEdit | null {
  const line = locateTask(doc, ref);
  const position = doc.blocks.findIndex((block) => block.line === line);
  const block = doc.blocks[position];
  if (!block || block.done) return null;
  let index = position + direction;
  let other = doc.blocks[index];
  while (other?.done) {
    index += direction;
    other = doc.blocks[index];
  }
  if (!other || other.section !== block.section) return null;
  const [first, second] = direction < 0 ? [other, block] : [block, other];
  const lines = doc.lines;
  const finalEol = lines[lines.length - 1]?.eol ?? "";
  const swapped = [
    ...lines.slice(0, first.line),
    ...lines.slice(second.line, second.end),
    ...lines.slice(first.end, second.line),
    ...lines.slice(first.line, first.end),
    ...lines.slice(second.end),
  ].map((source, index, all): SourceLine => {
    const eol = index === all.length - 1 ? finalEol : source.eol || doc.separator;
    return eol === source.eol ? source : { text: source.text, eol };
  });
  const focus = direction < 0 ? first.line : second.end - (first.end - first.line);
  return { text: joinLines(swapped), focus };
}
