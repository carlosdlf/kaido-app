import { describe, expect, it } from "vitest";
import {
  ChangeHints,
  commitMessage,
  listingLookup,
  MAX_BODY_PATHS,
  MAX_SUBJECT_LENGTH,
  type FileChange,
} from "./commitMessage";

const mod = (path: string): FileChange => ({ kind: "modified", path });
const add = (path: string): FileChange => ({ kind: "added", path });
const del = (path: string): FileChange => ({ kind: "deleted", path });
const ren = (from: string, path: string): FileChange => ({ kind: "renamed", from, path });

function subject(changes: FileChange[]): string | undefined {
  return commitMessage(changes)?.split("\n")[0];
}

describe("commitMessage subjects", () => {
  it.each<[string, FileChange[], string]>([
    ["one edited note", [mod("api-payments/deploy.md")], "Update api-payments/deploy.md"],
    ["one added note", [add("inbox/idea.md")], "Add inbox/idea.md"],
    ["one deleted note", [del("inbox/old.md")], "Delete inbox/old.md"],
    ["a rename in a folder", [ren("inbox/a.md", "inbox/b.md")], "Rename inbox/a.md to b.md"],
    ["a rename across folders", [ren("a/x.md", "b/x.md")], "Rename a/x.md to b/x.md"],
    ["a loose file", [mod("README.md")], "Update README.md"],
    ["the workspace config", [mod(".kaido/config.json")], "Update .kaido/config.json"],
    ["one task list", [mod("inbox/tasks.md")], "Update tasks in inbox"],
    ["a new task list", [add("api/tasks.md")], "Update tasks in api"],
    [
      "two task lists",
      [mod("inbox/tasks.md"), mod("api-payments/tasks.md")],
      "Update tasks in api-payments and inbox",
    ],
    [
      "three task lists",
      [mod("inbox/tasks.md"), mod("a/tasks.md"), mod("b/tasks.md")],
      "Update tasks in 3 projects",
    ],
    ["a deleted task list", [del("old/tasks.md")], "Delete old/tasks.md"],
    [
      "notes in one project",
      [mod("api/a.md"), mod("api/b.md"), add("api/sub/c.md"), mod("api/d.md"), mod("api/e.md")],
      "Update 5 notes in api",
    ],
    ["added notes", [add("inbox/a.md"), add("inbox/b.md")], "Add 2 notes in inbox"],
    ["deleted notes", [del("inbox/a.md"), del("inbox/b.md")], "Delete 2 notes in inbox"],
    ["notes and a task list", [mod("api/tasks.md"), mod("api/a.md")], "Update 2 files in api"],
    [
      "files in several projects",
      [mod("a/x.md"), mod("b/y.md"), mod("c/tasks.md"), mod("c/z.md")],
      "Update 4 files in 3 projects",
    ],
    ["notes in several projects", [mod("a/x.md"), mod("b/y.md")], "Update 2 notes in 2 projects"],
    ["loose files at the root", [mod("a.md"), mod("b.md")], "Update 2 notes"],
    ["renames among others", [ren("a/x.md", "a/y.md"), mod("a/z.md")], "Update 2 notes in a"],
    ["non-note files", [mod("a/x.md"), mod("a/image.png")], "Update 2 files in a"],
  ])("%s", (_name, changes, expected) => {
    expect(subject(changes)).toBe(expected);
  });

  it("returns null without changes", () => {
    expect(commitMessage([])).toBeNull();
  });

  it("is the same whatever the order of the changes", () => {
    const changes = [mod("b/tasks.md"), mod("a/tasks.md")];
    expect(commitMessage(changes)).toBe(commitMessage([...changes].reverse()));
  });

  describe("long names", () => {
    const long = "x".repeat(80);

    it("uses the file name when the path is too long", () => {
      expect(subject([mod(`${long}/note.md`)])).toBe("Update note.md");
      expect(subject([ren(`${long}/a.md`, `${long}/b.md`)])).toBe("Rename a.md to b.md");
    });

    it("cuts names that are too long on their own", () => {
      const result = subject([mod(`p/${long}.md`)]);
      expect(Array.from(result ?? "")).toHaveLength(MAX_SUBJECT_LENGTH);
      expect(result?.endsWith("…")).toBe(true);
      const renamed = subject([ren(`p/${long}.md`, `p/${long}2.md`)]);
      expect(Array.from(renamed ?? "")).toHaveLength(MAX_SUBJECT_LENGTH);
    });

    it("counts projects whose names do not fit", () => {
      const a = "a".repeat(40);
      const b = "b".repeat(40);
      expect(subject([mod(`${long}/tasks.md`)])).toBe("Update tasks in 1 project");
      expect(subject([mod(`${a}/tasks.md`), mod(`${b}/tasks.md`)])).toBe(
        "Update tasks in 2 projects",
      );
      expect(subject([mod(`${long}/a.md`), mod(`${long}/b.md`)])).toBe("Update 2 notes");
    });

    it("never splits a character", () => {
      const result = subject([mod(`p/${"é".repeat(90)}.md`)]) ?? "";
      expect(Array.from(result)).toHaveLength(MAX_SUBJECT_LENGTH);
      expect(result).not.toMatch(/�/);
    });
  });
});

