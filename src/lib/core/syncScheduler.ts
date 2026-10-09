/**
 * Decides when to commit and when to sync with the upstream. Git itself runs
 * in the backend; this state machine only orders the calls.
 *
 * - **Commit** 3 s after the last change (the app's own writes and changes
 *   from outside alike), when the repository allows commits.
 * - **Sync** (fetch, rebase, push) right after a commit when there is an
 *   upstream, on start, every 5 minutes, on window focus when the last
 *   attempt is older than a minute, and on "Sync now".
 * - Never two git operations at once: requests made while one runs
 *   coalesce into a single follow-up.
 * - Network failures retry after 30 s, 1 min, 2 min, then every 5 min.
 *   Authentication and other failures stop automatic syncing until "Sync
 *   now", window focus or a change of the repository state.
 * - A paused repository (from its status, or a `GitPaused` error) waits for
 *   the user: window focus does not retry it, only "Sync now" or a change
 *   of the repository state does. Changes that cannot be committed because
 *   of a pause are checked again after 3 s, 10 s, then every 30 s.
 * - Pending autosaves are flushed before every commit and sync.
 * - A sync the backend deferred because of uncommitted changes is tried
 *   again (commit, then sync) after the commit delay, a few times at most.
 *
 * Timers and git access are passed in, so the whole flow can be tested with
 * fakes. Nothing here awaits on an input path: `changed()`, `focus()` and
 * `syncNow()` only schedule work.
 */

import {
  canCommit,
  canSync,
  canSyncManually,
  type CommitResult,
  type GitStatus,
  type SyncResult,
} from "./git";
import type { TimerHandle, Timers } from "./saveMachine";

/** Idle time after the last change before committing. */
export const COMMIT_DELAY_MS = 3_000;
/** Automatic sync interval while the app is open. */
export const SYNC_INTERVAL_MS = 5 * 60_000;
/** Focusing the window syncs when the last attempt is at least this old. */
export const FOCUS_SYNC_AGE_MS = 60_000;
/** Deferred syncs retried in a row before waiting for the next trigger. */
export const MAX_DEFERRED_RETRIES = 3;
/** Delays before checking again whether a pause still blocks a commit; the last one repeats. */
export const PAUSED_RETRY_DELAYS_MS: readonly number[] = [3_000, 10_000, 30_000];
/** Retry delays after network failures; the last one repeats. */
export const BACKOFF_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000];

export type GitErrorKind = "unavailable" | "paused" | "network" | "auth" | "failed";

export type GitOutcome<T> =
  { ok: true; value: T } | { ok: false; kind: GitErrorKind; message: string };

/** Git access for the scheduler. Implementations report failures as outcomes. */
export interface SyncIO {
  status(): Promise<GitOutcome<GitStatus>>;
  commit(message: string): Promise<GitOutcome<CommitResult>>;
  sync(): Promise<GitOutcome<SyncResult>>;
  /** Writes pending edits to disk (best effort). */
  flush(): Promise<void>;
  /** The commit message for the changed paths, or `null` to skip committing. */
  message(changed: readonly string[]): string | null;
}

export type SyncActivity = "idle" | "committing" | "syncing";

export interface SyncProblem {
  kind: GitErrorKind;
  message: string;
  during: "status" | "commit" | "sync";
}

export interface SyncSnapshot {
  /** The last status read, or `null` before the first one. */
  status: GitStatus | null;
  activity: SyncActivity;
  /** Number of changed paths being committed. */
  committing: number;
  /** When the last sync succeeded. */
  lastSync: number | null;
  /** The last failure, until an operation of the same kind succeeds. */
  problem: SyncProblem | null;
  /** Delay before the next retry after a network failure, or `null`. */
  retryIn: number | null;
  /** Automatic syncing is stopped until "Sync now", focus or a repository change. */
  halted: boolean;
  /** The last sync was deferred: local changes are not committed and pushed yet. */
  pending: boolean;
}

export interface SyncEvents {
  changed?(snapshot: SyncSnapshot): void;
  committed?(result: CommitResult): void;
  synced?(result: SyncResult): void;
}

export interface SyncSchedulerOptions {
  io: SyncIO;
  timers: Timers;
  events?: SyncEvents;
  commitDelay?: number;
  syncInterval?: number;
  focusSyncAge?: number;
  backoffDelays?: readonly number[];
  pausedRetryDelays?: readonly number[];
}

