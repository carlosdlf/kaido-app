import { describe, expect, it } from "vitest";
import {
  canCommit,
  canSync,
  canSyncManually,
  isTemporaryPath,
  type GitRepoStatus,
  type GitStatus,
} from "./git";
import type { SyncSnapshot } from "./syncScheduler";
import {
  conflictsKeptMessage,
  describeSync,
  formatDelay,
  parsePausedMessage,
  pausedReasonText,
  problemText,
  syncAnnouncement,
  type SyncView,
} from "./syncStatus";

const NOW = 10_000_000;

const repo: GitRepoStatus = {
  state: "ready",
  branch: "main",
  upstream: "origin/main",
  remote: true,
  ahead: 0,
  behind: 0,
  changed: [],
  gitVersion: "2.43.0",
};

function snapshot(patch: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    status: repo,
    activity: "idle",
    committing: 0,
    lastSync: NOW - 120_000,
    problem: null,
    retryIn: null,
    halted: false,
    pending: false,
    ...patch,
  };
}

function paused(
  pausedReason: NonNullable<GitRepoStatus["pausedReason"]>,
  patch: Partial<GitRepoStatus> = {},
) {
  return { ...repo, state: "paused" as const, pausedReason, ...patch };
}

describe("describeSync", () => {
  it.each<[string, Partial<SyncSnapshot>, string, string, string]>([
    ["synced", {}, "synced · 2m ago", "synced", "ok"],
    ["synced just now", { lastSync: NOW - 5_000 }, "synced · just now", "synced", "ok"],
    ["not synced yet", { lastSync: null }, "not synced yet", "synced", "muted"],
    ["checking", { status: null }, "checking git…", "checking", "muted"],
    ["syncing", { activity: "syncing" }, "syncing…", "syncing", "busy"],
    [
      "committing",
      { activity: "committing", committing: 3 },
      "3 changes · committing…",
      "syncing",
      "busy",
    ],
    [
      "committing one",
      { activity: "committing", committing: 1 },
      "1 change · committing…",
      "syncing",
      "busy",
    ],
    ["local only", { status: { ...repo, upstream: null } }, "local only", "local", "muted"],
    [
      "offline",
      { problem: { kind: "network", message: "x", during: "sync" }, retryIn: 60_000 },
      "offline · retrying in 1m",
      "offline",
      "muted",
    ],
    [
      "offline without retry",
      { problem: { kind: "network", message: "x", during: "sync" } },
      "offline",
      "offline",
      "muted",
    ],
    [
      "auth failure",
      { problem: { kind: "auth", message: "denied", during: "sync" } },
      "sync failed",
      "failed",
      "error",
    ],
    [
      "commit failure",
      { problem: { kind: "failed", message: "hook", during: "commit" } },
      "commit failed",
      "failed",
      "error",
    ],
    [
      "commit network failure",
      { problem: { kind: "network", message: "x", during: "commit" } },
      "commit failed",
      "failed",
      "error",
    ],
    [
      "status failure",
      { status: null, problem: { kind: "failed", message: "x", during: "status" } },
      "git status failed",
      "failed",
      "error",
    ],
    [
      "status failure after a good status",
      { problem: { kind: "failed", message: "x", during: "status" } },
      "synced · 2m ago",
      "synced",
      "ok",
    ],
    [
      "detached",
      { status: paused("detached-head", { branch: null }) },
      "paused: detached HEAD",
      "paused",
      "warning",
    ],
    [
      "rebase",
      { status: paused("operation-in-progress", { operation: "rebase" }) },
      "paused: rebase in progress",
      "paused",
      "warning",
    ],
    [
      "operation",
      { status: paused("operation-in-progress") },
      "paused: git operation in progress",
      "paused",
      "warning",
    ],
    ["changes pending", { pending: true }, "changes pending", "pending", "muted"],
    [
      "commit failure while pending",
      { pending: true, problem: { kind: "failed", message: "hook", during: "commit" } },
      "commit failed",
      "failed",
      "error",
    ],
    [
      "index lock",
      { status: paused("index-locked") },
      "paused: git index locked",
      "paused",
      "warning",
    ],
    [
      "upstream mismatch",
      { status: paused("upstream-mismatch") },
      "paused: upstream mismatch",
      "paused",
      "warning",
    ],
    [
      "upstream gone",
      { status: paused("upstream-gone") },
      "paused: upstream gone",
      "paused",
      "warning",
    ],
    [
      "outside commits",
      { status: paused("outside-commits") },
      "paused: unpushed commits outside",
      "paused",
      "warning",
    ],
    [
      "unmerged",
      { status: paused("unmerged-files") },
      "paused: unmerged files",
      "paused",
      "warning",
    ],
    ["identity", { status: paused("no-identity") }, "paused: no git identity", "paused", "warning"],
    [
      "outside changes",
      { status: paused("outside-changes") },
      "paused: changes outside workspace",
      "paused",
      "warning",
    ],
    [
      "outside changes without upstream",
      { status: paused("outside-changes", { upstream: null, remote: false }) },
      "local only",
      "local",
      "muted",
    ],
    [
      "no git",
      { status: { state: "unavailable", reason: "git-missing" } },
      "no git",
      "unavailable",
      "muted",
    ],
    [
      "not a repo",
      { status: { state: "unavailable", reason: "not-a-repo" } },
      "not a git repo",
      "unavailable",
      "muted",
    ],
  ])("%s", (_name, patch, text, icon, tone) => {
    expect(describeSync(snapshot(patch), NOW)).toMatchObject({ text, icon, tone });
  });

  it("lists the branch, upstream, counts and the last error", () => {
    const view = describeSync(
      snapshot({
        status: { ...repo, ahead: 2, behind: 1, changed: ["a.md"] },
        problem: { kind: "auth", message: "denied", during: "sync" },
      }),
      NOW,
    );
    expect(view.details).toEqual([
      "branch: main",
      "upstream: origin/main",
      "ahead 2 · behind 1",
      "1 uncommitted change",
      "last error: Git could not authenticate with the remote: denied",
    ]);
  });

  it("explains paused states and local-only branches first", () => {
    const detached = describeSync(
      snapshot({ status: paused("detached-head", { branch: null }) }),
      NOW,
    );
    expect(detached.details.slice(0, 2)).toEqual([
      "Git is not on a branch. Check out a branch to resume syncing.",
      "branch: none (detached HEAD)",
    ]);
    const local = describeSync(
      snapshot({ status: { ...repo, upstream: null, remote: false } }),
      NOW,
    );
    expect(local.details).toEqual([
      "No remote is configured. Changes are committed on this device only.",
      "branch: main",
      "upstream: none (local only)",
    ]);
    const noUpstream = describeSync(snapshot({ status: { ...repo, upstream: null } }), NOW);
    expect(noUpstream.details[0]).toBe(
      "The branch has no upstream. Changes are committed but not pushed.",
    );
  });

  it("explains a missing git", () => {
    expect(
      describeSync(snapshot({ status: { state: "unavailable", reason: "git-missing" } }), NOW)
        .details,
    ).toEqual(["Git was not found. Install git to keep a history of this workspace and sync it."]);
  });

  it("shows nothing but checking before the first status", () => {
    expect(describeSync(snapshot({ status: null }), NOW).details).toEqual([]);
  });
});

