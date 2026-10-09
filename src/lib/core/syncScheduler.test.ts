import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitResult, GitRepoStatus, GitStatus, SyncResult } from "./git";
import type { Timers } from "./saveMachine";
import {
  BACKOFF_DELAYS_MS,
  COMMIT_DELAY_MS,
  MAX_DEFERRED_RETRIES,
  FOCUS_SYNC_AGE_MS,
  SYNC_INTERVAL_MS,
  SyncScheduler,
  type GitOutcome,
  PAUSED_RETRY_DELAYS_MS,
  type SyncIO,
  type SyncSchedulerOptions,
  type SyncSnapshot,
} from "./syncScheduler";

type Override<T> = GitOutcome<T> | Error;

/** Scripted git: a status to report, outcomes to return, and a log of calls. */
class FakeGit implements SyncIO {
  repo: GitRepoStatus = {
    state: "ready",
    branch: "main",
    upstream: "origin/main",
    remote: true,
    ahead: 0,
    behind: 0,
    changed: [],
    gitVersion: "2.43.0",
  };
  unavailable = false;
  readonly log: string[] = [];
  readonly statusOverrides: Override<GitStatus>[] = [];
  readonly commitOverrides: Override<CommitResult>[] = [];
  readonly syncOverrides: Override<SyncResult>[] = [];
  /** Operations that wait for `release` before finishing. */
  holding = new Set<string>();
  #held: (() => void)[] = [];
  active = 0;
  maxActive = 0;
  noMessage = false;

  async #op<T>(name: string, overrides: Override<T>[], run: () => T): Promise<GitOutcome<T>> {
    this.log.push(name);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.holding.has(name)) await new Promise<void>((resolve) => this.#held.push(resolve));
      const override = overrides.shift();
      if (override instanceof Error) throw override;
      return override ?? { ok: true, value: run() };
    } finally {
      this.active -= 1;
    }
  }

  status(): Promise<GitOutcome<GitStatus>> {
    return this.#op("status", this.statusOverrides, () =>
      this.unavailable
        ? { state: "unavailable", reason: "not-a-repo" }
        : { ...this.repo, changed: [...this.repo.changed] },
    );
  }

  commit(message: string): Promise<GitOutcome<CommitResult>> {
    return this.#op(`commit`, this.commitOverrides, () => {
      this.log.push(`message:${message}`);
      const paths = this.repo.changed;
      this.repo = { ...this.repo, changed: [], ahead: this.repo.ahead + 1 };
      return { commit: "abc", paths };
    });
  }

  sync(): Promise<GitOutcome<SyncResult>> {
    return this.#op("sync", this.syncOverrides, () => {
      const pushed = this.repo.ahead;
      this.repo = { ...this.repo, ahead: 0 };
      return { pulled: 0, pushed, changed: [], conflicts: [], deferred: false };
    });
  }

  async flush(): Promise<void> {
    this.log.push("flush");
  }

  message(changed: readonly string[]): string | null {
    return this.noMessage ? null : changed.join(",");
  }

  release(): void {
    this.holding.clear();
    for (const resolve of this.#held.splice(0)) resolve();
  }

  /** Git operations (without flushes and messages), and clears the log. */
  take(): string[] {
    const ops = this.log.filter((entry) => entry !== "flush" && !entry.startsWith("message:"));
    this.log.length = 0;
    return ops;
  }
}

