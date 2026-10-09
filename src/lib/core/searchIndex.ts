/**
 * Full-text search over notes, tasks and projects, for the search palette.
 *
 * The index is kept in memory and updated one document at a time: a note
 * when its text is read or saved, the tasks of a list when the list
 * changes, the projects when the workspace listing changes. Nothing is
 * ever rebuilt as a whole, so results cover whatever has been read so far.
 *
 * Text is split into runs of Unicode letters, digits and combining marks;
 * everything else (spaces, `/`, `-`, `_`, `.`) separates words. Case and
 * diacritics are folded on both sides, so `cafe` finds `Café`. Every query
 * word must match (prefix matches count, and words of four or more
 * characters may have a small typo). While every query word is shorter
 * than three characters only titles, paths and project names are searched,
 * so the first keystrokes stay fast in a large workspace.
 *
 * Notes larger than `FULL_TEXT_MAX_BYTES` are found by title and path only.
 * Notes can also be queued and indexed later in one go, so a save never
 * pays for tokenizing a note on the input path; a search indexes the queue
 * first.
 *
 * Results carry plain text and match ranges, never markup.
 */

import MiniSearch, { type SearchResult as RawResult } from "minisearch";
import { fileStem, noteTitle } from "./markdown";
import { utf8Length } from "./noteNames";
import { textWithoutLinks } from "./taskLinks";
import type { TaskDocument, TaskLine } from "./taskDocument";

export type SearchKind = "note" | "task" | "project" | "list";

/** A `[start, end)` range of UTF-16 offsets in a result's text. */
export interface TextRange {
  start: number;
  end: number;
}

export interface Snippet {
  text: string;
  /** Matched words in `text`. */
  ranges: TextRange[];
}

export interface SearchResult {
  kind: SearchKind;
  /** Unique among results. */
  id: string;
  /** The note or task list path; the project name for projects. */
  path: string;
  title: string;
  /** Matched words in `title`. */
  titleRanges: TextRange[];
  /** For a note whose text matched: the text around the first match. */
  snippet?: Snippet;
  /**
   * For a task, the index of its line. For a note that matched in its text
   * but not in its title, the index of the line with the first match.
   */
  line?: number;
  /** For a task: the whole line as written, to find it again. */
  raw?: string;
  /** For a task: whether it is done. */
  done?: boolean;
}

export interface SearchOptions {
  /** Most results returned. */
  limit?: number;
}

/** Notes and task lists remembered as recently opened. */
export const RECENT_LIMIT = 10;
export const DEFAULT_LIMIT = 50;
/** Queries whose words are all shorter than this only search titles, paths and project names. */
export const FULL_TEXT_MIN_LENGTH = 3;
/** Notes larger than this (UTF-8) are indexed by title and path only. */
export const FULL_TEXT_MAX_BYTES = 256 * 1024;
/** Rough length of a snippet. */
export const SNIPPET_LENGTH = 80;
/** Text kept before the match when a snippet is cut out of a long line. */
const SNIPPET_LEAD = 24;

const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;
const MARKS = /\p{M}/gu;
const LINE_BREAK = /\r\n|\r|\n/g;
const MARKDOWN_EXTENSION = /\.md$/i;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** Lower case without diacritics: what the index stores and queries compare. */
export function foldTerm(term: string): string {
  return term.toLowerCase().normalize("NFD").replace(MARKS, "");
}