describe("pausedReasonText", () => {
  it("names the operation in progress", () => {
    expect(pausedReasonText("operation-in-progress", "merge")).toBe(
      "A git merge is in progress. Finish or abort it to resume syncing.",
    );
    expect(pausedReasonText("operation-in-progress")).toMatch(/^A git operation is in progress/);
  });

  it.each(["unmerged-files", "outside-changes", "no-identity"] as const)(
    "explains %s",
    (reason) => {
      expect(pausedReasonText(reason)).toMatch(/\.$/);
    },
  );

  it.each([
    [
      "index-locked",
      "Git is busy or a previous git command crashed (index.lock). Remove the repository's index.lock if no git command is running.",
    ],
    [
      "upstream-mismatch",
      "The branch tracks a different branch or remote. Kaido only syncs a branch with its same-named upstream.",
    ],
    [
      "upstream-gone",
      "The upstream branch isn't on the remote (deleted or never pushed). Push it once with git to resume syncing.",
    ],
    [
      "outside-commits",
      "There are unpushed commits outside the notes folder. Push them yourself to resume syncing.",
    ],
  ] as const)("explains %s in full", (reason, text) => {
    expect(pausedReasonText(reason)).toBe(text);
  });
});

describe("problemText", () => {
  it.each<[Parameters<typeof problemText>[0], string]>([
    [
      { kind: "network", message: "timed out", during: "sync" },
      "Could not reach the remote: timed out",
    ],
    [{ kind: "unavailable", message: "", during: "commit" }, "Git is not available."],
    [{ kind: "failed", message: "hook", during: "commit" }, "Committing failed: hook"],
    [{ kind: "failed", message: "boom", during: "sync" }, "Syncing failed: boom"],
    [
      { kind: "failed", message: "locked", during: "status" },
      "Reading the git status failed: locked",
    ],
    [
      { kind: "paused", message: "unmerged-files: image.png", during: "sync" },
      "The repository has unresolved conflicts. Resolve them with git to resume syncing. (image.png)",
    ],
    [
      { kind: "paused", message: "detached-head", during: "sync" },
      "Git is not on a branch. Check out a branch to resume syncing.",
    ],
    [
      { kind: "paused", message: "something else", during: "sync" },
      "Syncing failed: something else",
    ],
  ])("explains %j", (problem, text) => {
    expect(problemText(problem)).toBe(text);
  });
});

