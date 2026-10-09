/**
 * Git data shared by storage backends and the sync scheduler. Git itself
 * runs in the backend; these types describe what it reports.
 */

/** Why committing or syncing is paused. The user resolves it with their own tools. */
export const PAUSED_REASONS = [
  "detached-head",
  "operation-in-progress",
  "unmerged-files",
  "outside-changes",
  "no-identity",
  "index-locked",
  "upstream-mismatch",
  "upstream-gone",
  "outside-commits",
  "local-merges",
] as const;
export type PausedReason = (typeof PAUSED_REASONS)[number];

/** Paused states that still allow commits; only pulling and pushing wait. */
const COMMITTABLE_REASONS: ReadonlySet<PausedReason> = new Set([
  "outside-changes",
  "upstream-mismatch",
  "upstream-gone",
  "outside-commits",
  "local-merges",
]);

/**
 * Paused states that "Sync now" re-checks: the backend fetches and
 * evaluates them again, and reports the pause again if it persists. It
 * never pushes to resolve them.
 */
const MANUAL_SYNC_REASONS: ReadonlySet<PausedReason> = new Set([
  "upstream-gone",
  "outside-commits",
]);

/** Whether a paused state still allows committing. */
export function allowsCommit(reason: PausedReason): boolean {
  return COMMITTABLE_REASONS.has(reason);
}

/**
 * The prefix of a `GitPaused` error from `git_sync` when pulling would
 * conflict in files that are not notes: `pull-conflict: <paths>`.
 */
export const PULL_CONFLICT = "pull-conflict";

/** A git operation left in progress in the repository. */
export const GIT_OPERATIONS = ["rebase", "merge", "cherry-pick", "revert", "bisect"] as const;
export type GitOperation = (typeof GIT_OPERATIONS)[number];

export const UNAVAILABLE_REASONS = ["git-missing", "not-a-repo"] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** The workspace is a git repository (or a folder inside one). */
export interface GitRepoStatus {
  state: "ready" | "paused";
  pausedReason?: PausedReason;
  operation?: GitOperation;
  /** `null` when HEAD is detached. */
  branch: string | null;
  /** E.g. `origin/main`; `null` means local only: commit, but no pull or push. */
  upstream: string | null;
  /** Whether any remote is configured. */
  remote: boolean;
  /** Commits ahead of and behind the upstream, as last fetched. */
  ahead: number;
  behind: number;
  /** Workspace-relative paths with uncommitted changes, untracked ones included. */
  changed: string[];
  gitVersion: string;
  /** Extra explanation of a paused state, e.g. how to finish an interrupted rebase. */
  pausedMessage?: string;
}

export type GitStatus = { state: "unavailable"; reason: UnavailableReason } | GitRepoStatus;

export interface CommitResult {
  /** The new commit, or `null` when there was nothing to commit. */
  commit: string | null;
  /** Committed workspace-relative paths. */
  paths: string[];
}

export interface SyncConflict {
  /** The note, now holding the upstream version. */
  path: string;
  /** Where the local version was kept. */
  copy: string;
}

export interface SyncResult {
  /** Commits integrated from the upstream. */
  pulled: number;
  /** Commits pushed. */
  pushed: number;
  /** Workspace-relative paths changed by the pull. */
  changed: string[];
  conflicts: SyncConflict[];
  /** Rebase and push were skipped because the workspace had uncommitted changes. */
  deferred: boolean;
}

/** Whether new commits can be made: ready, or paused for a reason that only blocks syncing. */
export function canCommit(status: GitStatus): status is GitRepoStatus {
  if (status.state === "unavailable") return false;
  if (status.state === "ready") return true;
  return status.pausedReason !== undefined && allowsCommit(status.pausedReason);
}

/** Whether pulling and pushing are possible: ready with an upstream. */
export function canSync(status: GitStatus): status is GitRepoStatus {
  return status.state === "ready" && status.upstream !== null;
}

/** Whether "Sync now" may call sync (to re-check the pause) although automatic syncing is paused. */
export function canSyncManually(status: GitStatus): status is GitRepoStatus {
  if (status.state !== "paused" || status.pausedReason === undefined) return false;
  return MANUAL_SYNC_REASONS.has(status.pausedReason);
}

/** Temporary files that are never committed. */
export function isTemporaryPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    /^\.kaido-.*\.tmp$/.test(name) || path.split("/").some((part) => part.startsWith(".Trash-"))
  );
}