const host = globalThis as unknown as {
  setTimeout(task: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

const timers: Timers = {
  now: () => Date.now(),
  setTimeout: (task, delay) => host.setTimeout(task, delay),
  clearTimeout: (handle) => host.clearTimeout(handle),
};

function network(message = "offline"): GitOutcome<never> {
  return { ok: false, kind: "network", message };
}

function setup(
  configure: (git: FakeGit) => void = () => undefined,
  options: Partial<Pick<SyncSchedulerOptions, "syncInterval" | "backoffDelays">> = {},
) {
  const git = new FakeGit();
  configure(git);
  const snapshots: SyncSnapshot[] = [];
  const committed: CommitResult[] = [];
  const synced: SyncResult[] = [];
  const scheduler = new SyncScheduler({
    io: git,
    timers,
    ...options,
    events: {
      changed: (snapshot) => snapshots.push(snapshot),
      committed: (result) => committed.push(result),
      synced: (result) => synced.push(result),
    },
  });
  return { git, scheduler, snapshots, committed, synced };
}

async function started(configure?: (git: FakeGit) => void) {
  const context = setup(configure);
  context.scheduler.start();
  await context.scheduler.idle();
  context.git.take();
  return context;
}

/** Advances fake time and lets the operations it started finish. */
async function advance(scheduler: SyncScheduler, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await scheduler.idle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SyncScheduler start", () => {
  it("flushes, reads the status and syncs", async () => {
    const { git, scheduler } = setup();
    scheduler.start();
    scheduler.start();
    await scheduler.idle();
    expect(git.log).toEqual(["flush", "status", "sync", "status"]);
    expect(scheduler.snapshot).toMatchObject({
      activity: "idle",
      lastSync: 1_000_000,
      problem: null,
      status: { state: "ready" },
    });
  });

  it("commits changes left from before, then syncs", async () => {
    const { git, scheduler, committed } = setup((git) => (git.repo.changed = ["inbox/a.md"]));
    scheduler.start();
    await scheduler.idle();
    expect(git.log).toEqual([
      "flush",
      "status",
      "commit",
      "message:inbox/a.md",
      "status",
      "sync",
      "status",
    ]);
    expect(committed).toEqual([{ commit: "abc", paths: ["inbox/a.md"] }]);
  });

  it("shows the commit while it runs", async () => {
    const { git, scheduler } = setup((git) => {
      git.repo.changed = ["a.md", "b.md"];
      git.holding.add("commit");
    });
    scheduler.start();
    await vi.waitFor(() => expect(scheduler.snapshot.activity).toBe("committing"));
    expect(scheduler.snapshot.committing).toBe(2);
    git.release();
    await scheduler.idle();
    expect(scheduler.snapshot).toMatchObject({ activity: "idle", committing: 0 });
  });

  it("only commits on a local-only branch", async () => {
    const { git, scheduler } = setup((git) => {
      git.repo.upstream = null;
      git.repo.changed = ["a.md"];
    });
    scheduler.start();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "commit", "status"]);
    expect(scheduler.snapshot.lastSync).toBeNull();
  });

  it("does nothing else without a repository", async () => {
    const { git, scheduler } = setup((git) => (git.unavailable = true));
    scheduler.start();
    await scheduler.idle();
    expect(git.take()).toEqual(["status"]);
    expect(scheduler.snapshot.status).toEqual({ state: "unavailable", reason: "not-a-repo" });
    scheduler.syncNow();
    await scheduler.idle();
    expect(git.take()).toEqual(["status"]);
  });

  it("skips the commit when there is no message", async () => {
    const { git, scheduler } = setup((git) => {
      git.repo.changed = ["a.md"];
      git.noMessage = true;
    });
    scheduler.start();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });
});

describe("SyncScheduler commits", () => {
  it("commits 3 s after the last change, then syncs", async () => {
    const { git, scheduler } = await started();
    git.repo.changed = ["a.md"];
    scheduler.changed();
    await advance(scheduler, 2_000);
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS - 1);
    expect(git.take()).toEqual([]);
    await advance(scheduler, 1);
    expect(git.take()).toEqual(["status", "commit", "status", "sync", "status"]);
  });

  it("does not sync when nothing was committed and nothing is ahead", async () => {
    const { git, scheduler } = await started();
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status"]);
  });

  it("pushes commits left ahead even without new changes", async () => {
    const { git, scheduler } = await started();
    git.repo.ahead = 2;
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });

  it("commits but does not sync with changes outside the workspace", async () => {
    const { git, scheduler } = await started();
    git.repo = { ...git.repo, state: "paused", pausedReason: "outside-changes", changed: ["a.md"] };
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    scheduler.syncNow();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "commit", "status", "status"]);
  });

  it.each(["detached-head", "operation-in-progress", "unmerged-files", "no-identity"] as const)(
    "neither commits nor syncs when paused by %s",
    async (reason) => {
      const { git, scheduler } = await started();
      git.repo = { ...git.repo, state: "paused", pausedReason: reason, changed: ["a.md"] };
      scheduler.changed();
      await advance(scheduler, COMMIT_DELAY_MS);
      scheduler.syncNow();
      await scheduler.idle();
      expect(git.take()).toEqual(["status", "status"]);
      expect(scheduler.snapshot.status).toMatchObject({ pausedReason: reason });
    },
  );

  it("stops committing after a failed commit until the repository changes", async () => {
    const { git, scheduler } = await started((git) => (git.repo.upstream = null));
    git.repo.changed = ["a.md"];
    git.commitOverrides.push({ ok: false, kind: "failed", message: "hook said no" });
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status", "commit", "status"]);
    expect(scheduler.snapshot).toMatchObject({
      halted: true,
      problem: { kind: "failed", during: "commit", message: "hook said no" },
    });

    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status"]);

    git.repo.branch = "other";
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status", "commit", "status"]);
    expect(scheduler.snapshot).toMatchObject({ halted: false, problem: null });
  });

  it("keeps committing after a commit that failed for network reasons", async () => {
    const { git, scheduler } = await started((git) => (git.repo.upstream = null));
    git.repo.changed = ["a.md"];
    git.commitOverrides.push(network());
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(scheduler.snapshot.halted).toBe(false);
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status", "commit", "status", "status", "commit", "status"]);
  });

  it("treats a thrown error as a failure", async () => {
    const { git, scheduler } = await started();
    git.repo.changed = ["a.md"];
    git.commitOverrides.push(new Error("bridge down"));
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(scheduler.snapshot.problem).toEqual({
      kind: "failed",
      message: "bridge down",
      during: "commit",
    });
  });
});