/** The words of `text`, as written. */
export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Ranges of the words in `text` whose folded form is in `terms`. */
export function matchRanges(text: string, terms: ReadonlySet<string>): TextRange[] {
  const ranges: TextRange[] = [];
  if (terms.size === 0) return ranges;
  for (const match of text.matchAll(TOKEN)) {
    if (terms.has(foldTerm(match[0]))) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

/**
 * Offset of the first word of `text` (from `from` on) whose folded form is
 * in `terms`, or `null`. Searching the lower-cased text finds the usual
 * case quickly; words that only match once diacritics are folded fall back
 * to a scan.
 */
export function firstMatch(text: string, terms: ReadonlySet<string>, from = 0): TextRange | null {
  if (terms.size === 0 || from >= text.length) return null;
  const lower = text.toLowerCase();
  // Lower-casing a few characters changes the length; then offsets would not match.
  if (lower.length === text.length) {
    let best: TextRange | null = null;
    for (const term of terms) {
      let at = lower.indexOf(term, from);
      while (at !== -1 && (best === null || at < best.start)) {
        const end = at + term.length;
        if (!WORD_CHAR.test(lower[at - 1] ?? "") && !WORD_CHAR.test(lower[end] ?? "")) {
          best = { start: at, end };
          break;
        }
        at = lower.indexOf(term, at + 1);
      }
    }
    if (best) return best;
  }
  const rest = from === 0 ? text : text.slice(from);
  for (const match of rest.matchAll(TOKEN)) {
    if (terms.has(foldTerm(match[0]))) {
      return { start: from + match.index, end: from + match.index + match[0].length };
    }
  }
  return null;
}

/** Index of the line that contains `offset`, counting any kind of line break. */
export function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).match(LINE_BREAK)?.length ?? 0;
}

/** The text around `match`: its line, cut to about `SNIPPET_LENGTH` characters. */
export function snippetAround(text: string, match: TextRange, terms: ReadonlySet<string>): Snippet {
  let lineStart = match.start;
  while (lineStart > 0 && text[lineStart - 1] !== "\n" && text[lineStart - 1] !== "\r") {
    lineStart -= 1;
  }
  let lineEnd = match.end;
  while (lineEnd < text.length && text[lineEnd] !== "\n" && text[lineEnd] !== "\r") lineEnd += 1;
  let start = lineStart;
  let end = lineEnd;
  if (end - start > SNIPPET_LENGTH) {
    start = Math.max(lineStart, match.start - SNIPPET_LEAD);
    end = Math.min(lineEnd, Math.max(start + SNIPPET_LENGTH, match.end));
  }
  const before = start > lineStart ? "…" : "";
  const after = end < lineEnd ? "…" : "";
  // Leading and trailing spaces add nothing.
  while (start < match.start && /\s/u.test(text[start] ?? "")) start += 1;
  while (end > match.end && /\s/u.test(text[end - 1] ?? "")) end -= 1;
  const body = text.slice(start, end);
  const ranges = matchRanges(body, terms).map((range) => ({
    start: range.start + before.length,
    end: range.end + before.length,
  }));
  return { text: `${before}${body}${after}`, ranges };
}

interface IndexedDoc {
  id: string;
  title?: string;
  path?: string;
  body?: string;
}

interface NoteMeta {
  kind: "note";
  path: string;
  title: string;
  /** The note's text, or `null` when it is not known (too large to read). */
  text: string | null;
  /** The indexed text, or `null` when only its title and path are indexed. */
  body: string | null;
}

interface TaskMeta {
  kind: "task";
  path: string;
  title: string;
  line: number;
  raw: string;
  done: boolean;
}

interface ProjectMeta {
  kind: "project";
  name: string;
}

type Meta = NoteMeta | TaskMeta | ProjectMeta;

const PROJECT_PREFIX = "project:";

function projectId(name: string): string {
  return `${PROJECT_PREFIX}${name}`;
}

/**
 * Tasks are keyed by their text and how many identical lines come before
 * them, not by line number: inserting or moving a task then changes the
 * keys of no other task, so only that task is indexed again.
 */
function taskId(path: string, occurrence: number, task: TaskLine): string {
  return `${path}#${occurrence}\n${task.raw}`;
}

/** Whether `text` is small enough to index in full. */
function fullTextFits(text: string): boolean {
  // UTF-8 takes at least one and at most three bytes per UTF-16 unit.
  if (text.length > FULL_TEXT_MAX_BYTES) return false;
  if (text.length * 3 <= FULL_TEXT_MAX_BYTES) return true;
  return utf8Length(text) <= FULL_TEXT_MAX_BYTES;
}

function* allTasks(doc: TaskDocument): Generator<TaskLine> {
  for (const block of doc.blocks) {
    yield block;
    yield* block.subtasks;
  }
}

