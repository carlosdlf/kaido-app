import { describe, expect, it } from "vitest";
import {
  checkFolderMove,
  checkFolderPath,
  checkMovePaths,
  checkNotePath,
  checkRenamePaths,
  checkStoragePath,
} from "./paths";

describe("checkStoragePath", () => {
  it.each(["a.md", "inbox/a.MD", "a/b/c.md", ".kaido/config.json", "año/日本.md", "a:b.md"])(
    "accepts %j",
    (path) => {
      expect(() => checkStoragePath(path)).not.toThrow();
    },
  );

  it.each([
    "",
    "a\0.md",
    "a\\b.md",
    "a//b.md",
    "./a.md",
    "a/",
    "/etc/passwd.md",
    "C:/x.md",
    "../x.md",
    "a/../../x.md",
    "notes.txt",
    ".kaido/other.json",
    ".git/x.md",
    "a/.hidden.md",
    "node_modules/x.md",
  ])("rejects %j as InvalidPath", (path) => {
    expect(() => checkStoragePath(path)).toThrow(expect.objectContaining({ kind: "InvalidPath" }));
  });
});

describe("checkNotePath", () => {
  it("accepts notes and rejects the workspace configuration", () => {
    expect(() => checkNotePath("inbox/a.md")).not.toThrow();
    expect(() => checkNotePath(".kaido/config.json")).toThrow(
      expect.objectContaining({ kind: "InvalidPath" }),
    );
    expect(() => checkNotePath("../a.md")).toThrow(
      expect.objectContaining({ kind: "InvalidPath" }),
    );
  });
});

describe("checkRenamePaths", () => {
  it.each([
    ["inbox/a.md", "inbox/b.md"],
    ["a.md", "b.md"],
    ["p/sub/a.md", "p/sub/A.md"],
  ])("accepts %j to %j", (from, to) => {
    expect(() => checkRenamePaths(from, to)).not.toThrow();
  });

  it.each([
    ["inbox/a.md", "api/a.md"],
    ["a.md", "inbox/a.md"],
    ["p/sub/a.md", "p/a.md"],
    ["inbox/a.md", "inbox/a.txt"],
    [".kaido/config.json", ".kaido/b.md"],
    ["inbox/a.md", "inbox/.b.md"],
  ])("rejects %j to %j as InvalidPath", (from, to) => {
    expect(() => checkRenamePaths(from, to)).toThrow(
      expect.objectContaining({ kind: "InvalidPath" }),
    );
  });
});

describe("checkMovePaths", () => {
  it.each([
    ["inbox/a.md", "api/a.md"],
    ["a.md", "inbox/sub/a.md"],
    ["p/tasks.md", "q/tasks.md"],
  ])("accepts %j to %j", (from, to) => {
    expect(() => checkMovePaths(from, to)).not.toThrow();
  });

  it.each([
    ["inbox/a.md", "api/a.txt"],
    [".kaido/config.json", "api/c.md"],
    ["inbox/a.md", ".git/a.md"],
    ["inbox/a.md", "../a.md"],
  ])("rejects %j to %j as InvalidPath", (from, to) => {
    expect(() => checkMovePaths(from, to)).toThrow(
      expect.objectContaining({ kind: "InvalidPath" }),
    );
  });
});

describe("checkFolderPath and checkFolderMove", () => {
  it.each([["api"], ["_archive/api"], ["a b"]])("accepts %j", (path) => {
    expect(() => checkFolderPath(path)).not.toThrow();
  });

  it.each([
    [""],
    ["inbox"],
    ["_archive"],
    [".kaido"],
    [".git"],
    ["a/.hidden"],
    ["node_modules"],
    ["/abs"],
    ["C:/abs"],
    ["a/../b"],
    ["a//b"],
    ["a\\b"],
    ["a\0b"],
    ["Inbox"],
    ["a/sub"],
    ["_archive/a/sub"],
    ["_archive/"],
    ["_archive/_archive"],
  ])("rejects %j as InvalidPath", (path) => {
    expect(() => checkFolderPath(path)).toThrow(expect.objectContaining({ kind: "InvalidPath" }));
  });

  it.each([
    ["a", "b"],
    ["a", "_archive/a"],
    ["_archive/a", "a"],
    ["a", "A"],
  ])("accepts moving %j to %j", (from, to) => {
    expect(() => checkFolderMove(from, to)).not.toThrow();
  });

  it.each([
    ["a", "a/b"],
    ["a", "_archive"],
    ["a", ".kaido"],
    ["inbox", "b"],
    ["a", "INBOX"],
    ["a", ""],
  ])("rejects moving %j to %j", (from, to) => {
    expect(() => checkFolderMove(from, to)).toThrow(
      expect.objectContaining({ kind: "InvalidPath" }),
    );
  });

  it("refuses moving a folder onto itself as a conflict", () => {
    expect(() => checkFolderMove("a", "a")).toThrow(expect.objectContaining({ kind: "Conflict" }));
  });
});