describe("SyncScheduler sync triggers", () => {
  it("syncs every 5 minutes", async () => {
    const { git, scheduler } = await started();
    await advance(scheduler, SYNC_INTERVAL_MS - 1);
    expect(git.take()).toEqual([]);
    await advance(scheduler, 1);
    expect(git.take()).toEqual(["status", "sync", "status"]);
    await advance(scheduler, SYNC_INTERVAL_MS);
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });

  it("keeps polling the status every 5 minutes without an upstream", async () => {
    const { git, scheduler } = await started((git) => (git.repo.upstream = null));
    await advance(scheduler, SYNC_INTERVAL_MS);
    expect(git.take()).toEqual(["status"]);
    await advance(scheduler, SYNC_INTERVAL_MS);
    expect(git.take()).toEqual(["status"]);
  });

  it("on focus only reads the status when the last sync is recent", async () => {
    const { git, scheduler } = await started();
    await advance(scheduler, FOCUS_SYNC_AGE_MS - 1);
    scheduler.focus();
    await scheduler.idle();
    expect(git.take()).toEqual(["status"]);
    await advance(scheduler, 1);
    scheduler.focus();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });

  it("ignores focus before starting and after stopping", async () => {
    const { git, scheduler } = setup();
    scheduler.focus();
    await scheduler.idle();
    expect(git.log).toEqual([]);
    scheduler.start();
    await scheduler.stop();
    git.take();
    scheduler.focus();
    scheduler.syncNow();
    scheduler.changed();
    await advance(scheduler, SYNC_INTERVAL_MS);
    expect(git.log).toEqual([]);
  });

  it("syncs now on request", async () => {
    const { git, scheduler } = await started();
    git.repo.changed = ["a.md"];
    scheduler.syncNow();
    await scheduler.idle();
    expect(git.log).toEqual([
      "flush",
      "status",
      "commit",
      "message:a.md",
      "status",
      "sync",
      "status",
    ]);
  });

  it("reports pulled conflicts", async () => {
    const { git, scheduler, synced } = await started();
    const result: SyncResult = {
      pulled: 1,
      pushed: 0,
      changed: ["a.md"],
      conflicts: [{ path: "a.md", copy: "a (conflict).md" }],
      deferred: false,
    };
    git.syncOverrides.push({ ok: true, value: result });
    scheduler.syncNow();
    await scheduler.idle();
    expect(synced.at(-1)).toEqual(result);
  });
});

