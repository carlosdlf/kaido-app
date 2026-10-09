import { describe, expect, it } from "vitest";
import { cloneFolderName, folderName, folderNameProblem, joinPath } from "./workspaceLocation";

describe("cloneFolderName", () => {
  it.each([
    ["https://github.com/me/notes.git", "notes"],
    ["https://github.com/me/notes", "notes"],
    ["https://github.com/me/notes/", "notes"],
    ["git@github.com:me/work-notes.git", "work-notes"],
    ["git@github.com:notes.git", "notes"],
    ["ssh://git@host:22/srv/My Notes.GIT", "My Notes"],
    ["/srv/git/notes.git", "notes"],
    ["C:\\repos\\notes.git", "notes"],
    ["https://host/me/notes.git?ref=x#y", "notes"],
    ["  https://github.com/me/notes.git  ", "notes"],
    ["https://github.com", ""],
    ["https://github.com/", ""],
    ["", ""],
    ["https://host/me/.git", ""],
    ["https://host/me/CON.git", ""],
  ])("%s → %s", (url, name) => {
    expect(cloneFolderName(url)).toBe(name);
  });
});

describe("folderNameProblem", () => {
  it("accepts portable names", () => {
    expect(folderNameProblem("notes")).toBeNull();
    expect(folderNameProblem("my notes 2")).toBeNull();
  });

  it.each(["", " notes", "notes ", "a/b", ".hidden", "nul", "notes.", 'a"b'])(
    "refuses %j",
    (name) => {
      expect(folderNameProblem(name)).not.toBeNull();
    },
  );
});

describe("joinPath", () => {
  it.each([
    ["/home/me", "notes", "/home/me/notes"],
    ["/home/me/", "notes", "/home/me/notes"],
    ["/", "notes", "/notes"],
    ["C:\\Users\\me", "notes", "C:\\Users\\me\\notes"],
    ["C:\\", "notes", "C:\\notes"],
    ["C:/Users/me", "notes", "C:/Users/me/notes"],
    ["\\\\server\\share", "notes", "\\\\server\\share\\notes"],
  ])("%s + %s", (parent, name, joined) => {
    expect(joinPath(parent, name)).toBe(joined);
  });
});

describe("folderName", () => {
  it("returns the last segment", () => {
    expect(folderName("/home/me/notes")).toBe("notes");
    expect(folderName("C:\\Users\\me\\notes\\")).toBe("notes");
    expect(folderName("/")).toBe("/");
  });
});
