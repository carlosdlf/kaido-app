import { describe, expect, it } from "vitest";
import {
  applyMove,
  folderOf,
  isInside,
  movedPath,
  relativePath,
  reverseMoves,
  type PathMove,
} from "./pathMoves";

const folder = (from: string, to: string): PathMove => ({ from, to, folder: true });
const file = (from: string, to: string): PathMove => ({ from, to, folder: false });

describe("path moves", () => {
  it("tells whether a path is inside a folder", () => {
    expect(isInside("a/x.md", "a")).toBe(true);
    expect(isInside("ab/x.md", "a")).toBe(false);
    expect(isInside("a", "a")).toBe(false);
  });

  it("applies file and folder moves", () => {
    expect(applyMove("a/x.md", file("a/x.md", "b/x.md"))).toBe("b/x.md");
    expect(applyMove("a/y.md", file("a/x.md", "b/x.md"))).toBeNull();
    expect(applyMove("a/s/x.md", folder("a", "_archive/a"))).toBe("_archive/a/s/x.md");
    expect(applyMove("ab/x.md", folder("a", "b"))).toBeNull();
  });

  it("applies moves in order and reverses them", () => {
    const moves = [folder("a", "b"), file("b/x.md", "c/x.md")];
    expect(movedPath("a/x.md", moves)).toBe("c/x.md");
    expect(movedPath("a/y.md", moves)).toBe("b/y.md");
    expect(movedPath("z.md", moves)).toBe("z.md");
    expect(movedPath(movedPath("a/x.md", moves), reverseMoves(moves))).toBe("a/x.md");
  });

  it("finds folders and relative paths", () => {
    expect(folderOf("a/b/x.md")).toBe("a/b");
    expect(folderOf("x.md")).toBe("");
    expect(relativePath("a", "a/x.md")).toBe("x.md");
    expect(relativePath("a", "b/x.md")).toBe("../b/x.md");
    expect(relativePath("_archive/a", "a/x.md")).toBe("../../a/x.md");
    expect(relativePath("a", "a/s/x.md")).toBe("s/x.md");
    expect(relativePath("", "a/x.md")).toBe("a/x.md");
    expect(relativePath("a/s", "x.md")).toBe("../../x.md");
    // A file named like the folder is not the folder.
    expect(relativePath("a/x.md", "a/x.md")).toBe("../x.md");
  });
});