describe("SyncScheduler one operation at a time", () => {
  it("coalesces requests made while an operation runs into one follow-up", async () => {
    const { git, scheduler } = await started();
    git.holding.add("sync");
    scheduler.syncNow();
    await vi.waitFor(() => expect(scheduler.snapshot.activity).toBe("syncing"));
    scheduler.syncNow();
    scheduler.syncNow();
    scheduler.focus();
    git.repo.changed = ["a.md"];
    scheduler.changed();
    await vi.advanceTimersByTimeAsync(COMMIT_DELAY_MS);
    expect(scheduler.busy).toBe(true);
    git.release();
    await scheduler.idle();
    expect(git.take()).toEqual([
      "status",
      "sync",
      "status",
      "status",
      "commit",
      "status",
      "sync",
      "status",
    ]);
    expect(git.maxActive).toBe(1);
    expect(scheduler.busy).toBe(false);
  });

  it("keeps the stronger request when coalescing", async () => {
    const { git, scheduler } = await started();
    git.holding.add("status");
    scheduler.focus();
    await vi.waitFor(() => expect(scheduler.busy).toBe(true));
    scheduler.syncNow();
    scheduler.focus();
    git.release();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "status", "sync", "status"]);
  });
});

describe("SyncScheduler network backoff", () => {
  it("retries after 30 s, 1 min, 2 min, then every 5 min", async () => {
    const { git, scheduler } = await started();
    for (let attempt = 0; attempt < 6; attempt += 1) git.syncOverrides.push(network());
    scheduler.syncNow();
    await scheduler.idle();
    expect(scheduler.snapshot).toMatchObject({
      retryIn: 30_000,
      problem: { kind: "network", during: "sync" },
      halted: false,
    });
    git.take();

    for (const delay of [30_000, 60_000, 120_000, 300_000, 300_000]) {
      await advance(scheduler, delay - 1);
      expect(git.take()).toEqual([]);
      await advance(scheduler, 1);
      expect(git.take()).toEqual(["status", "sync", "status"]);
    }
    expect(scheduler.snapshot.retryIn).toBe(BACKOFF_DELAYS_MS.at(-1));
  });

  it("resets the backoff after a success", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push(network(), network());
    scheduler.syncNow();
    await scheduler.idle();
    await advance(scheduler, 30_000);
    expect(scheduler.snapshot.retryIn).toBe(60_000);
    await advance(scheduler, 60_000);
    expect(scheduler.snapshot).toMatchObject({
      retryIn: null,
      problem: null,
      lastSync: Date.now(),
    });
    git.syncOverrides.push(network());
    scheduler.syncNow();
    await scheduler.idle();
    expect(scheduler.snapshot.retryIn).toBe(30_000);
  });

  it("resets the backoff and retries at once on focus", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push(network(), network());
    scheduler.syncNow();
    await scheduler.idle();
    await advance(scheduler, 30_000);
    expect(scheduler.snapshot.retryIn).toBe(60_000);
    git.take();
    scheduler.focus();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "sync", "status"]);
    expect(scheduler.snapshot.retryIn).toBeNull();
  });

  it("commits during the backoff but leaves syncing to the retry", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push(network());
    scheduler.syncNow();
    await scheduler.idle();
    git.take();
    git.repo.changed = ["a.md"];
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status", "commit", "status"]);
    await advance(scheduler, 30_000 - COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });

  it("skips the interval sync while a retry is pending", async () => {
    const { git, scheduler } = setup(() => undefined, {
      syncInterval: 10_000,
      backoffDelays: [60_000],
    });
    scheduler.start();
    await scheduler.idle();
    git.syncOverrides.push(network());
    scheduler.syncNow();
    await scheduler.idle();
    git.take();
    await advance(scheduler, 10_000);
    expect(git.take()).toEqual(["status"]);
  });
});

