/**
 * A fake git repository for `MemoryStorage`: enough of git's behavior to
 * exercise the sync flow in tests and in the browser preview. Commits are
 * snapshots of the workspace files; the upstream is another snapshot that
 * tests can move ahead with `addRemoteCommit`. States (missing git, paused
 * reasons, local-only branches) and failures (network, authentication…)
 * are set directly or queued with `failNext`.
 */

import {
  allowsCommit,
  isTemporaryPath,
  type CommitResult,
  type GitOperation,
  type GitStatus,
  type PausedReason,
  type SyncConflict,
  type SyncResult,
  type UnavailableReason,
} from "$lib/core/git";
import { conflictCopyPath } from "$lib/core/saveMachine";
import { isListablePath, WORKSPACE_CONFIG_PATH } from "$lib/core/workspace";
import { StorageError, type StorageErrorKind } from "./errors";

export interface MemoryGitOptions {
  /** Why git cannot be used, or `null` for a working repository. Default `not-a-repo`. */
  unavailable?: UnavailableReason | null;
  branch?: string;
  /** Default `null`: a local-only branch. */
  upstream?: string | null;
  /** Default: whether there is an upstream. */
  remote?: boolean;
  pausedReason?: PausedReason | null;
  operation?: GitOperation | null;
  /** Milliseconds each operation takes, to make states visible in the preview. */
  delay?: number;
}

export type GitOperationName = "status" | "commit" | "sync";
export type GitStorageErrorKind = Extract<StorageErrorKind, `Git${string}`>;

/** The workspace files the fake repository tracks. */
export interface GitHost {
  root(): string;
  files(): ReadonlyMap<string, { contents: string }>;
  now(): number;
  /** Changes a file in the working tree and reports it like the watcher. */
  write(path: string, contents: string | null): void;
}

interface RepoState {
  head: Map<string, string>;
  /** The upstream as last fetched or pushed. */
  remote: Map<string, string>;
  /** Commits on the upstream that are not fetched yet. */
  incoming: Record<string, string | null>[];
  ahead: number;
}

function snapshot(files: ReadonlyMap<string, { contents: string }>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [path, file] of files) if (!isTemporaryPath(path)) result.set(path, file.contents);
  return result;
}

function isResolvableNote(path: string): boolean {
  return isListablePath(path) && path !== WORKSPACE_CONFIG_PATH;
}

export class MemoryGit {
  unavailable: UnavailableReason | null;
  branch: string;
  upstream: string | null;
  remote: boolean;
  pausedReason: PausedReason | null;
  operation: GitOperation | null;
  delay: number;
  gitVersion = "2.43.0";
  /** Every commit made, oldest first. */
  readonly commits: { message: string; paths: string[] }[] = [];
  /** How many times each operation was called. */
  readonly calls: Record<GitOperationName, number> = { status: 0, commit: 0, sync: 0 };

