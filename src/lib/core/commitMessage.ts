/**
 * Readable, deterministic messages for automatic commits, and the record of
 * the app's own file operations that tells added and renamed files apart
 * from edits (git status only reports which paths changed).
 */

import { isListablePath, isTaskListPath } from "./workspace";

export type FileChange =
  | { kind: "added" | "modified" | "deleted"; path: string }
  | { kind: "renamed"; from: string; path: string };

/** Longest subject line, as git tooling expects. */
export const MAX_SUBJECT_LENGTH = 72;
/** Paths listed in the body before the rest is summarized. */
export const MAX_BODY_PATHS = 20;

const VERBS = { added: "Add", modified: "Update", deleted: "Delete", renamed: "Rename" } as const;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Top-level folder of a path; loose files at the root have none (`""`). */
function topFolder(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function isNotePath(path: string): boolean {
  return /\.md$/i.test(path) && !isTaskListPath(path);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Cuts a subject to the limit with an ellipsis, on a character boundary. */
function fit(subject: string): string {
  const chars = Array.from(subject);
  if (chars.length <= MAX_SUBJECT_LENGTH) return subject;
  return `${chars.slice(0, MAX_SUBJECT_LENGTH - 1).join("")}…`;
}

/** `Update a/b.md`, shortened to the file name when the path is too long. */
function singleSubject(change: FileChange): string {
  if (change.kind === "renamed") {
    const target =
      folderOf(change.from) === folderOf(change.path) ? nameOf(change.path) : change.path;
    const full = `Rename ${change.from} to ${target}`;
    if (full.length <= MAX_SUBJECT_LENGTH) return full;
    return fit(`Rename ${nameOf(change.from)} to ${nameOf(change.path)}`);
  }
  const verb = VERBS[change.kind];
  const full = `${verb} ${change.path}`;
  if (full.length <= MAX_SUBJECT_LENGTH) return full;
  return fit(`${verb} ${nameOf(change.path)}`);
}

/** `Update tasks in inbox`, `… in inbox and api`, `… in 3 projects`. */
function tasksSubject(changes: readonly FileChange[]): string {
  const projects = [...new Set(changes.map((change) => folderOf(change.path)))].sort(compare);
  const [first = "", second = ""] = projects;
  if (projects.length === 1) {
    const subject = `Update tasks in ${first}`;
    if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
  } else if (projects.length === 2) {
    const subject = `Update tasks in ${first} and ${second}`;
    if (subject.length <= MAX_SUBJECT_LENGTH) return subject;
  }
  return `Update tasks in ${plural(projects.length, "project")}`;
}

/** `Update 5 notes in api`, `Add 2 notes in inbox`, `Update 7 files in 3 projects`. */
function groupSubject(changes: readonly FileChange[]): string {
  const kinds = new Set(changes.map((change) => change.kind));
  const [only] = kinds;
  const verb =
    kinds.size === 1 && (only === "added" || only === "deleted") ? VERBS[only] : "Update";
  const noun = changes.every((change) => isNotePath(change.path)) ? "note" : "file";
  const what = `${verb} ${plural(changes.length, noun)}`;
  const folders = new Set(changes.map((change) => topFolder(change.path)));
  const [folder = ""] = folders;
  if (folders.size > 1) return `${what} in ${plural(folders.size, "project")}`;
  if (folder === "") return what;
  const subject = `${what} in ${folder}`;
  return subject.length <= MAX_SUBJECT_LENGTH ? subject : what;
}

function bodyLine(change: FileChange): string {
  return change.kind === "renamed" ? `${change.from} -> ${change.path}` : change.path;
}

/**
 * The commit message for a set of changes: a subject of at most 72
 * characters and, for more than one change, a body listing the paths (at
 * most 20, then `…and N more`). `null` when nothing changed.
 */
export function commitMessage(changes: readonly FileChange[]): string | null {
  if (changes.length === 0) return null;
  const sorted = [...changes].sort((a, b) => compare(a.path, b.path));
  const onlyTasks = sorted.every(
    (change) =>
      (change.kind === "added" || change.kind === "modified") && isTaskListPath(change.path),
  );
  let subject: string;
  if (onlyTasks) subject = tasksSubject(sorted);
  else if (sorted.length === 1 && sorted[0]) subject = singleSubject(sorted[0]);
  else subject = groupSubject(sorted);
  if (sorted.length === 1) return subject;
  const lines = sorted.slice(0, MAX_BODY_PATHS).map(bodyLine);
  if (sorted.length > MAX_BODY_PATHS) lines.push(`…and ${sorted.length - MAX_BODY_PATHS} more`);
  return `${subject}\n\n${lines.join("\n")}`;
}

type Hint = { kind: "added" } | { kind: "deleted" } | { kind: "renamed"; from: string };

/**
 * What the app itself did to files since the last commit. Git status only
 * says that a path changed; these hints say a file was created, deleted or
 * renamed by the app. Paths without a hint are edits, or deletions when the
 * file no longer exists.
 */
export class ChangeHints {
  readonly #hints = new Map<string, Hint>();

  /** A file was created where none existed. */
  created(path: string): void {
    const previous = this.#hints.get(path);
    // Deleted and created again: compared with the last commit it was edited.
    if (previous?.kind === "deleted") this.#hints.delete(path);
    else this.#hints.set(path, { kind: "added" });
  }

  deleted(path: string): void {
    const previous = this.#hints.get(path);
    if (previous?.kind === "added") {
      // Never committed, so git sees nothing.
      this.#hints.delete(path);
      return;
    }
    if (previous?.kind === "renamed") {
      this.#hints.delete(path);
      this.#hints.set(previous.from, { kind: "deleted" });
      return;
    }
    this.#hints.set(path, { kind: "deleted" });
  }

  renamed(from: string, to: string): void {
    const previous = this.#hints.get(from);
    this.#hints.delete(from);
    if (previous?.kind === "added") {
      this.#hints.set(to, { kind: "added" });
      return;
    }
    const origin = previous?.kind === "renamed" ? previous.from : from;
    // Renamed back to where it started: at most an edit.
    if (origin === to) this.#hints.delete(to);
    else this.#hints.set(to, { kind: "renamed", from: origin });
  }

  /** Forgets hints about committed paths. */
  committed(paths: Iterable<string>): void {
    for (const path of paths) this.#hints.delete(path);
  }

  clear(): void {
    this.#hints.clear();
  }

  /**
   * Describes the paths git reports as changed. `exists` says whether a path
   * is still on disk (`undefined` when unknown, e.g. files that are not
   * notes). A rename whose old path git also reports becomes one change.
   */
  describe(
    changed: readonly string[],
    exists: (path: string) => boolean | undefined,
  ): FileChange[] {
    // Linear in the number of paths: every lookup is a set or map access.
    const reported = new Set(changed);
    /** Paths already described, as a change or as the old path of a rename. */
    const done = new Set<string>();
    const changes: FileChange[] = [];
    for (const path of reported) {
      const hint = this.#hints.get(path);
      if (hint?.kind === "renamed" && reported.has(hint.from) && exists(path) !== false) {
        done.add(hint.from).add(path);
        changes.push({ kind: "renamed", from: hint.from, path });
      }
    }
    for (const path of reported) {
      if (done.has(path)) continue;
      done.add(path);
      const hint = this.#hints.get(path);
      const onDisk = exists(path);
      if (onDisk === false || (hint?.kind === "deleted" && onDisk !== true)) {
        changes.push({ kind: "deleted", path });
      } else if (hint?.kind === "added" || hint?.kind === "renamed") {
        // A renamed file whose old path was never committed is new to git.
        changes.push({ kind: "added", path });
      } else {
        changes.push({ kind: "modified", path });
      }
    }
    return changes;
  }
}

/**
 * Whether a path is on disk according to a listing of notes: `true` or
 * `false` for listable paths, `undefined` for files the listing does not
 * cover. Builds a set once, so each check is constant time.
 */
export function listingLookup(listed: Iterable<string>): (path: string) => boolean | undefined {
  const paths = new Set(listed);
  return (path) => (isListablePath(path) ? paths.has(path) : undefined);
}