describe("formatDelay", () => {
  it.each([
    [500, "1s"],
    [30_000, "30s"],
    [60_000, "1m"],
    [300_000, "5m"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatDelay(ms)).toBe(text);
  });
});

describe("conflictsKeptMessage", () => {
  it("names up to three copies by file name", () => {
    expect(conflictsKeptMessage(["a/x (conflict).md"])).toBe("Both versions kept: x (conflict).md");
    expect(conflictsKeptMessage(["a.md", "b/b.md", "c.md", "d.md", "e.md"])).toBe(
      "Both versions kept: a.md, b.md, c.md and 2 more",
    );
  });
});

describe("git helpers", () => {
  const unavailable: GitStatus = { state: "unavailable", reason: "git-missing" };

  it("allows commits when ready or paused for a reason that only blocks syncing", () => {
    expect(canCommit(repo)).toBe(true);
    expect(canCommit(paused("outside-changes"))).toBe(true);
    expect(canCommit(paused("upstream-mismatch"))).toBe(true);
    expect(canCommit(paused("upstream-gone"))).toBe(true);
    expect(canCommit(paused("outside-commits"))).toBe(true);
    expect(canCommit(paused("index-locked"))).toBe(false);
    expect(canCommit({ ...repo, state: "paused" })).toBe(false);
    expect(canCommit(paused("no-identity"))).toBe(false);
    expect(canCommit(unavailable)).toBe(false);
  });

  it("allows syncing when ready with an upstream", () => {
    expect(canSync(repo)).toBe(true);
    expect(canSync({ ...repo, upstream: null })).toBe(false);
    for (const reason of [
      "outside-changes",
      "upstream-mismatch",
      "upstream-gone",
      "outside-commits",
      "index-locked",
    ] as const) {
      expect(canSync(paused(reason))).toBe(false);
    }
    expect(canSync(unavailable)).toBe(false);
  });

  it("recognizes temporary files", () => {
    expect(isTemporaryPath("inbox/.kaido-123.tmp")).toBe(true);
    expect(isTemporaryPath(".kaido-a.tmp")).toBe(true);
    expect(isTemporaryPath(".Trash-1000/files/a.md")).toBe(true);
    expect(isTemporaryPath("inbox/a.md")).toBe(false);
    expect(isTemporaryPath("inbox/kaido-a.tmp")).toBe(false);
  });
});

describe("syncAnnouncement", () => {
  const view = (icon: SyncView["icon"], tone: SyncView["tone"], text: string): SyncView => ({
    icon,
    tone,
    text,
    details: [],
  });

  it("stays silent for transient states", () => {
    expect(syncAnnouncement(view("syncing", "busy", "syncing…"))).toBeNull();
    expect(syncAnnouncement(view("syncing", "busy", "2 changes · committing…"))).toBeNull();
    expect(syncAnnouncement(view("checking", "muted", "checking git…"))).toBeNull();
  });

  it("leaves the age out of synced", () => {
    expect(syncAnnouncement(view("synced", "ok", "synced · 2m ago"))).toBe("synced");
    expect(syncAnnouncement(view("synced", "ok", "synced · just now"))).toBe("synced");
    expect(syncAnnouncement(view("synced", "muted", "not synced yet"))).toBe("not synced yet");
  });

  it("reads out other states as shown", () => {
    expect(syncAnnouncement(view("paused", "warning", "paused: upstream gone"))).toBe(
      "paused: upstream gone",
    );
    expect(syncAnnouncement(view("failed", "error", "sync failed"))).toBe("sync failed");
  });
});

