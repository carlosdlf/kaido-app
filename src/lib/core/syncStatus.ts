/** How the sync state is shown: a short status line with an icon and tooltip details. */

import {
  PAUSED_REASONS,
  PULL_CONFLICT,
  type GitOperation,
  type GitStatus,
  type PausedReason,
} from "./git";
import type { SyncProblem, SyncSnapshot } from "./syncScheduler";
import { formatAge } from "./time";

export type SyncIcon =
  | "checking"
  | "synced"
  | "syncing"
  | "pending"
  | "local"
  | "offline"
  | "paused"
  | "failed"
  | "unavailable";

/** `ok` success color, `busy` and `muted` secondary text, `warning` paused, `error` failures. */
export type SyncTone = "ok" | "busy" | "muted" | "warning" | "error";

export interface SyncView {
  icon: SyncIcon;
  tone: SyncTone;
  /** The status line, e.g. `synced · 2m ago`. */
  text: string;
  /** Tooltip lines. */
  details: string[];
}

const SHORT_REASONS: Record<PausedReason, string> = {
  "detached-head": "detached HEAD",
  "operation-in-progress": "git operation in progress",
  "unmerged-files": "unmerged files",
  "outside-changes": "changes outside workspace",
  "no-identity": "no git identity",
  "index-locked": "git index locked",
  "upstream-mismatch": "upstream mismatch",
  "upstream-gone": "upstream gone",
  "outside-commits": "unpushed commits outside",
  "local-merges": "unpushed merge commits",
};

/** A sentence explaining why syncing is paused and how to resume it. */
export function pausedReasonText(reason: PausedReason, operation?: GitOperation): string {
  switch (reason) {
    case "detached-head":
      return "Git is not on a branch. Check out a branch to resume syncing.";
    case "operation-in-progress":
      return `A git ${operation ?? "operation"} is in progress. Finish or abort it to resume syncing.`;
    case "unmerged-files":
      return "The repository has unresolved conflicts. Resolve them with git to resume syncing.";
    case "outside-changes":
      return "Files outside this workspace have uncommitted changes. Notes are still committed, but pulling is paused until those changes are committed or stashed.";
    case "no-identity":
      return "Git has no user name or email. Set user.name and user.email to resume committing.";
    case "index-locked":
      return "Git is busy or a previous git command crashed (index.lock). Remove the repository's index.lock if no git command is running.";
    case "upstream-mismatch":
      return "The branch tracks a different branch or remote. Kaido only syncs a branch with its same-named upstream.";
    case "upstream-gone":
      return "The upstream branch isn't on the remote (deleted or never pushed). Push it once with git to resume syncing.";
    case "outside-commits":
      return "There are unpushed commits outside the notes folder. Push them yourself to resume syncing.";
    case "local-merges":
      return "There are local merge commits that aren't on the remote. Push or rebase them yourself to resume syncing.";
  }
}

function shortReason(reason: PausedReason, operation?: GitOperation): string {
  if (reason === "operation-in-progress" && operation) return `${operation} in progress`;
  return SHORT_REASONS[reason];
}

/** `30s`, `1m`, `5m`: a retry delay. */
export function formatDelay(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.round(ms / 60_000)}m`;
}

const PAUSE_PREFIXES: readonly (PausedReason | typeof PULL_CONFLICT)[] = [
  PULL_CONFLICT,
  ...PAUSED_REASONS,
];

/** A `GitPaused` message split into its reason (if known) and the details after it. */
export function parsePausedMessage(message: string): {
  reason: PausedReason | typeof PULL_CONFLICT | null;
  rest: string;
} {
  const reason =
    PAUSE_PREFIXES.find(
      (candidate) =>
        message === candidate ||
        message.startsWith(`${candidate}:`) ||
        message.startsWith(`${candidate} `),
    ) ?? null;
  if (reason === null) return { reason, rest: message };
  return { reason, rest: message.slice(reason.length).replace(/^[\s:]+/, "") };
}

/** The short label of a paused backend error, for `paused: <label>`. */
function pausedProblemLabel(message: string): string {
  const { reason } = parsePausedMessage(message);
  if (reason === null) return "sync";
  if (reason === PULL_CONFLICT) return "pull would conflict";
  return SHORT_REASONS[reason];
}

/** A failure explained for the tooltip. A paused backend error names its reason first. */
export function problemText(problem: SyncProblem): string {
  if (problem.kind === "paused") {
    const { reason, rest } = parsePausedMessage(problem.message);
    if (reason === PULL_CONFLICT) {
      return `Pulling would conflict in ${rest === "" ? "files" : rest} (not notes). Pull and resolve it with git.`;
    }
    if (reason !== null) {
      return rest === "" ? pausedReasonText(reason) : `${pausedReasonText(reason)} (${rest})`;
    }
  }
  const prefix =
    problem.kind === "network"
      ? "Could not reach the remote"
      : problem.kind === "auth"
        ? "Git could not authenticate with the remote"
        : problem.kind === "unavailable"
          ? "Git is not available"
          : problem.during === "commit"
            ? "Committing failed"
            : problem.during === "sync"
              ? "Syncing failed"
              : "Reading the git status failed";
  return problem.message === "" ? `${prefix}.` : `${prefix}: ${problem.message}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function repoDetails(status: GitStatus): string[] {
  if (status.state === "unavailable") return [];
  const lines = [
    `branch: ${status.branch ?? "none (detached HEAD)"}`,
    `upstream: ${status.upstream ?? "none (local only)"}`,
  ];
  if (status.upstream !== null) lines.push(`ahead ${status.ahead} · behind ${status.behind}`);
  if (status.changed.length > 0)
    lines.push(`${plural(status.changed.length, "uncommitted change")}`);
  return lines;
}