  readonly #host: GitHost;
  readonly #repos = new Map<string, RepoState>();
  readonly #failures: Record<GitOperationName, StorageError[]> = {
    status: [],
    commit: [],
    sync: [],
  };
  readonly #gates: Record<GitOperationName, (() => Promise<void>)[]> = {
    status: [],
    commit: [],
    sync: [],
  };

  constructor(host: GitHost, options: MemoryGitOptions = {}) {
    this.#host = host;
    this.unavailable = options.unavailable === undefined ? "not-a-repo" : options.unavailable;
    this.branch = options.branch ?? "main";
    this.upstream = options.upstream ?? null;
    this.remote = options.remote ?? this.upstream !== null;
    this.pausedReason = options.pausedReason ?? null;
    this.operation = options.operation ?? null;
    this.delay = options.delay ?? 0;
  }

  /** The next call of `operation` fails with this error. Calls queue up. */
  failNext(operation: GitOperationName, kind: GitStorageErrorKind, message: string = kind): void {
    this.#failures[operation].push(new StorageError(kind, message));
  }

  /**
   * The next call of `operation` waits until the returned function is
   * called, so tests can look at the state while it runs.
   */
  hold(operation: GitOperationName): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.#gates[operation].push(() => gate);
    return release;
  }

  /** Someone else pushed a commit changing these files (`null` deletes). */
  addRemoteCommit(files: Record<string, string | null>): void {
    this.#repo().incoming.push({ ...files });
  }

  /**
   * The workspace was opened: its repository starts clean, with the files as
   * they are now committed and pushed.
   */
  opened(): void {
    this.#repo();
  }

  /** Commits not pushed yet. */
  get ahead(): number {
    return this.#repo().ahead;
  }

  /** Contents of the last commit. */
  get head(): ReadonlyMap<string, string> {
    return this.#repo().head;
  }

  #repo(): RepoState {
    const root = this.#host.root();
    let repo = this.#repos.get(root);
    if (!repo) {
      // A repository starts clean and in step with its upstream.
      const head = snapshot(this.#host.files());
      repo = { head, remote: new Map(head), incoming: [], ahead: 0 };
      this.#repos.set(root, repo);
    }
    return repo;
  }

  async #begin(operation: GitOperationName): Promise<void> {
    this.calls[operation] += 1;
    const gate = this.#gates[operation].shift();
    if (gate) await gate();
    if (this.delay > 0) await new Promise((resolve) => setTimeout(resolve, this.delay));
    const failure = this.#failures[operation].shift();
    if (failure) throw failure;
  }

  #changed(repo: RepoState): string[] {
    const current = snapshot(this.#host.files());
    const paths = new Set<string>();
    for (const [path, contents] of current) if (repo.head.get(path) !== contents) paths.add(path);
    for (const path of repo.head.keys()) if (!current.has(path)) paths.add(path);
    return [...paths].sort();
  }

  /** Refuses in an unavailable or paused state; some paused states allow commits only. */
  #check(forSync: boolean): void {
    if (this.unavailable !== null) {
      throw new StorageError("GitUnavailable", this.unavailable);
    }
    const reason = this.pausedReason;
    if (reason !== null && (forSync || !allowsCommit(reason))) {
      throw new StorageError("GitPaused", reason);
    }
  }

  async status(): Promise<GitStatus> {
    await this.#begin("status");
    if (this.unavailable !== null) return { state: "unavailable", reason: this.unavailable };
    const repo = this.#repo();
    const reason = this.pausedReason;
    const status: GitStatus = {
      state: reason === null ? "ready" : "paused",
      branch: reason === "detached-head" ? null : this.branch,
      upstream: this.upstream,
      remote: this.remote,
      ahead: repo.ahead,
      behind: 0,
      changed: this.#changed(repo),
      gitVersion: this.gitVersion,
    };
    if (reason !== null) status.pausedReason = reason;
    if (reason === "operation-in-progress") status.operation = this.operation ?? "rebase";
    return status;
  }

  async commit(message: string): Promise<CommitResult> {
    await this.#begin("commit");
    this.#check(false);
    const repo = this.#repo();
    const paths = this.#changed(repo);
    if (paths.length === 0) return { commit: null, paths: [] };
    repo.head = snapshot(this.#host.files());
    repo.ahead += 1;
    this.commits.push({ message, paths });
    return { commit: `c${this.commits.length}`, paths };
  }

  async sync(): Promise<SyncResult> {
    await this.#begin("sync");
    // "Sync now" re-checks `upstream-gone` and `outside-commits` after a
    // fetch; the pause stays until the user resolves it (here: a test clears
    // `pausedReason`). Nothing is pushed to get rid of it.
    this.#check(true);
    if (this.upstream === null) {
      throw new StorageError("GitFailed", "The current branch has no upstream branch.");
    }
    const repo = this.#repo();
    const incoming = repo.incoming;
    if (this.#changed(repo).length > 0) {
      // Fetched, but rebasing and pushing wait until the changes are committed.
      return { pulled: 0, pushed: 0, changed: [], conflicts: [], deferred: true };
    }
    // Paths changed both here and upstream that only a person can merge.
    const blocked = new Set<string>();
    for (const commit of incoming) {
      for (const path of Object.keys(commit)) {
        const local = repo.head.get(path);
        if (local !== repo.remote.get(path) && local !== commit[path] && !isResolvableNote(path)) {
          blocked.add(path);
        }
      }
    }
    if (blocked.size > 0) {
      throw new StorageError("GitPaused", `unmerged-files: ${[...blocked].sort().join(", ")}`);
    }

    const changed = new Set<string>();
    const conflicts: SyncConflict[] = [];
    const now = this.#host.now();
    for (const commit of incoming) {
      for (const [path, upstream] of Object.entries(commit)) {
        const local = repo.head.get(path);
        const base = repo.remote.get(path);
        if (local === base || local === undefined) {
          // Unchanged here, or deleted here but changed upstream: take upstream.
          if (upstream === null) repo.head.delete(path);
          else repo.head.set(path, upstream);
          changed.add(path);
        } else if (upstream === null || local === upstream) {
          // Deleted upstream but changed here: keep the change.
        } else {
          let attempt = 1;
          let copy = conflictCopyPath(path, now, attempt);
          while (repo.head.has(copy)) copy = conflictCopyPath(path, now, ++attempt);
          repo.head.set(copy, local);
          repo.head.set(path, upstream);
          changed.add(path).add(copy);
          conflicts.push({ path, copy });
        }
        if (upstream === null) repo.remote.delete(path);
        else repo.remote.set(path, upstream);
      }
    }
    const pushed = repo.ahead + (conflicts.length > 0 ? 1 : 0);
    repo.remote = new Map(repo.head);
    repo.incoming = [];
    repo.ahead = 0;
    const paths = [...changed].sort();
    for (const path of paths) this.#host.write(path, repo.head.get(path) ?? null);
    return { pulled: incoming.length, pushed, changed: paths, conflicts, deferred: false };
  }
}