describe("SyncScheduler stops", () => {
  it.each(["auth", "failed", "paused"] as const)(
    "stops automatic syncing after a %s failure",
    async (kind) => {
      const { git, scheduler } = await started();
      git.syncOverrides.push({ ok: false, kind, message: "nope" });
      scheduler.syncNow();
      await scheduler.idle();
      expect(scheduler.snapshot).toMatchObject({
        halted: true,
        retryIn: null,
        problem: { kind, during: "sync" },
      });
      git.take();

      await advance(scheduler, SYNC_INTERVAL_MS);
      git.repo.changed = ["a.md"];
      scheduler.changed();
      await advance(scheduler, COMMIT_DELAY_MS);
      expect(git.take()).toEqual(["status", "status", "commit", "status"]);

      scheduler.syncNow();
      await scheduler.idle();
      expect(git.take()).toEqual(["status", "sync", "status"]);
      expect(scheduler.snapshot).toMatchObject({ halted: false, problem: null });
    },
  );

  it("resumes on focus", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push({ ok: false, kind: "auth", message: "denied" });
    scheduler.syncNow();
    await scheduler.idle();
    await advance(scheduler, FOCUS_SYNC_AGE_MS);
    git.take();
    scheduler.focus();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });

  it("resumes when the repository setup changes", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push({ ok: false, kind: "auth", message: "denied" });
    scheduler.syncNow();
    await scheduler.idle();
    git.repo.upstream = "backup/main";
    git.take();
    await advance(scheduler, SYNC_INTERVAL_MS);
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });

  it("does not resume when only the contents change", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push({ ok: false, kind: "auth", message: "denied" });
    scheduler.syncNow();
    await scheduler.idle();
    git.repo.ahead = 3;
    git.repo.behind = 1;
    git.take();
    await advance(scheduler, SYNC_INTERVAL_MS);
    expect(git.take()).toEqual(["status"]);
  });

  it("does not stop for a failed status read and clears it on the next one", async () => {
    const { git, scheduler } = await started();
    git.statusOverrides.push({ ok: false, kind: "failed", message: "index locked" });
    scheduler.syncNow();
    await scheduler.idle();
    expect(git.take()).toEqual(["status"]);
    expect(scheduler.snapshot).toMatchObject({
      halted: false,
      problem: { kind: "failed", during: "status" },
    });
    scheduler.syncNow();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "sync", "status"]);
    expect(scheduler.snapshot.problem).toBeNull();
  });

  it("keeps a sync problem after a successful commit", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push({ ok: false, kind: "auth", message: "denied" });
    scheduler.syncNow();
    await scheduler.idle();
    git.repo.changed = ["a.md"];
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(scheduler.snapshot.problem).toMatchObject({ kind: "auth" });
  });
});

describe("SyncScheduler suspend and stop", () => {
  it("starts nothing while suspended and catches up on resume", async () => {
    const { git, scheduler } = await started();
    await scheduler.suspend();
    git.repo.changed = ["a.md"];
    scheduler.changed();
    scheduler.syncNow();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual([]);
    scheduler.resume();
    scheduler.resume();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "commit", "status", "sync", "status"]);
  });

  it("waits for the running operation when suspending", async () => {
    const { git, scheduler } = await started();
    git.holding.add("sync");
    scheduler.syncNow();
    await vi.waitFor(() => expect(scheduler.busy).toBe(true));
    let done = false;
    const suspended = scheduler.suspend().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    git.release();
    await suspended;
    expect(done).toBe(true);
  });

  it("stops for good, without publishing the end of the running operation", async () => {
    const { git, scheduler, snapshots } = await started();
    git.holding.add("sync");
    git.repo.changed = ["a.md"];
    scheduler.syncNow();
    await vi.waitFor(() => expect(scheduler.snapshot.activity).toBe("syncing"));
    const published = snapshots.length;
    scheduler.changed();
    const stopped = scheduler.stop();
    git.release();
    await stopped;
    await advance(scheduler, SYNC_INTERVAL_MS);
    expect(snapshots).toHaveLength(published);
    expect(git.take()).toEqual(["status", "commit", "status", "sync"]);
    scheduler.start();
    scheduler.resume();
    await scheduler.idle();
    expect(git.take()).toEqual([]);
  });

  it.each(["status", "commit"] as const)("stops after a running %s", async (operation) => {
    const { git, scheduler } = await started();
    git.repo.changed = ["a.md"];
    git.holding.add(operation);
    scheduler.syncNow();
    await vi.waitFor(() => expect(git.log).toContain(operation));
    const stopped = scheduler.stop();
    git.release();
    await stopped;
    expect(git.take()).toEqual(operation === "status" ? ["status"] : ["status", "commit"]);
  });

  it("stops right after a flush", async () => {
    const { git, scheduler } = await started();
    let release: () => void = () => undefined;
    git.flush = () => new Promise<void>((resolve) => (release = resolve));
    scheduler.syncNow();
    const stopped = scheduler.stop();
    release();
    await stopped;
    expect(git.take()).toEqual([]);
  });

  it("ignores a failing flush", async () => {
    const { git, scheduler } = await started();
    git.flush = () => Promise.reject(new Error("disk full"));
    scheduler.syncNow();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });
});