describe("pauses found by the backend", () => {
  const problem = (message: string, during: "sync" | "commit" = "sync") =>
    snapshot({ problem: { kind: "paused", message, during } });

  it("shows a pull conflict as paused", () => {
    const view = describeSync(problem("pull-conflict: image.png, data.json"), NOW);
    expect(view).toMatchObject({
      icon: "paused",
      tone: "warning",
      text: "paused: pull would conflict",
    });
    expect(view.details[0]).toBe(
      "Pulling would conflict in image.png, data.json (not notes). Pull and resolve it with git.",
    );
    expect(view.details).not.toContainEqual(expect.stringMatching(/^last error/));
  });

  it("shows any paused error from a commit or sync as paused", () => {
    expect(describeSync(problem("no-identity", "commit"), NOW)).toMatchObject({
      tone: "warning",
      text: "paused: no git identity",
    });
    expect(describeSync(problem("unmerged-files: a.png"), NOW).text).toBe("paused: unmerged files");
    expect(describeSync(problem("something new"), NOW)).toMatchObject({
      tone: "warning",
      text: "paused: sync",
      details: [
        "Syncing failed: something new",
        "branch: main",
        "upstream: origin/main",
        "ahead 0 · behind 0",
      ],
    });
  });

  it("shows the message of an interrupted rebase", () => {
    const message =
      "operation-in-progress: a sync stopped in the middle of a rebase; finish it (git rebase --continue) or undo it (git rebase --abort)";
    const view = describeSync(problem(message), NOW);
    expect(view.text).toBe("paused: git operation in progress");
    expect(view.details[0]).toContain("git rebase --continue");
  });

  it("shows a status message under the paused reason", () => {
    const view = describeSync(
      snapshot({
        status: paused("operation-in-progress", {
          operation: "rebase",
          pausedMessage:
            "Kaido started this rebase. Run git rebase --continue or git rebase --abort.",
        }),
      }),
      NOW,
    );
    expect(view.details.slice(0, 2)).toEqual([
      "A git rebase is in progress. Finish or abort it to resume syncing.",
      "Kaido started this rebase. Run git rebase --continue or git rebase --abort.",
    ]);
  });

  it("explains local merge commits", () => {
    expect(describeSync(snapshot({ status: paused("local-merges") }), NOW)).toMatchObject({
      text: "paused: unpushed merge commits",
      details: [
        "There are local merge commits that aren't on the remote. Push or rebase them yourself to resume syncing.",
        "branch: main",
        "upstream: origin/main",
        "ahead 0 · behind 0",
      ],
    });
  });

  it("explains a pull conflict without paths", () => {
    expect(problemText({ kind: "paused", message: "pull-conflict", during: "sync" })).toBe(
      "Pulling would conflict in files (not notes). Pull and resolve it with git.",
    );
  });

  it("splits paused messages only at a reason boundary", () => {
    expect(parsePausedMessage("outside-commits")).toEqual({ reason: "outside-commits", rest: "" });
    expect(parsePausedMessage("pull-conflict: a.png")).toEqual({
      reason: "pull-conflict",
      rest: "a.png",
    });
    expect(parsePausedMessage("outside-changes-ish")).toEqual({
      reason: null,
      rest: "outside-changes-ish",
    });
  });
});

describe("manual sync rules", () => {
  it("allows Sync now when the upstream is gone or commits outside are unpushed", () => {
    expect(canSyncManually(paused("upstream-gone"))).toBe(true);
    expect(canSyncManually(paused("outside-commits"))).toBe(true);
    expect(canSyncManually(paused("local-merges"))).toBe(false);
    expect(canSyncManually(paused("upstream-mismatch"))).toBe(false);
    expect(canSyncManually(repo)).toBe(false);
    expect(canSyncManually({ ...repo, state: "paused" })).toBe(false);
    expect(canSyncManually({ state: "unavailable", reason: "git-missing" })).toBe(false);
  });

  it("allows commits with local merges", () => {
    expect(canCommit(paused("local-merges"))).toBe(true);
    expect(canSync(paused("local-merges"))).toBe(false);
  });
});
