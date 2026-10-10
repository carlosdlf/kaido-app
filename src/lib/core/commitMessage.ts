/**
 * Readable, deterministic messages for automatic commits, and the record of
 * the app's own file operations that tells added and renamed files apart
 * from edits (git status only reports which paths changed).
 */

import { ARCHIVE_DIR, isListablePath, isTaskListPath } from "./workspace";

/**
 * One change to commit. `folder` marks renames and deletes that happened
 * because the app moved or deleted a whole project folder.
 */
export type FileChange =
  | { kind: "added" | "modified"; path: string }
  | { kind: "deleted"; path: string; folder?: boolean }
  | { kind: "renamed"; from: string; path: string; folder?: boolean };

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
    if (folderOf(change.from) !== folderOf(change.path)) {
      const full = `Move ${change.from} to ${change.path}`;
      if (full.length <= MAX_SUBJECT_LENGTH) return full;
      return fit(`Move ${nameOf(change.from)} to ${change.path}`);
    }
    const full = `Rename ${change.from} to ${nameOf(change.path)}`;
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

/** The project folder of a path: `a` for `a/x.md`, `_archive/a` for `_archive/a/x.md`. */
function projectFolder(path: string): string {
  const segments = path.split("/");
  const depth = segments[0] === ARCHIVE_DIR ? 2 : 1;
  return segments.length > depth ? segments.slice(0, depth).join("/") : "";
}

/** The project name of a project folder (without `_archive/`). */
function projectName(folder: string): string {
  return folder.startsWith(`${ARCHIVE_DIR}/`) ? folder.slice(ARCHIVE_DIR.length + 1) : folder;
}

/**
 * `Rename project a to b`, `Archive project a`, `Unarchive project a` or
 * `Delete project a`, when every change (task list edits aside, such as
 * links updated in other projects) moved or deleted one project folder.
 */
function projectSubject(changes: readonly FileChange[]): string | null {
  const core = changes.filter(
    (change) => !(change.kind === "modified" && isTaskListPath(change.path)),
  );
  const [first] = core;
  if (!first || !core.every((change) => "folder" in change && change.folder === true)) return null;
  if (first.kind === "deleted") {
    const folder = projectFolder(first.path);
    const same = core.every(
      (change) => change.kind === "deleted" && projectFolder(change.path) === folder,
    );
    return folder !== "" && same ? fit(`Delete project ${projectName(folder)}`) : null;
  }
  if (first.kind !== "renamed") return null;
  const from = projectFolder(first.from);
  const to = projectFolder(first.path);
  const same = core.every(
    (change) =>
      change.kind === "renamed" &&
      projectFolder(change.from) === from &&
      projectFolder(change.path) === to &&
      change.from.slice(from.length) === change.path.slice(to.length),
  );
  if (from === "" || to === "" || from === to || !same) return null;
  if (to === `${ARCHIVE_DIR}/${from}`) return fit(`Archive project ${from}`);
  if (from === `${ARCHIVE_DIR}/${to}`) return fit(`Unarchive project ${to}`);
  return fit(`Rename project ${projectName(from)} to ${projectName(to)}`);
}

/** A single note moved or renamed, with task list edits (updated links) aside. */
function movedNote(changes: readonly FileChange[]): FileChange | null {
  const core = changes.filter(
    (change) => !(change.kind === "modified" && isTaskListPath(change.path)),
  );
  const [only] = core;
  return core.length === 1 && only?.kind === "renamed" && only.folder !== true ? only : null;
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
  const moved = onlyTasks ? null : movedNote(sorted);
  let subject: string;
  if (onlyTasks) subject = tasksSubject(sorted);
  else if (moved) subject = singleSubject(moved);
  else {
    const project = projectSubject(sorted);
    if (project !== null) subject = project;
    else if (sorted.length === 1 && sorted[0]) subject = singleSubject(sorted[0]);
    else subject = groupSubject(sorted);
  }
  if (sorted.length === 1) return subject;
  const lines = sorted.slice(0, MAX_BODY_PATHS).map(bodyLine);
  if (sorted.length > MAX_BODY_PATHS) lines.push(`…and ${sorted.length - MAX_BODY_PATHS} more`);
  return `${subject}\n\n${lines.join("\n")}`;
}

type Hint = { kind: "added" } | { kind: "deleted" } | { kind: "renamed"; from: string };

/** A whole folder the app moved (`to` set) or deleted (`to` null). */
interface FolderHint {
  from: string;
  to: string | null;
}

function inside(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

/**
 * What the app itself did to files since the last commit. Git status only
 * says that a path changed; these hints say a file was created, deleted or
 * renamed by the app. Paths without a hint are edits, or deletions when the
 * file no longer exists.
 */
export class ChangeHints {
  readonly #hints = new Map<string, Hint>();
  /** Folder moves and deletes, oldest first. */
  #folders: FolderHint[] = [];

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

  /**
   * A whole folder was moved. Hints about files inside it move along, and
   * every file inside counts as renamed from its old place.
   */
  folderRenamed(from: string, to: string): void {
    for (const [path, hint] of [...this.#hints]) {
      if (!inside(path, from)) continue;
      this.#hints.delete(path);
      this.#hints.set(to + path.slice(from.length), hint);
    }
    this.#folders.push({ from, to });
  }

  /** A whole folder was deleted. */
  folderDeleted(path: string): void {
    this.#folders.push({ from: path, to: null });
  }

  /** Forgets hints about committed paths. */
  committed(paths: Iterable<string>): void {
    const committed = [...paths];
    for (const path of committed) this.#hints.delete(path);
    const touched = (folder: string) => committed.some((path) => inside(path, folder));
    this.#folders = this.#folders.filter(
      (hint) => !touched(hint.from) && (hint.to === null || !touched(hint.to)),
    );
  }

  clear(): void {
    this.#hints.clear();
    this.#folders = [];
  }

  /** Where a file was before the folder moves, or `null` when none moved it. */
  #folderOrigin(path: string): string | null {
    let current = path;
    for (let index = this.#folders.length - 1; index >= 0; index -= 1) {
      const hint = this.#folders[index];
      if (hint?.to != null && inside(current, hint.to)) {
        current = hint.from + current.slice(hint.to.length);
      }
    }
    return current === path ? null : current;
  }

  /** Whether a folder delete covers `path`. */
  #folderDeleted(path: string): boolean {
    return this.#folders.some((hint) => hint.to === null && inside(path, hint.from));
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
    if (this.#folders.length > 0) {
      for (const path of reported) {
        if (done.has(path) || this.#hints.has(path)) continue;
        const origin = this.#folderOrigin(path);
        if (origin === null || !reported.has(origin) || done.has(origin)) continue;
        done.add(origin).add(path);
        changes.push({ kind: "renamed", from: origin, path, folder: true });
      }
    }
    for (const path of reported) {
      if (done.has(path)) continue;
      done.add(path);
      const hint = this.#hints.get(path);
      const onDisk = exists(path);
      if (hint === undefined && onDisk !== true && this.#folderDeleted(path)) {
        changes.push({ kind: "deleted", path, folder: true });
      } else if (onDisk === false || (hint?.kind === "deleted" && onDisk !== true)) {
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