describe("commitMessage bodies", () => {
  it("has no body for a single change", () => {
    expect(commitMessage([mod("inbox/a.md")])).toBe("Update inbox/a.md");
  });

  it("lists the paths, renames with their old path", () => {
    expect(commitMessage([mod("inbox/b.md"), ren("inbox/x.md", "inbox/a.md")])).toBe(
      "Update 2 notes in inbox\n\ninbox/x.md -> inbox/a.md\ninbox/b.md",
    );
  });

  it("lists at most 20 paths", () => {
    const changes = Array.from({ length: 25 }, (_, index) =>
      mod(`inbox/${String(index).padStart(2, "0")}.md`),
    );
    const lines = commitMessage(changes)?.split("\n") ?? [];
    expect(lines[0]).toBe("Update 25 notes in inbox");
    expect(lines.slice(2)).toHaveLength(MAX_BODY_PATHS + 1);
    expect(lines.at(-1)).toBe("…and 5 more");
  });
});

describe("ChangeHints", () => {
  const onDisk = (paths: string[]) => (path: string) => paths.includes(path);

  it("treats unknown changes as edits, and missing files as deletions", () => {
    const hints = new ChangeHints();
    expect(hints.describe(["a/x.md", "a/gone.md"], onDisk(["a/x.md"]))).toEqual([
      mod("a/x.md"),
      del("a/gone.md"),
    ]);
  });

  it("keeps edits of files it cannot check", () => {
    const hints = new ChangeHints();
    expect(hints.describe(["a/image.png"], () => undefined)).toEqual([mod("a/image.png")]);
  });

  it("reports created files as added", () => {
    const hints = new ChangeHints();
    hints.created("a/new.md");
    expect(hints.describe(["a/new.md"], onDisk(["a/new.md"]))).toEqual([add("a/new.md")]);
  });

  it("reports deleted files even when existence is unknown", () => {
    const hints = new ChangeHints();
    hints.deleted("a/x.md");
    expect(hints.describe(["a/x.md"], () => undefined)).toEqual([del("a/x.md")]);
  });

  it("treats a file deleted and created again as edited", () => {
    const hints = new ChangeHints();
    hints.deleted("a/x.md");
    hints.created("a/x.md");
    expect(hints.describe(["a/x.md"], onDisk(["a/x.md"]))).toEqual([mod("a/x.md")]);
  });

  it("forgets files created and deleted before a commit", () => {
    const hints = new ChangeHints();
    hints.created("a/x.md");
    hints.deleted("a/x.md");
    hints.created("a/x.md");
    expect(hints.describe(["a/x.md"], onDisk(["a/x.md"]))).toEqual([add("a/x.md")]);
  });

  it("joins a rename into one change", () => {
    const hints = new ChangeHints();
    hints.renamed("a/x.md", "a/y.md");
    expect(hints.describe(["a/x.md", "a/y.md"], onDisk(["a/y.md"]))).toEqual([
      ren("a/x.md", "a/y.md"),
    ]);
  });

  it("follows renames in a row to the first path", () => {
    const hints = new ChangeHints();
    hints.renamed("a/x.md", "a/y.md");
    hints.renamed("a/y.md", "a/z.md");
    expect(hints.describe(["a/x.md", "a/z.md"], onDisk(["a/z.md"]))).toEqual([
      ren("a/x.md", "a/z.md"),
    ]);
  });

  it("drops a rename back to the first name", () => {
    const hints = new ChangeHints();
    hints.renamed("a/x.md", "a/y.md");
    hints.renamed("a/y.md", "a/x.md");
    expect(hints.describe(["a/x.md"], onDisk(["a/x.md"]))).toEqual([mod("a/x.md")]);
  });

  it("reports a renamed new file as added", () => {
    const hints = new ChangeHints();
    hints.created("a/x.md");
    hints.renamed("a/x.md", "a/y.md");
    expect(hints.describe(["a/y.md"], onDisk(["a/y.md"]))).toEqual([add("a/y.md")]);
  });

  it("reports a rename whose old path git does not list as added", () => {
    const hints = new ChangeHints();
    hints.renamed("a/x.md", "a/y.md");
    expect(hints.describe(["a/y.md"], onDisk(["a/y.md"]))).toEqual([add("a/y.md")]);
  });

  it("turns a renamed then deleted file into a deletion of its first path", () => {
    const hints = new ChangeHints();
    hints.renamed("a/x.md", "a/y.md");
    hints.deleted("a/y.md");
    expect(hints.describe(["a/x.md"], () => undefined)).toEqual([del("a/x.md")]);
  });

  it("forgets committed paths", () => {
    const hints = new ChangeHints();
    hints.created("a/x.md");
    hints.created("a/y.md");
    hints.committed(["a/x.md"]);
    expect(hints.describe(["a/x.md", "a/y.md"], onDisk(["a/x.md", "a/y.md"]))).toEqual([
      mod("a/x.md"),
      add("a/y.md"),
    ]);
    hints.clear();
    expect(hints.describe(["a/y.md"], onDisk(["a/y.md"]))).toEqual([mod("a/y.md")]);
  });
});

