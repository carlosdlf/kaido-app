import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseName,
  conflictCopyPath,
  conflictStamp,
  describeSaveStatus,
  MAX_CONFLICT_ATTEMPTS,
  SAVE_DELAY_MS,
  sameStatus,
  SaveSession,
  type DocumentIO,
  type ReadOutcome,
  type SaveStatus,
  type Timers,
  type WriteOutcome,
} from "./saveMachine";

const hash = (text: string) => `h:${text}`;

/** An in-memory disk with hooks to fail or hold operations. */
class FakeDisk implements DocumentIO {
  readonly files = new Map<string, string>();
  readonly writes: { path: string; contents: string; expected: string | null }[] = [];
  readonly reads: string[] = [];
  readonly writeOverrides: (WriteOutcome | Error)[] = [];
  readOverrides: (ReadOutcome | Error)[] = [];
  /** Runs before each write is applied, e.g. to change the file concurrently. */
  beforeWrite: ((path: string) => void) | null = null;
  #held: (() => void)[] = [];
  holding = false;

  async read(path: string): Promise<ReadOutcome> {
    this.reads.push(path);
    const override = this.readOverrides.shift();
    if (override instanceof Error) throw override;
    if (override) return override;
    const contents = this.files.get(path);
    return contents === undefined
      ? { kind: "missing" }
      : { kind: "ok", contents, hash: hash(contents) };
  }