describe("SyncScheduler deferred syncs", () => {
  const deferred: GitOutcome<SyncResult> = {
    ok: true,
    value: { pulled: 0, pushed: 0, changed: [], conflicts: [], deferred: true },
  };

  it("marks changes pending without counting as synced, then commits and syncs again", async () => {
    const { git, scheduler } = await started();
    const lastSync = scheduler.snapshot.lastSync;
    git.syncOverrides.push(deferred);
    git.repo.changed = [];
    scheduler.syncNow();
    await scheduler.idle();
    expect(scheduler.snapshot).toMatchObject({ pending: true, lastSync, problem: null });
    git.take();
    git.repo.changed = ["a.md"];
    await advance(scheduler, COMMIT_DELAY_MS - 1);
    expect(git.take()).toEqual([]);
    await advance(scheduler, 1);
    expect(git.take()).toEqual(["status", "commit", "status", "sync", "status"]);
    expect(scheduler.snapshot).toMatchObject({ pending: false, lastSync: Date.now() });
  });

  it("gives up retrying after a few deferred syncs in a row", async () => {
    const { git, scheduler } = await started();
    for (let i = 0; i <= MAX_DEFERRED_RETRIES; i += 1) git.syncOverrides.push(deferred);
    scheduler.syncNow();
    await scheduler.idle();
    for (let i = 0; i < MAX_DEFERRED_RETRIES; i += 1) await advance(scheduler, COMMIT_DELAY_MS);
    git.take();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual([]);
    expect(scheduler.snapshot.pending).toBe(true);
    // Sync now starts counting again.
    git.syncOverrides.push(deferred);
    scheduler.syncNow();
    await scheduler.idle();
    git.take();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });

  it("keeps a commit failure next to a deferred sync", async () => {
    const { git, scheduler } = await started();
    git.repo.changed = ["a.md"];
    git.commitOverrides.push({ ok: false, kind: "failed", message: "hook said no" });
    git.syncOverrides.push(deferred);
    // A commit-triggered run with commits ahead still syncs after the failed commit.
    git.repo.ahead = 1;
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(scheduler.snapshot).toMatchObject({
      pending: true,
      problem: { kind: "failed", during: "commit" },
    });
    git.take();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual([]);
  });

  it("drops a pending retry when stopped", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push(deferred);
    scheduler.syncNow();
    await scheduler.idle();
    git.take();
    await scheduler.stop();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual([]);
  });
});

