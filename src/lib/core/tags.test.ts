import { describe, expect, it } from "vitest";
import { findTags, splitTags } from "./tags";

const names = (text: string) => findTags(text).map((tag) => tag.name);

describe("findTags", () => {
  it("finds tags at the start and after whitespace", () => {
    expect(names("#devops")).toEqual(["devops"]);
    expect(names("rotate DB credentials #security")).toEqual(["security"]);
    expect(names("a\t#b\n#c")).toEqual(["b", "c"]);
  });

  it("reports offsets of the whole tag", () => {
    expect(findTags("fix #bug-42 now")).toEqual([{ name: "bug-42", start: 4, end: 11 }]);
  });

  it("supports Unicode letters and digits", () => {
    expect(names("#café #日本語 #straße #v2")).toEqual(["café", "日本語", "straße", "v2"]);
  });

  it("accepts tags after punctuation", () => {
    expect(names('(#todo), [#later] "#quoted"')).toEqual(["todo", "later", "quoted"]);
  });

  it("stops at characters that cannot be part of a tag", () => {
    expect(names("#done. #next, #what?")).toEqual(["done", "next", "what"]);
  });

  it.each([
    ["issue#42", "glued to a word"],
    ["C#-interop", "glued to a word"],
    ["#42", "digits only"],
    ["##heading", "double hash"],
    ["https://example.com/#section", "URL fragment"],
    ["&#39;", "HTML entity"],
    ["# heading", "no name"],
    ["😀#tag", "glued to an emoji"],
  ])("ignores %j (%s)", (text) => {
    expect(findTags(text)).toEqual([]);
  });

  it("handles long inputs quickly", () => {
    const text = `${"#".repeat(50_000)} ${"a".repeat(50_000)}#x`;
    const start = Date.now();
    findTags(text);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe("splitTags", () => {
  it("splits text into plain and tag segments", () => {
    expect(splitTags("rotate #security keys")).toEqual([
      { kind: "text", text: "rotate " },
      { kind: "tag", text: "#security" },
      { kind: "text", text: " keys" },
    ]);
  });

  it("returns a single text segment when there are no tags", () => {
    expect(splitTags("issue#42")).toEqual([{ kind: "text", text: "issue#42" }]);
  });

  it("returns no segments for empty text", () => {
    expect(splitTags("")).toEqual([]);
  });

  it("joins back to the original text", () => {
    const text = "#a b (#c) d#e #f";
    expect(
      splitTags(text)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(text);
  });
});