  async write(path: string, contents: string, expected: string | null): Promise<WriteOutcome> {
    this.writes.push({ path, contents, expected });
    if (this.holding) await new Promise<void>((resolve) => this.#held.push(resolve));
    this.beforeWrite?.(path);
    const override = this.writeOverrides.shift();
    if (override instanceof Error) throw override;
    if (override) return override;
    const current = this.files.get(path);
    if (
      expected === null
        ? current !== undefined
        : current === undefined || hash(current) !== expected
    ) {
      return { kind: "conflict" };
    }
    this.files.set(path, contents);
    return { kind: "ok", hash: hash(contents) };
  }

  release(): void {
    this.holding = false;
    for (const resolve of this.#held.splice(0)) resolve();
  }
}

/** The test runner's timers, faked below; the core itself has no timer globals. */
const host = globalThis as unknown as {
  setTimeout(task: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

const timers: Timers = {
  now: () => Date.now(),
  setTimeout: (task, delay) => host.setTimeout(task, delay),
  clearTimeout: (handle) => host.clearTimeout(handle),
};

const NOW = new Date(2026, 9, 8, 14, 32).getTime();

function setup(contents = "base", path = "notes/a.md") {
  const disk = new FakeDisk();
  disk.files.set(path, contents);
  const statuses: SaveStatus[] = [];
  const events = {
    status: vi.fn((status: SaveStatus) => statuses.push(status)),
    saved: vi.fn(),
    reloaded: vi.fn(),
    removed: vi.fn(),
    conflict: vi.fn(),
  };
  const session = new SaveSession({
    path,
    contents,
    hash: hash(contents),
    savedAt: 1,
    io: disk,
    timers,
    events,
  });
  const type = (text: string) => session.edit(() => text);
  return { disk, session, events, statuses, type, path };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("conflict copies", () => {
  it("names copies next to the file with a local time stamp", () => {
    expect(conflictStamp(NOW)).toBe("2026-10-08 1432");
    expect(conflictCopyPath("api/deploy.md", NOW)).toBe("api/deploy (conflict 2026-10-08 1432).md");
    expect(conflictCopyPath("api/deploy.md", NOW, 2)).toBe(
      "api/deploy (conflict 2026-10-08 1432) 2.md",
    );
    expect(conflictCopyPath("Loose.MD", NOW, 3)).toBe("Loose (conflict 2026-10-08 1432) 3.MD");
    expect(conflictCopyPath("a/odd", NOW)).toBe("a/odd (conflict 2026-10-08 1432).md");
  });

  it("finds file names", () => {
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(baseName("c.md")).toBe("c.md");
  });
});

describe("describeSaveStatus", () => {
  it("labels each status", () => {
    expect(describeSaveStatus({ kind: "saved", at: NOW }, NOW + 1_000)).toBe("saved · just now");
    expect(describeSaveStatus({ kind: "saved", at: NOW }, NOW + 120_000)).toBe("saved · 2m ago");
    expect(describeSaveStatus({ kind: "saving" }, NOW)).toBe("saving…");
    expect(describeSaveStatus({ kind: "unsaved" }, NOW)).toBe("unsaved");
    expect(describeSaveStatus({ kind: "failed", message: "x" }, NOW)).toBe(
      "save failed — retrying",
    );
  });
});

describe("sameStatus", () => {
  it("compares kinds and their details", () => {
    expect(sameStatus({ kind: "saved", at: 1 }, { kind: "saved", at: 1 })).toBe(true);
    expect(sameStatus({ kind: "saved", at: 1 }, { kind: "saved", at: 2 })).toBe(false);
    expect(sameStatus({ kind: "saved", at: 1 }, { kind: "saving" })).toBe(false);
    expect(sameStatus({ kind: "failed", message: "a" }, { kind: "failed", message: "a" })).toBe(
      true,
    );
    expect(sameStatus({ kind: "failed", message: "a" }, { kind: "failed", message: "b" })).toBe(
      false,
    );
    expect(sameStatus({ kind: "failed", message: "a" }, { kind: "unsaved" })).toBe(false);
    expect(sameStatus({ kind: "saving" }, { kind: "saving" })).toBe(true);
    expect(sameStatus({ kind: "unsaved" }, { kind: "saving" })).toBe(false);
  });
});

describe("SaveSession saving", () => {
  it("starts saved with the file's time", () => {
    const { session } = setup();
    expect(session.status).toEqual({ kind: "saved", at: 1 });
    expect(session.text).toBe("base");
    expect(session.dirty).toBe(false);
    expect(session.idle).toBe(true);
  });

  it("saves once, 500 ms after the last edit", async () => {
    const { disk, session, events, statuses, type, path } = setup();
    type("b");
    expect(session.status).toEqual({ kind: "unsaved" });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
    type("ba");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
    expect(disk.writes).toHaveLength(0);
    expect(session.idle).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await session.settled();
    expect(disk.writes).toEqual([{ path, contents: "ba", expected: hash("base") }]);
    expect(disk.files.get(path)).toBe("ba");
    expect(events.saved).toHaveBeenCalledWith("ba");
    expect(statuses).toEqual([
      { kind: "unsaved" },
      { kind: "saving" },
      { kind: "saved", at: NOW + 2 * SAVE_DELAY_MS - 1 },
    ]);
    expect(session.idle).toBe(true);
  });

  it("reads the buffer lazily", async () => {
    const { session } = setup();
    const read = vi.fn(() => "lazy");
    session.edit(read);
    session.edit(read);
    expect(read).not.toHaveBeenCalled();
    expect(session.text).toBe("lazy");
    expect(session.text).toBe("lazy");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("chains saves with the hash of the previous write", async () => {
    const { disk, session, type, path } = setup();
    type("one");
    await session.flush();
    type("two");
    await session.flush();
    expect(disk.writes.map((write) => write.expected)).toEqual([hash("base"), hash("one")]);
    expect(disk.files.get(path)).toBe("two");
  });

  it("does not write when the buffer is back to the disk version", async () => {
    const { disk, session, type } = setup();
    type("changed");
    type("base");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await session.settled();
    expect(disk.writes).toHaveLength(0);
    expect(session.status).toEqual({ kind: "saved", at: 1 });
  });

  it("flushes immediately and does nothing when clean", async () => {
    const { disk, session, type } = setup();
    await session.flush();
    expect(disk.writes).toHaveLength(0);
    type("now");
    await session.flush();
    expect(disk.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS * 2);
    expect(disk.writes).toHaveLength(1);
  });

  it("keeps one write in flight and saves edits made meanwhile afterwards", async () => {
    const { disk, session, type, path, statuses } = setup();
    disk.holding = true;
    type("first");
    const first = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.writes).toHaveLength(1);
    type("second");
    const second = session.flush();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(disk.writes).toHaveLength(1);
    expect(session.status).toEqual({ kind: "saving" });
    disk.release();
    await second;
    expect(disk.writes.map((write) => write.contents)).toEqual(["first", "second"]);
    expect(disk.writes[1]?.expected).toBe(hash("first"));
    expect(disk.files.get(path)).toBe("second");
    expect(statuses.at(-1)).toEqual({ kind: "saved", at: NOW });
  });

  it("shows unsaved after a write when newer edits are waiting for the timer", async () => {
    const { disk, session, type } = setup();
    disk.holding = true;
    type("first");
    const flushed = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    type("second");
    disk.release();
    await flushed;
    expect(session.status).toEqual({ kind: "unsaved" });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await session.settled();
    expect(session.status).toEqual({ kind: "saved", at: NOW + SAVE_DELAY_MS });
  });

  it("keeps the buffer and retries after a failure", async () => {
    const { disk, session, type, path } = setup();
    disk.writeOverrides.push({ kind: "error", message: "read-only" }, new Error("disk gone"));
    type("mine");
    await session.flush();
    expect(session.status).toEqual({ kind: "failed", message: "read-only" });
    expect(session.text).toBe("mine");
    // Retries back off.
    await vi.advanceTimersByTimeAsync(2_000);
    await session.settled();
    expect(session.status).toEqual({ kind: "failed", message: "disk gone" });
    expect(disk.writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(disk.writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await session.settled();
    expect(disk.writes).toHaveLength(3);
    expect(disk.files.get(path)).toBe("mine");
    expect(session.status).toEqual({ kind: "saved", at: NOW + 7_000 });
  });

  it("keeps the failed status while typing and retries on the next edit", async () => {
    const { disk, session, type } = setup();
    disk.writeOverrides.push({ kind: "error", message: "no" });
    type("mine");
    await session.flush();
    type("mine2");
    expect(session.status.kind).toBe("failed");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await session.settled();
    expect(session.status.kind).toBe("saved");
  });

  it("repeats the longest retry delay", async () => {
    const disk = new FakeDisk();
    disk.files.set("a.md", "x");
    const session = new SaveSession({
      path: "a.md",
      contents: "x",
      hash: hash("x"),
      savedAt: 0,
      io: disk,
      timers,
      retryDelays: [10],
    });
    disk.writeOverrides.push(...Array.from({ length: 3 }, () => new Error("no")));
    session.edit(() => "y");
    await session.flush();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await session.settled();
    expect(disk.writes).toHaveLength(3);
    const empty = new SaveSession({
      path: "a.md",
      contents: "x",
      hash: hash("y"),
      savedAt: 0,
      io: disk,
      timers,
      retryDelays: [],
      saveDelay: 50,
    });
    disk.writeOverrides.push(new Error("no"));
    empty.edit(() => "z");
    await empty.flush();
    expect(empty.status.kind).toBe("failed");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await empty.settled();
    expect(empty.status.kind).toBe("saved");
  });

  it("stops after dispose", async () => {
    const { disk, session, type, events } = setup();
    type("x");
    session.dispose();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await session.flush();
    await session.externalChange();
    session.edit(() => "y");
    expect(disk.writes).toHaveLength(0);
    expect(events.status).toHaveBeenCalledTimes(1);
  });

  it("drops the result of a write that finishes after dispose", async () => {
    const { disk, session, type, events } = setup();
    disk.holding = true;
    type("x");
    const flushed = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    session.dispose();
    disk.release();
    await flushed;
    expect(events.saved).not.toHaveBeenCalled();
  });
});

describe("SaveSession external changes", () => {
  it("ignores the echo of its own write", async () => {
    const { disk, session, type, events } = setup();
    type("mine");
    await session.flush();
    await session.externalChange();
    expect(disk.reads).toHaveLength(1);
    expect(events.reloaded).not.toHaveBeenCalled();
    expect(events.conflict).not.toHaveBeenCalled();
  });

  it("checks an echo that arrives during the write after it completes", async () => {
    const { disk, session, type, events } = setup();
    disk.holding = true;
    type("mine");
    void session.flush();
    await vi.advanceTimersByTimeAsync(0);
    const checked = session.externalChange();
    disk.release();
    await checked;
    expect(events.conflict).not.toHaveBeenCalled();
    expect(session.status).toEqual({ kind: "saved", at: NOW });
  });

  it("reloads a clean buffer silently", async () => {
    const { disk, session, events, path } = setup();
    disk.files.set(path, "theirs");
    await session.externalChange();
    expect(events.reloaded).toHaveBeenCalledWith("theirs");
    expect(session.text).toBe("theirs");
    expect(session.dirty).toBe(false);
    expect(session.status).toEqual({ kind: "saved", at: NOW });
  });

  it("adopts a disk version equal to the buffer", async () => {
    const { disk, session, type, events, path } = setup();
    type("same");
    disk.files.set(path, "same");
    await session.externalChange();
    expect(events.reloaded).not.toHaveBeenCalled();
    expect(session.status).toEqual({ kind: "saved", at: 1 });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await session.settled();
    expect(disk.writes).toHaveLength(0);
  });

  it("keeps both versions when the buffer has unsaved edits", async () => {
    const { disk, session, type, events, path } = setup("base", "api/deploy.md");
    type("mine");
    disk.files.set(path, "theirs");
    await session.externalChange();
    const copy = "api/deploy (conflict 2026-10-08 1432).md";
    expect(disk.files.get(copy)).toBe("theirs");
    expect(disk.files.get(path)).toBe("mine");
    expect(disk.writes).toEqual([
      { path: copy, contents: "theirs", expected: null },
      { path, contents: "mine", expected: hash("theirs") },
    ]);
    expect(events.conflict).toHaveBeenCalledWith(copy);
    expect(events.saved).toHaveBeenCalledWith("mine");
    expect(session.status).toEqual({ kind: "saved", at: NOW });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await session.settled();
    expect(disk.writes).toHaveLength(2);
  });

  it("resolves a conflict reported by a write", async () => {
    const { disk, session, type, events, path } = setup("base", "a.md");
    disk.files.set(path, "theirs");
    type("mine");
    await session.flush();
    expect(disk.files.get("a (conflict 2026-10-08 1432).md")).toBe("theirs");
    expect(disk.files.get(path)).toBe("mine");
    expect(events.conflict).toHaveBeenCalledTimes(1);
  });

  it("numbers conflict copies when the name is taken", async () => {
    const { disk, session, type, path } = setup("base", "a.md");
    disk.files.set("a (conflict 2026-10-08 1432).md", "older");
    disk.files.set("a (conflict 2026-10-08 1432) 2.md", "older");
    disk.files.set(path, "theirs");
    type("mine");
    await session.flush();
    expect(disk.files.get("a (conflict 2026-10-08 1432) 3.md")).toBe("theirs");
    expect(disk.files.get("a (conflict 2026-10-08 1432).md")).toBe("older");
  });

  it("gives up when no copy name is free", async () => {
    const { disk, session, type, path } = setup("base", "a.md");
    disk.files.set(path, "theirs");
    disk.beforeWrite = (target) => {
      if (target !== path) disk.files.set(target, "taken");
    };
    type("mine");
    await session.flush();
    expect(session.status).toEqual({
      kind: "failed",
      message: "No free name for a conflict copy.",
    });
    expect(disk.files.get(path)).toBe("theirs");
  });

  it("retries the whole flow when the file changes again, up to a limit", async () => {
    const { disk, session, type, events, path } = setup("base", "a.md");
    disk.files.set(path, "theirs");
    let round = 0;
    disk.beforeWrite = (target) => {
      if (target === path) disk.files.set(path, `theirs ${(round += 1)}`);
    };
    type("mine");
    await session.flush();
    // The first write and one per attempt.
    expect(events.conflict).toHaveBeenCalledTimes(MAX_CONFLICT_ATTEMPTS);
    expect(session.status).toEqual({ kind: "failed", message: "The file keeps changing on disk." });
    expect(session.text).toBe("mine");
    disk.beforeWrite = null;
    await vi.advanceTimersByTimeAsync(2_000);
    await session.settled();
    expect(disk.files.get(path)).toBe("mine");
    expect(session.status.kind).toBe("saved");
  });

  it("succeeds on a later attempt", async () => {
    const { disk, session, type, events, path } = setup("base", "a.md");
    disk.files.set(path, "theirs");
    let changes = 2;
    disk.beforeWrite = (target) => {
      if (target === path && changes > 0) {
        changes -= 1;
        disk.files.set(path, `theirs ${changes}`);
      }
    };
    type("mine");
    await session.flush();
    expect(events.conflict).toHaveBeenCalledTimes(2);
    expect(disk.files.get(path)).toBe("mine");
  });

  it("stops the conflict flow when reading or writing fails", async () => {
    const reading = setup("base", "a.md");
    reading.disk.files.set("a.md", "theirs");
    reading.disk.readOverrides = [new Error("cannot read")];
    reading.type("mine");
    await reading.session.flush();
    expect(reading.session.status).toEqual({ kind: "failed", message: "cannot read" });

    const copying = setup("base", "a.md");
    copying.disk.files.set("a.md", "theirs");
    copying.type("mine");
    copying.disk.writeOverrides.push({ kind: "conflict" }, { kind: "error", message: "full" });
    await copying.session.flush();
    expect(copying.session.status).toEqual({ kind: "failed", message: "full" });

    const writing = setup("base", "a.md");
    writing.disk.files.set("a.md", "theirs");
    writing.type("mine");
    writing.disk.writeOverrides.push(
      { kind: "conflict" },
      { kind: "ok", hash: "copy" },
      { kind: "error", message: "locked" },
    );
    await writing.session.flush();
    expect(writing.session.status).toEqual({ kind: "failed", message: "locked" });
    expect(writing.events.conflict).toHaveBeenCalledTimes(1);
  });

  it("writes one copy when saving after a conflict fails and is retried", async () => {
    const { disk, session, type, events, path } = setup("base", "a.md");
    disk.files.set(path, "theirs");
    type("mine");
    // The copy is written, then writing the buffer fails once.
    disk.writeOverrides.push(
      { kind: "conflict" },
      { kind: "ok", hash: "copy" },
      { kind: "error", message: "locked" },
    );
    disk.beforeWrite = (target) => {
      if (target !== path) disk.files.set(target, "theirs");
    };
    await session.flush();
    disk.beforeWrite = null;
    expect(session.status).toEqual({ kind: "failed", message: "locked" });
    expect(events.conflict).toHaveBeenCalledTimes(1);
    const copy = "a (conflict 2026-10-08 1432).md";
    expect(disk.files.get(copy)).toBe("theirs");

    // The watcher reports the version that was kept: nothing new.
    await session.externalChange();
    await vi.advanceTimersByTimeAsync(2_000);
    await session.settled();
    expect(disk.files.get(path)).toBe("mine");
    expect(events.conflict).toHaveBeenCalledTimes(1);
    expect(disk.files.has("a (conflict 2026-10-08 1432) 2.md")).toBe(false);
    expect(disk.writes.at(-1)).toEqual({ path, contents: "mine", expected: hash("theirs") });
    expect(session.status.kind).toBe("saved");
  });

  it("writes no copy of a version that already is the base", async () => {
    const { disk, session, type, events, path } = setup("base", "a.md");
    // The write reports a conflict, but the file still has the base version.
    disk.writeOverrides.push({ kind: "conflict" });
    type("mine");
    await session.flush();
    expect(events.conflict).not.toHaveBeenCalled();
    expect(disk.writes.map((write) => write.path)).toEqual([path, path]);
    expect(disk.files.get(path)).toBe("mine");
  });

  it("adopts the disk version when it already matches during a conflict", async () => {
    const { disk, session, type, events, path } = setup("base", "a.md");
    disk.files.set(path, "mine");
    disk.writeOverrides.push({ kind: "conflict" });
    type("mine");
    await session.flush();
    expect(events.conflict).not.toHaveBeenCalled();
    expect(session.status).toEqual({ kind: "saved", at: 1 });
  });

  it("ignores read failures while checking", async () => {
    const { disk, session, events } = setup();
    disk.readOverrides = [{ kind: "error", message: "busy" }];
    await session.externalChange();
    expect(events.reloaded).not.toHaveBeenCalled();
    expect(session.status).toEqual({ kind: "saved", at: 1 });
  });

  it("stops a check after dispose", async () => {
    const { disk, session, events, path } = setup();
    disk.files.set(path, "theirs");
    const checked = session.externalChange();
    session.dispose();
    await checked;
    expect(events.reloaded).not.toHaveBeenCalled();
  });
});

describe("SaveSession removal", () => {
  it("reports a clean file deleted on disk", async () => {
    const { disk, session, events, path } = setup();
    disk.files.delete(path);
    await session.externalChange();
    expect(events.removed).toHaveBeenCalledTimes(1);
    await session.externalChange();
    expect(events.removed).toHaveBeenCalledTimes(1);
  });

  it("re-creates a deleted file that has unsaved edits", async () => {
    const { disk, session, type, events, path } = setup();
    type("mine");
    disk.files.delete(path);
    await session.externalChange();
    expect(events.removed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await session.settled();
    expect(disk.writes).toEqual([{ path, contents: "mine", expected: null }]);
    expect(disk.files.get(path)).toBe("mine");
  });

  it("schedules the re-creating save if none is pending", async () => {
    const { disk, session, type, path } = setup();
    disk.holding = true;
    type("mine");
    const flushed = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    disk.files.delete(path);
    disk.writeOverrides.push({ kind: "error", message: "busy" });
    const checked = session.externalChange();
    disk.release();
    await flushed;
    await checked;
    // The failed save left a retry timer; the deletion keeps it.
    expect(session.status.kind).toBe("failed");
    await vi.advanceTimersByTimeAsync(2_000);
    await session.settled();
    expect(disk.files.get(path)).toBe("mine");
    expect(disk.writes.at(-1)?.expected).toBeNull();
  });

  it("saves into a deleted file on flush and when it reappears keeps both", async () => {
    const { disk, session, type, events, path } = setup("base", "a.md");
    type("mine");
    disk.files.delete(path);
    await session.externalChange();
    disk.files.set(path, "recreated elsewhere");
    await session.externalChange();
    expect(events.conflict).toHaveBeenCalledWith("a (conflict 2026-10-08 1432).md");
    expect(disk.files.get(path)).toBe("mine");
  });

  it("re-creates the file within the conflict flow when it disappears", async () => {
    const { disk, session, type, path } = setup("base", "a.md");
    disk.writeOverrides.push({ kind: "conflict" });
    disk.files.delete(path);
    type("mine");
    await session.flush();
    expect(disk.writes.at(-1)).toEqual({ path, contents: "mine", expected: null });
    expect(disk.files.get(path)).toBe("mine");
  });

  it("flushes a removed dirty buffer even without new edits", async () => {
    const { disk, session, type, path } = setup();
    type("mine");
    disk.files.delete(path);
    await session.externalChange();
    expect(session.dirty).toBe(true);
    await session.flush();
    expect(disk.files.get(path)).toBe("mine");
  });
});