type RunKind = "status" | "commit" | "sync";
/** `auto` runs respect stops and backoff; `retry` is the backoff timer; `manual` is "Sync now". */
type Trigger = "auto" | "retry" | "manual";

interface Request {
  kind: RunKind;
  trigger: Trigger;
}

const RUN_RANK: Record<RunKind, number> = { status: 0, commit: 1, sync: 2 };
const TRIGGER_RANK: Record<Trigger, number> = { auto: 0, retry: 1, manual: 2 };

function merge(a: Request | null, b: Request): Request {
  if (!a) return b;
  return {
    kind: RUN_RANK[a.kind] >= RUN_RANK[b.kind] ? a.kind : b.kind,
    trigger: TRIGGER_RANK[a.trigger] >= TRIGGER_RANK[b.trigger] ? a.trigger : b.trigger,
  };
}

/** The parts of a status whose change lifts a stop: the repository's setup, not its contents. */
function statusKey(status: GitStatus): string {
  if (status.state === "unavailable") return `unavailable:${status.reason}`;
  return JSON.stringify([
    status.state,
    status.pausedReason ?? null,
    status.operation ?? null,
    status.branch,
    status.upstream,
    status.remote,
  ]);
}

async function guarded<T>(work: () => Promise<GitOutcome<T>>): Promise<GitOutcome<T>> {
  try {
    return await work();
  } catch (error) {
    return {
      ok: false,
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export class SyncScheduler {
  readonly #io: SyncIO;
  readonly #timers: Timers;
  readonly #events: SyncEvents;
  readonly #commitDelay: number;
  readonly #syncInterval: number;
  readonly #focusSyncAge: number;
  readonly #backoffDelays: readonly number[];
  readonly #pausedRetryDelays: readonly number[];

  #snapshot: SyncSnapshot = {
    status: null,
    activity: "idle",
    committing: 0,
    lastSync: null,
    problem: null,
    retryIn: null,
    halted: false,
    pending: false,
  };

  #running: Promise<void> | null = null;
  #next: Request | null = null;
  #commitTimer: TimerHandle | null = null;
  #intervalTimer: TimerHandle | null = null;
  #retryTimer: TimerHandle | null = null;
  #deferTimer: TimerHandle | null = null;
  /** Deferred syncs in a row. */
  #deferrals = 0;
  #failures = 0;
  #lastAttempt: number | null = null;
  #syncHalted = false;
  #commitHalted = false;
  /** The stop comes from a paused repository: focus does not lift it. */
  #stickyHalt = false;
  /** Checks in a row of changes a pause kept from being committed. */
  #pausedRetries = 0;
  /** The repository state when syncing or committing was stopped. */
  #haltKey: string | null = null;
  #started = false;
  #suspended = false;
  #stopped = false;

  constructor(options: SyncSchedulerOptions) {
    this.#io = options.io;
    this.#timers = options.timers;
    this.#events = options.events ?? {};
    this.#commitDelay = options.commitDelay ?? COMMIT_DELAY_MS;
    this.#syncInterval = options.syncInterval ?? SYNC_INTERVAL_MS;
    this.#focusSyncAge = options.focusSyncAge ?? FOCUS_SYNC_AGE_MS;
    this.#backoffDelays = options.backoffDelays ?? BACKOFF_DELAYS_MS;
    this.#pausedRetryDelays = options.pausedRetryDelays ?? PAUSED_RETRY_DELAYS_MS;
  }

  get snapshot(): SyncSnapshot {
    return this.#snapshot;
  }

  /** Whether a git operation is running. */
  get busy(): boolean {
    return this.#running !== null;
  }

  /** Reads the status, commits what is left from before and syncs. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#request({ kind: "sync", trigger: "auto" });
  }

  /** A file changed: commit once changes stop for a while. */
  changed(): void {
    if (this.#stopped) return;
    this.#clear("commit");
    this.#commitTimer = this.#timers.setTimeout(() => {
      this.#commitTimer = null;
      this.#request({ kind: "commit", trigger: "auto" });
    }, this.#commitDelay);
  }

  /** "Sync now": lifts stops and backoff, then commits and syncs. */
  syncNow(): void {
    if (this.#stopped) return;
    this.#lift(true);
    this.#request({ kind: "sync", trigger: "manual" });
  }

  /**
   * The window got focus: lifts stops (except those of a paused repository)
   * and backoff, refreshes the status and syncs if the last attempt is older
   * than a minute or a retry is pending.
   */
  focus(): void {
    if (this.#stopped || !this.#started) return;
    // A pending network retry is due now: the connection may be back.
    const retrying = this.#retryTimer !== null;
    this.#lift(false);
    const last = this.#lastAttempt;
    const stale = retrying || last === null || this.#timers.now() - last >= this.#focusSyncAge;
    this.#request({ kind: stale ? "sync" : "status", trigger: "auto" });
  }

  /** Starts no new operation until `resume`; resolves when the running one is done. */
  suspend(): Promise<void> {
    this.#suspended = true;
    return this.idle();
  }

  resume(): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    const next = this.#next;
    this.#next = null;
    if (next && !this.#stopped) this.#request(next);
  }

  /** Stops for good; resolves when the running operation is done. */
  stop(): Promise<void> {
    this.#stopped = true;
    this.#next = null;
    this.#clear("commit");
    this.#clear("interval");
    this.#clear("retry");
    this.#clear("defer");
    return this.idle();
  }

  /** Resolves when no operation is running (follow-ups included). */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  /** Lifts stops (only "Sync now" lifts those of a paused repository) and resets backoff. */
  #lift(manual: boolean): void {
    if (manual || !this.#stickyHalt) this.#unhalt();
    this.#failures = 0;
    this.#deferrals = 0;
    this.#clear("retry");
    this.#update({ retryIn: null, halted: this.#syncHalted || this.#commitHalted });
  }

  #unhalt(): void {
    this.#syncHalted = false;
    this.#commitHalted = false;
    this.#stickyHalt = false;
    this.#haltKey = null;
  }

  #clear(timer: "commit" | "interval" | "retry" | "defer"): void {
    if (timer === "defer") {
      if (this.#deferTimer !== null) this.#timers.clearTimeout(this.#deferTimer);
      this.#deferTimer = null;
      return;
    }
    const handle =
      timer === "commit"
        ? this.#commitTimer
        : timer === "interval"
          ? this.#intervalTimer
          : this.#retryTimer;
    if (handle === null) return;
    this.#timers.clearTimeout(handle);
    if (timer === "commit") this.#commitTimer = null;
    else if (timer === "interval") this.#intervalTimer = null;
    else this.#retryTimer = null;
  }

  #request(request: Request): void {
    if (this.#stopped) return;
    if (this.#running || this.#suspended) {
      this.#next = merge(this.#next, request);
      return;
    }
    const run = this.#run(request).finally(() => {
      this.#running = null;
      const next = this.#next;
      if (!next || this.#suspended || this.#stopped) return;
      this.#next = null;
      this.#request(next);
    });
    this.#running = run;
  }

  #update(patch: Partial<SyncSnapshot>): void {
    if (this.#stopped) return;
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#events.changed?.(this.#snapshot);
  }

  async #run({ kind, trigger }: Request): Promise<void> {
    if (kind !== "status") {
      try {
        await this.#io.flush();
      } catch {
        // Best effort; the backend serializes writes with git anyway.
      }
      if (this.#stopped) return;
    }
    let status = await this.#readStatus();
    if (status === null || this.#stopped || status.state === "unavailable") return;
    if (kind === "status") return;

    let committed = false;
    const pausedCommit =
      status.changed.length > 0 && (!canCommit(status) || (this.#commitHalted && this.#stickyHalt));
    if (pausedCommit) this.#retryPausedCommit();
    else this.#pausedRetries = 0;
    if (canCommit(status) && status.changed.length > 0 && !this.#commitHalted) {
      const message = this.#io.message(status.changed);
      if (message !== null) {
        this.#update({ activity: "committing", committing: status.changed.length });
        const outcome = await guarded(() => this.#io.commit(message));
        if (this.#stopped) return;
        if (outcome.ok) {
          committed = outcome.value.commit !== null;
          const problem =
            this.#snapshot.problem?.during === "commit" ? null : this.#snapshot.problem;
          this.#update({ activity: "idle", committing: 0, problem });
          this.#events.committed?.(outcome.value);
        } else {
          this.#update({ activity: "idle", committing: 0 });
          this.#fail(outcome, "commit");
        }
        status = (await this.#readStatus()) ?? status;
        if (this.#stopped || status.state === "unavailable") return;
      }
    }

    const wanted = kind === "sync" || committed || status.ahead > 0;
    const allowed =
      trigger === "manual" ||
      (!this.#syncHalted && (trigger === "retry" || this.#retryTimer === null));
    const syncable = canSync(status) || (trigger === "manual" && canSyncManually(status));
    if (!wanted || !allowed || !syncable) return;

    this.#lastAttempt = this.#timers.now();
    this.#update({ activity: "syncing" });
    const outcome = await guarded(() => this.#io.sync());
    if (this.#stopped) return;
    if (outcome.ok && outcome.value.deferred) {
      this.#failures = 0;
      this.#clear("retry");
      // A commit failure explains why changes are left; keep showing it.
      const problem = this.#snapshot.problem?.during === "commit" ? this.#snapshot.problem : null;
      this.#update({ activity: "idle", pending: true, problem, retryIn: null });
      this.#retryDeferred();
      this.#events.synced?.(outcome.value);
    } else if (outcome.ok) {
      this.#failures = 0;
      this.#deferrals = 0;
      this.#clear("retry");
      this.#clear("defer");
      this.#update({
        activity: "idle",
        lastSync: this.#timers.now(),
        problem: null,
        retryIn: null,
        halted: false,
        pending: false,
      });
      this.#events.synced?.(outcome.value);
    } else {
      this.#update({ activity: "idle" });
      this.#fail(outcome, "sync");
    }
    this.#armInterval();
    await this.#readStatus();
  }

  /** Reads and publishes the status; a changed repository setup lifts stops. */
  async #readStatus(): Promise<GitStatus | null> {
    const outcome = await guarded(() => this.#io.status());
    if (this.#stopped) return null;
    if (!outcome.ok) {
      this.#fail(outcome, "status");
      return null;
    }
    const status = outcome.value;
    if (this.#haltKey !== null && statusKey(status) !== this.#haltKey) this.#unhalt();
    const problem = this.#snapshot.problem?.during === "status" ? null : this.#snapshot.problem;
    this.#update({ status, problem, halted: this.#syncHalted || this.#commitHalted });
    if (!this.#intervalTimer && this.#started) this.#armInterval();
    return status;
  }

  #fail(outcome: { kind: GitErrorKind; message: string }, during: SyncProblem["during"]): void {
    const problem: SyncProblem = { kind: outcome.kind, message: outcome.message, during };
    if (outcome.kind === "network" && during === "sync") {
      const index = Math.min(this.#failures, this.#backoffDelays.length - 1);
      const delay = this.#backoffDelays[index] ?? SYNC_INTERVAL_MS;
      this.#failures += 1;
      this.#clear("retry");
      this.#retryTimer = this.#timers.setTimeout(() => {
        this.#retryTimer = null;
        this.#request({ kind: "sync", trigger: "retry" });
      }, delay);
      this.#update({ problem, retryIn: delay });
      return;
    }
    if (outcome.kind !== "network" && during !== "status") {
      // Retrying would fail the same way until something changes.
      if (during === "commit") this.#commitHalted = true;
      else this.#syncHalted = true;
      if (outcome.kind === "paused") {
        this.#stickyHalt = true;
        // The changes are still there; look again once the pause may be over.
        if (during === "commit") this.#retryPausedCommit();
      }
      const status = this.#snapshot.status;
      if (status !== null) this.#haltKey = statusKey(status);
    }
    this.#update({ problem, halted: this.#syncHalted || this.#commitHalted });
  }

  /** Checks again soon whether the pause that kept changes from a commit is over. */
  #retryPausedCommit(): void {
    const index = Math.min(this.#pausedRetries, this.#pausedRetryDelays.length - 1);
    const delay = this.#pausedRetryDelays[index] ?? this.#commitDelay;
    this.#pausedRetries += 1;
    this.#clear("commit");
    this.#commitTimer = this.#timers.setTimeout(() => {
      this.#commitTimer = null;
      this.#request({ kind: "commit", trigger: "auto" });
    }, delay);
  }

  /** Commits and syncs again soon, unless commits are stopped or this keeps happening. */
  #retryDeferred(): void {
    this.#clear("defer");
    if (this.#commitHalted || this.#deferrals >= MAX_DEFERRED_RETRIES) return;
    this.#deferrals += 1;
    this.#deferTimer = this.#timers.setTimeout(() => {
      this.#deferTimer = null;
      this.#request({ kind: "sync", trigger: "auto" });
    }, this.#commitDelay);
  }

  #armInterval(): void {
    this.#clear("interval");
    if (this.#stopped) return;
    this.#intervalTimer = this.#timers.setTimeout(() => {
      this.#intervalTimer = null;
      this.#request({ kind: "sync", trigger: "auto" });
    }, this.#syncInterval);
  }
}
