import { describe, expect, it } from "vitest";
import { createIgnoreMatcher } from "./glob";

function ignored(patterns: string[], path: string): boolean {
  return createIgnoreMatcher(patterns)(path);
}

describe("createIgnoreMatcher", () => {
  it("ignores nothing without patterns", () => {
    expect(ignored([], "a/b.md")).toBe(false);
  });

  it("matches a bare name at any depth, as a file or a folder", () => {
    expect(ignored(["drafts"], "drafts/a.md")).toBe(true);
    expect(ignored(["drafts"], "work/drafts/a.md")).toBe(true);
    expect(ignored(["drafts"], "work/drafts")).toBe(true);
    expect(ignored(["drafts"], "work/drafts-old/a.md")).toBe(false);
  });

  it("supports * and ? within a name", () => {
    expect(ignored(["*.draft.md"], "work/plan.draft.md")).toBe(true);
    expect(ignored(["*.draft.md"], "work/plan.md")).toBe(false);
    expect(ignored(["v?.md"], "a/v1.md")).toBe(true);
    expect(ignored(["v?.md"], "a/v10.md")).toBe(false);
  });

  it("never lets * or ? cross a folder boundary", () => {
    expect(ignored(["work/*.md"], "work/a/b.md")).toBe(false);
    expect(ignored(["work?a.md"], "work/a.md")).toBe(false);
  });

  it("anchors patterns that contain a slash at the root", () => {
    expect(ignored(["work/old"], "work/old/a.md")).toBe(true);
    expect(ignored(["work/old"], "x/work/old/a.md")).toBe(false);
    expect(ignored(["/scratch"], "scratch/a.md")).toBe(true);
    expect(ignored(["/scratch"], "work/scratch/a.md")).toBe(false);
    expect(ignored(["work/*.md"], "work/a.md")).toBe(true);
  });

  it("matches folders only with a trailing slash", () => {
    expect(ignored(["tmp/"], "tmp/a.md")).toBe(true);
    expect(ignored(["tmp/"], "a/tmp/b.md")).toBe(true);
    expect(ignored(["tmp.md/"], "tmp.md")).toBe(false);
    expect(ignored(["work/tmp/"], "work/tmp/a.md")).toBe(true);
    expect(ignored(["work/tmp/"], "work/tmp")).toBe(false);
  });

  it("supports ** as leading, middle and trailing segments", () => {
    expect(ignored(["**/drafts"], "drafts/a.md")).toBe(true);
    expect(ignored(["**/drafts"], "a/b/drafts/c.md")).toBe(true);
    expect(ignored(["notes/**"], "notes/a/b.md")).toBe(true);
    expect(ignored(["notes/**"], "other/notes/a.md")).toBe(false);
    expect(ignored(["a/**/z.md"], "a/z.md")).toBe(true);
    expect(ignored(["a/**/z.md"], "a/b/c/z.md")).toBe(true);
    expect(ignored(["a/**/z.md"], "b/z.md")).toBe(false);
  });

  it("treats ** inside a name like a wildcard that crosses folders", () => {
    expect(ignored(["a/x**.md"], "a/x/y.md")).toBe(true);
    expect(ignored(["a/***.md"], "a/b/c.md")).toBe(true);
  });

  it("escapes regular expression characters", () => {
    expect(ignored(["a+b (1).md"], "a+b (1).md")).toBe(true);
    expect(ignored(["a.md"], "abmd")).toBe(false);
    expect(ignored(["[x].md"], "[x].md")).toBe(true);
    expect(ignored(["[x].md"], "x.md")).toBe(false);
    expect(ignored(["$^{}|\\.md"], "$^{}|\\.md")).toBe(true);
  });

  it("skips blank, comment, negated and root-only patterns", () => {
    const match = createIgnoreMatcher(["", "  ", "# notes", "!keep.md", "/", "//"]);
    expect(match("notes/a.md")).toBe(false);
    expect(match("keep.md")).toBe(false);
    expect(match("# notes")).toBe(false);
  });

  it("trims surrounding whitespace in patterns", () => {
    expect(ignored(["  drafts  "], "drafts/a.md")).toBe(true);
  });

  it("matches Unicode names", () => {
    expect(ignored(["borradores/*"], "borradores/año.md")).toBe(true);
    expect(ignored(["?.md"], "日.md")).toBe(true);
  });

  it("combines several patterns", () => {
    const match = createIgnoreMatcher(["drafts", "*.tmp.md"]);
    expect(match("drafts/a.md")).toBe(true);
    expect(match("b.tmp.md")).toBe(true);
    expect(match("c.md")).toBe(false);
  });
});