function unavailableText(status: Extract<GitStatus, { state: "unavailable" }>): SyncView {
  return status.reason === "git-missing"
    ? {
        icon: "unavailable",
        tone: "muted",
        text: "no git",
        details: [
          "Git was not found. Install git to keep a history of this workspace and sync it.",
        ],
      }
    : {
        icon: "unavailable",
        tone: "muted",
        text: "not a git repo",
        details: [
          "This folder is not in a git repository. Notes are saved but not versioned or synced.",
        ],
      };
}

/** The status line for a sync snapshot at time `now`. */
export function describeSync(snapshot: SyncSnapshot, now: number): SyncView {
  const { status, problem } = snapshot;
  if (status === null) {
    const details = problem ? [problemText(problem)] : [];
    return problem
      ? { icon: "failed", tone: "error", text: "git status failed", details }
      : { icon: "checking", tone: "muted", text: "checking git…", details };
  }
  if (status.state === "unavailable") return unavailableText(status);

  const repo = repoDetails(status);
  const details = problem ? [...repo, `last error: ${problemText(problem)}`] : repo;

  if (snapshot.activity === "committing") {
    return {
      icon: "syncing",
      tone: "busy",
      text: `${plural(snapshot.committing, "change")} · committing…`,
      details,
    };
  }
  if (snapshot.activity === "syncing") {
    return { icon: "syncing", tone: "busy", text: "syncing…", details };
  }

  const reason = status.pausedReason;
  const paused =
    status.state === "paused" &&
    reason !== undefined &&
    (reason !== "outside-changes" || status.upstream !== null);
  if (paused) {
    return {
      icon: "paused",
      tone: "warning",
      text: `paused: ${shortReason(reason, status.operation)}`,
      details: [
        pausedReasonText(reason, status.operation),
        ...(status.pausedMessage === undefined ? [] : [status.pausedMessage]),
        ...details,
      ],
    };
  }

  // A pause the backend found while committing or syncing.
  if (problem?.kind === "paused" && problem.during !== "status") {
    return {
      icon: "paused",
      tone: "warning",
      text: `paused: ${pausedProblemLabel(problem.message)}`,
      details: [problemText(problem), ...repo],
    };
  }

  if (problem?.kind === "network" && problem.during === "sync") {
    const text =
      snapshot.retryIn === null
        ? "offline"
        : `offline · retrying in ${formatDelay(snapshot.retryIn)}`;
    return { icon: "offline", tone: "muted", text, details };
  }
  if (problem && problem.during !== "status") {
    const text = problem.during === "commit" ? "commit failed" : "sync failed";
    return { icon: "failed", tone: "error", text, details };
  }

  if (snapshot.pending) {
    return {
      icon: "pending",
      tone: "muted",
      text: "changes pending",
      details: ["Local changes are waiting to be committed before syncing.", ...details],
    };
  }

  if (status.upstream === null) {
    const local = status.remote
      ? "The branch has no upstream. Changes are committed but not pushed."
      : "No remote is configured. Changes are committed on this device only.";
    return { icon: "local", tone: "muted", text: "local only", details: [local, ...details] };
  }
  if (snapshot.lastSync === null) {
    return { icon: "synced", tone: "muted", text: "not synced yet", details };
  }
  const age = formatAge(snapshot.lastSync, now);
  return {
    icon: "synced",
    tone: "ok",
    text: `synced · ${age === "now" ? "just now" : `${age} ago`}`,
    details,
  };
}

/** Most conflict copies a toast names. */
export const MAX_NAMED_CONFLICTS = 3;

/** `Both versions kept: a (conflict …).md, b (conflict …).md and 2 more`. */
export function conflictsKeptMessage(copies: readonly string[]): string {
  const names = copies
    .slice(0, MAX_NAMED_CONFLICTS)
    .map((copy) => copy.slice(copy.lastIndexOf("/") + 1));
  const rest = copies.length - names.length;
  return `Both versions kept: ${names.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/**
 * What to announce to assistive technology for a status, or `null` for
 * transient states (checking, committing, syncing) that should not be read
 * out. The age of the last sync is left out, so time passing is silent.
 */
export function syncAnnouncement(view: SyncView): string | null {
  if (view.tone === "busy" || view.icon === "checking") return null;
  if (view.icon === "synced") return view.tone === "ok" ? "synced" : view.text;
  return view.text;
}