describe("SyncScheduler pauses", () => {
  const pullConflict: GitOutcome<never> = {
    ok: false,
    kind: "paused",
    message: "pull-conflict: image.png",
  };

  it("does not retry a paused sync on focus, but on Sync now", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push(pullConflict);
    scheduler.syncNow();
    await scheduler.idle();
    expect(scheduler.snapshot).toMatchObject({
      halted: true,
      problem: { kind: "paused", during: "sync", message: "pull-conflict: image.png" },
    });
    await advance(scheduler, FOCUS_SYNC_AGE_MS);
    git.take();
    scheduler.focus();
    await scheduler.idle();
    await advance(scheduler, SYNC_INTERVAL_MS);
    expect(git.take()).toEqual(["status", "status"]);
    expect(scheduler.snapshot.halted).toBe(true);
    scheduler.syncNow();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "sync", "status"]);
    expect(scheduler.snapshot).toMatchObject({ halted: false, problem: null });
  });

  it("retries a paused sync once the repository setup changes", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push(pullConflict);
    scheduler.syncNow();
    await scheduler.idle();
    git.repo.upstream = "origin/other";
    git.take();
    await advance(scheduler, SYNC_INTERVAL_MS);
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });

  it("still lifts other stops on focus while none is paused", async () => {
    const { git, scheduler } = await started();
    git.syncOverrides.push({ ok: false, kind: "failed", message: "boom" });
    scheduler.syncNow();
    await scheduler.idle();
    await advance(scheduler, FOCUS_SYNC_AGE_MS);
    git.take();
    scheduler.focus();
    await scheduler.idle();
    expect(git.take()).toEqual(["status", "sync", "status"]);
  });

  it.each(["upstream-gone", "outside-commits"] as const)(
    "syncs on Sync now only when paused by %s",
    async (reason) => {
      const { git, scheduler } = await started();
      git.repo = { ...git.repo, state: "paused", pausedReason: reason };
      await advance(scheduler, SYNC_INTERVAL_MS);
      expect(git.take()).toEqual(["status"]);
      scheduler.focus();
      await scheduler.idle();
      expect(git.take()).toEqual(["status"]);
      scheduler.syncNow();
      await scheduler.idle();
      expect(git.take()).toEqual(["status", "sync", "status"]);
    },
  );

  it.each(["upstream-mismatch", "local-merges", "index-locked", "detached-head"] as const)(
    "never syncs when paused by %s, not even on Sync now",
    async (reason) => {
      const { git, scheduler } = await started();
      git.repo = { ...git.repo, state: "paused", pausedReason: reason };
      scheduler.syncNow();
      await scheduler.idle();
      expect(git.take()).toEqual(["status"]);
    },
  );

  it("commits while paused by local merges", async () => {
    const { git, scheduler } = await started();
    git.repo = { ...git.repo, state: "paused", pausedReason: "local-merges", changed: ["a.md"] };
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status", "commit", "status"]);
  });

  it("checks again after 3 s, 10 s, then every 30 s while a pause keeps changes uncommitted", async () => {
    const { git, scheduler } = await started();
    git.repo = { ...git.repo, state: "paused", pausedReason: "index-locked", changed: ["a.md"] };
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(git.take()).toEqual(["status"]);
    for (const delay of [...PAUSED_RETRY_DELAYS_MS, 30_000]) {
      await advance(scheduler, delay - 1);
      expect(git.take()).toEqual([]);
      await advance(scheduler, 1);
      expect(git.take()).toEqual(["status"]);
    }
    git.repo = { ...git.repo, state: "ready" };
    delete git.repo.pausedReason;
    await advance(scheduler, 30_000);
    expect(git.take()).toEqual(["status", "commit", "status", "sync", "status"]);
    // Committed: no more checks until something changes.
    await advance(scheduler, 30_000);
    expect(git.take()).toEqual([]);
  });

  it("starts the checks over after a commit", async () => {
    const { git, scheduler } = await started();
    git.repo = { ...git.repo, state: "paused", pausedReason: "no-identity", changed: ["a.md"] };
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    await advance(scheduler, PAUSED_RETRY_DELAYS_MS[0] ?? 0);
    git.repo = { ...git.repo, state: "ready" };
    delete git.repo.pausedReason;
    await advance(scheduler, PAUSED_RETRY_DELAYS_MS[1] ?? 0);
    git.repo = { ...git.repo, state: "paused", pausedReason: "no-identity", changed: ["b.md"] };
    git.take();
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    await advance(scheduler, (PAUSED_RETRY_DELAYS_MS[0] ?? 0) - 1);
    expect(git.take()).toEqual(["status"]);
    await advance(scheduler, 1);
    expect(git.take()).toEqual(["status"]);
  });

  it("keeps checking after a paused commit error, without retrying it on focus", async () => {
    const { git, scheduler } = await started((git) => (git.repo.upstream = null));
    git.repo.changed = ["a.md"];
    git.commitOverrides.push({ ok: false, kind: "paused", message: "no-identity" });
    scheduler.changed();
    await advance(scheduler, COMMIT_DELAY_MS);
    expect(scheduler.snapshot).toMatchObject({ halted: true, problem: { kind: "paused" } });
    git.take();
    await advance(scheduler, (PAUSED_RETRY_DELAYS_MS[0] ?? 0) - 1);
    scheduler.focus();
    await scheduler.idle();
    expect(git.take()).toEqual(["status"]);
    expect(scheduler.snapshot.halted).toBe(true);
    // The check after the error sees the pause in the status, which lifts the stop.
    git.repo = { ...git.repo, state: "paused", pausedReason: "no-identity" };
    // The focus run already took the first delay.
    await advance(scheduler, PAUSED_RETRY_DELAYS_MS[1] ?? 0);
    expect(git.take()).toEqual(["status"]);
    expect(scheduler.snapshot.halted).toBe(false);
    git.repo = { ...git.repo, state: "ready" };
    delete git.repo.pausedReason;
    await advance(scheduler, PAUSED_RETRY_DELAYS_MS[2] ?? 0);
    expect(git.take()).toEqual(["status", "commit", "status"]);
  });
});