const HEADING_LINE = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/;

/**
 * The first match in a note's text that is not on the heading its title
 * comes from: the title is shown anyway, so the snippet shows something new.
 */
function firstBodyMatch(body: string, title: string, terms: ReadonlySet<string>): TextRange | null {
  const match = firstMatch(body, terms);
  if (!match) return null;
  const lineStart = Math.max(body.lastIndexOf("\n", match.start - 1) + 1, 0);
  const newline = body.indexOf("\n", match.end);
  const lineEnd = newline === -1 ? body.length : newline;
  const heading = HEADING_LINE.exec(body.slice(lineStart, lineEnd).replace(/\r$/, ""));
  if (heading?.[1]?.trim() !== title) return match;
  return firstMatch(body, terms, lineEnd);
}

function notePathField(path: string): string {
  return path.replace(MARKDOWN_EXTENSION, "");
}

export class SearchIndex {
  readonly #mini = new MiniSearch<IndexedDoc>({
    fields: ["title", "path", "body"],
    tokenize,
    processTerm: (term) => foldTerm(term) || null,
    searchOptions: {
      boost: { title: 3, path: 1.5, body: 1 },
      prefix: true,
      fuzzy: (term) => (term.length >= 4 ? 0.2 : false),
      combineWith: "AND",
    },
  });
  readonly #meta = new Map<string, Meta>();
  /** Ids of the indexed tasks of each task list. */
  readonly #taskIds = new Map<string, Set<string>>();
  /** The document each task list was indexed from. */
  readonly #taskDocs = new Map<string, TaskDocument>();
  /** Notes waiting to be indexed by `flushQueued`, by path. */
  readonly #queued = new Map<string, string | null>();
  #projects: string[] = [];
  /** Recently opened paths, most recent first. */
  #recent: string[] = [];

  /** Indexed notes. */
  get noteCount(): number {
    let count = 0;
    for (const meta of this.#meta.values()) if (meta.kind === "note") count += 1;
    return count;
  }

  /** Indexed tasks. */
  get taskCount(): number {
    let count = 0;
    for (const ids of this.#taskIds.values()) count += ids.size;
    return count;
  }

  /** Whether a note is indexed or queued. */
  hasNote(path: string): boolean {
    return this.#meta.get(path)?.kind === "note" || this.#queued.has(path);
  }

  /** Notes queued and not indexed yet. */
  get queuedCount(): number {
    return this.#queued.size;
  }

  /**
   * Adds or replaces a note. With `text` `null` (a note too large to read)
   * only its file name and path are indexed. Unchanged text is skipped.
   */
  upsertNote(path: string, text: string | null): void {
    this.#queued.delete(path);
    this.#upsert(path, text);
  }

  /**
   * Like `upsertNote`, but only remembers the text until `flushQueued` (or
   * a search) runs. Returns `true` when the queue was empty, so the caller
   * knows to schedule a flush.
   */
  queueNote(path: string, text: string | null): boolean {
    const wasEmpty = this.#queued.size === 0;
    this.#queued.set(path, text);
    return wasEmpty;
  }

  /** Indexes the queued notes. */
  flushQueued(): void {
    if (this.#queued.size === 0) return;
    const queued = [...this.#queued];
    this.#queued.clear();
    for (const [path, text] of queued) this.#upsert(path, text);
  }

  removeNote(path: string): void {
    this.#queued.delete(path);
    if (this.#meta.get(path)?.kind !== "note") return;
    this.#discard(path);
    this.#recent = this.#recent.filter((recent) => recent !== path);
  }

  /** Moves a note to its new path; its title is taken again, since it may come from the name. */
  renameNote(from: string, to: string): void {
    if (from === to) return;
    if (this.#queued.has(from)) {
      this.#queued.set(to, this.#queued.get(from) ?? null);
      this.#queued.delete(from);
    }
    const meta = this.#meta.get(from);
    if (meta?.kind !== "note") return;
    this.#discard(from);
    this.#upsert(to, meta.text);
    this.#recent = this.#recent.map((recent) => (recent === from ? to : recent));
  }

  /** Removes every note for which `keep` returns false. */
  retainNotes(keep: (path: string) => boolean): void {
    for (const path of [...this.#queued.keys()]) if (!keep(path)) this.#queued.delete(path);
    for (const [id, meta] of [...this.#meta]) {
      if (meta.kind === "note" && !keep(id)) this.removeNote(id);
    }
  }

  #upsert(path: string, text: string | null): void {
    const current = this.#meta.get(path);
    if (current?.kind === "note" && current.text === text) return;
    if (current) this.#discard(path);
    const title = text === null ? fileStem(path) : noteTitle(path, text);
    const body = text !== null && fullTextFits(text) ? text : null;
    const doc: IndexedDoc = { id: path, title, path: notePathField(path) };
    if (body !== null) doc.body = body;
    this.#mini.add(doc);
    this.#meta.set(path, { kind: "note", path, title, text, body });
  }

  /**
   * Indexes the tasks of a task list (top-level and nested). Tasks whose
   * text did not change are kept in the index; only their line is updated.
   */
  setTaskList(path: string, doc: TaskDocument): void {
    if (this.#taskDocs.get(path) === doc) return;
    this.#taskDocs.set(path, doc);
    const previous = this.#taskIds.get(path) ?? new Set<string>();
    const next = new Set<string>();
    const seen = new Map<string, number>();
    for (const task of allTasks(doc)) {
      const occurrence = seen.get(task.raw) ?? 0;
      seen.set(task.raw, occurrence + 1);
      const id = taskId(path, occurrence, task);
      next.add(id);
      if (previous.has(id)) {
        // Same text; the line lives in the meta only.
        this.#meta.set(id, this.#taskMeta(path, task));
        continue;
      }
      const title = textWithoutLinks(task.text) || task.text;
      this.#mini.add({ id, body: title });
      this.#meta.set(id, this.#taskMeta(path, task));
    }
    for (const id of previous) if (!next.has(id)) this.#discard(id);
    this.#taskIds.set(path, next);
  }

  removeTaskList(path: string): void {
    const ids = this.#taskIds.get(path);
    if (!ids) return;
    for (const id of ids) this.#discard(id);
    this.#taskIds.delete(path);
    this.#taskDocs.delete(path);
    this.#recent = this.#recent.filter((recent) => recent !== path);
  }

  /**
   * Brings the indexed tasks in line with `docs`: lists whose document
   * changed are indexed again, lists not in `docs` (or not kept) are dropped.
   */
  syncTaskLists(docs: ReadonlyMap<string, TaskDocument>, keep: (path: string) => boolean): void {
    for (const path of [...this.#taskIds.keys()]) {
      if (!docs.has(path) || !keep(path)) this.removeTaskList(path);
    }
    for (const [path, doc] of docs) if (keep(path)) this.setTaskList(path, doc);
  }

  /** Sets the projects, in the order they are listed. */
  setProjects(names: readonly string[]): void {
    const next = new Set(names);
    for (const name of this.#projects) {
      if (!next.has(name)) this.#discard(projectId(name));
    }
    const previous = new Set(this.#projects);
    for (const name of next) {
      if (previous.has(name)) continue;
      const id = projectId(name);
      this.#mini.add({ id, title: name });
      this.#meta.set(id, { kind: "project", name });
    }
    this.#projects = [...next];
  }

  /** Remembers that a note or task list was opened. */
  touch(path: string): void {
    this.#recent = [path, ...this.#recent.filter((recent) => recent !== path)].slice(
      0,
      RECENT_LIMIT,
    );
  }

  /** Recently opened paths, most recent first. */
  get recent(): readonly string[] {
    return this.#recent;
  }

  clear(): void {
    this.#mini.removeAll();
    this.#meta.clear();
    this.#taskIds.clear();
    this.#taskDocs.clear();
    this.#queued.clear();
    this.#projects = [];
    this.#recent = [];
  }

  /**
   * Ranked results for `query`, grouped by kind: the kind of the best
   * result first, then the kind of the best remaining result, and so on.
   * An empty query lists the recently opened notes and lists, then the
   * projects.
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    this.flushQueued();
    const limit = options.limit ?? DEFAULT_LIMIT;
    const words = tokenize(query)
      .map(foldTerm)
      .filter((word) => word !== "");
    if (words.length === 0) {
      return [...this.#recentResults(), ...this.#projectResults()].slice(0, limit);
    }
    // Words this short match too much text to rank it quickly; names are enough.
    const short = words.every((word) => word.length < FULL_TEXT_MIN_LENGTH);
    const raw = this.#mini
      .search(query, short ? { fields: ["title", "path"] } : {})
      .slice(0, limit);
    const groups = new Map<SearchKind, SearchResult[]>();
    for (const hit of raw) {
      const result = this.#result(hit);
      if (!result) continue;
      const group = groups.get(result.kind);
      if (group) group.push(result);
      else groups.set(result.kind, [result]);
    }
    // Results come best first, so groups are created in the order of their best result.
    return [...groups.values()].flat();
  }

  #taskMeta(path: string, task: TaskLine): TaskMeta {
    const title = textWithoutLinks(task.text) || task.text;
    return { kind: "task", path, title, line: task.line, raw: task.raw, done: task.done };
  }

  #discard(id: string): void {
    if (!this.#meta.has(id)) return;
    this.#mini.discard(id);
    this.#meta.delete(id);
  }

  #result(hit: RawResult): SearchResult | null {
    const id = String(hit.id);
    const meta = this.#meta.get(id);
    if (!meta) return null;
    const terms = new Set(hit.terms);
    if (meta.kind === "project") {
      return {
        kind: "project",
        id,
        path: meta.name,
        title: meta.name,
        titleRanges: matchRanges(meta.name, terms),
      };
    }
    if (meta.kind === "task") {
      return {
        kind: "task",
        id,
        path: meta.path,
        title: meta.title,
        titleRanges: matchRanges(meta.title, terms),
        line: meta.line,
        raw: meta.raw,
        done: meta.done,
      };
    }
    const fields = (term: string) => hit.match[term] ?? [];
    const titleTerms = new Set(hit.terms.filter((term) => fields(term).includes("title")));
    const bodyTerms = new Set(hit.terms.filter((term) => fields(term).includes("body")));
    const result: SearchResult = {
      kind: "note",
      id,
      path: meta.path,
      title: meta.title,
      titleRanges: matchRanges(meta.title, titleTerms),
    };
    if (meta.body !== null && bodyTerms.size > 0) {
      const match = firstBodyMatch(meta.body, meta.title, bodyTerms);
      if (match) {
        result.snippet = snippetAround(meta.body, match, bodyTerms);
        if (titleTerms.size === 0) result.line = lineAt(meta.body, match.start);
      }
    }
    return result;
  }

  #recentResults(): SearchResult[] {
    const results: SearchResult[] = [];
    for (const path of this.#recent) {
      const meta = this.#meta.get(path);
      if (meta?.kind === "note") {
        results.push({ kind: "note", id: path, path, title: meta.title, titleRanges: [] });
      } else if (this.#taskIds.has(path)) {
        results.push({ kind: "list", id: path, path, title: path, titleRanges: [] });
      }
    }
    return results;
  }

  #projectResults(): SearchResult[] {
    return this.#projects.map((name) => ({
      kind: "project",
      id: projectId(name),
      path: name,
      title: name,
      titleRanges: [],
    }));
  }
}

export interface TextSegment {
  text: string;
  match: boolean;
}

/** Splits `text` into matched and unmatched parts, for highlighting. */
export function highlightSegments(text: string, ranges: readonly TextRange[]): TextSegment[] {
  const segments: TextSegment[] = [];
  let position = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(range.start, position);
    const end = Math.min(range.end, text.length);
    if (end <= start) continue;
    if (start > position) segments.push({ text: text.slice(position, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    position = end;
  }
  if (position < text.length) segments.push({ text: text.slice(position), match: false });
  return segments;
}