describe("listingLookup", () => {
  it("answers for listable paths only", () => {
    const onDisk = listingLookup(["a/x.md"]);
    expect(onDisk("a/x.md")).toBe(true);
    expect(onDisk("a/y.md")).toBe(false);
    expect(onDisk("a/image.png")).toBeUndefined();
    expect(onDisk(".kaido/config.json")).toBeUndefined();
  });
});

describe("large change sets", () => {
  const COUNT = 10_000;
  const paths = Array.from({ length: COUNT }, (_, index) => `p${index % 50}/note-${index}.md`);

  it("describes duplicates once", () => {
    const hints = new ChangeHints();
    expect(hints.describe(["a/x.md", "a/x.md"], () => true)).toEqual([mod("a/x.md")]);
  });

  it("handles 10k changed paths in linear time", () => {
    const hints = new ChangeHints();
    const oldPaths: string[] = [];
    // Every other file was renamed by the app, so both passes do real work.
    for (let index = 0; index < COUNT; index += 2) {
      const old = `old/${index}.md`;
      oldPaths.push(old);
      hints.renamed(old, paths[index] ?? "");
    }
    const onDisk = listingLookup(paths);
    const started = Date.now();
    const changes = hints.describe([...paths, ...oldPaths], onDisk);
    const message = commitMessage(changes);
    const elapsed = Date.now() - started;
    expect(changes).toHaveLength(COUNT);
    expect(changes.filter((change) => change.kind === "renamed")).toHaveLength(COUNT / 2);
    expect(message?.split("\n")[0]).toBe("Update 10000 notes in 50 projects");
    // A quadratic pass over 15k paths takes seconds; linear work takes a few ms.
    expect(elapsed).toBeLessThan(200);
  });
});
