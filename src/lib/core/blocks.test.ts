import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./blocks";

describe("parseBlocks", () => {
  it("returns nothing for empty text", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("\n\n  \n")).toEqual([]);
  });

  it("reads headings of every level", () => {
    expect(parseBlocks("# One\n## Two ##\n###### Six\n####### seven")).toEqual([
      { kind: "heading", level: 1, text: "One" },
      { kind: "heading", level: 2, text: "Two" },
      { kind: "heading", level: 6, text: "Six" },
      { kind: "paragraph", text: "####### seven" },
    ]);
  });

  it("treats a hash without a space as text", () => {
    expect(parseBlocks("#devops #snippet")).toEqual([
      { kind: "paragraph", text: "#devops #snippet" },
    ]);
    expect(parseBlocks("#")).toEqual([{ kind: "heading", level: 1, text: "" }]);
  });

  it("joins paragraph lines and splits on blank lines", () => {
    expect(parseBlocks("a\r\n b \n\nc")).toEqual([
      { kind: "paragraph", text: "a b" },
      { kind: "paragraph", text: "c" },
    ]);
  });

  it("reads fenced code with its language, verbatim", () => {
    expect(parseBlocks("text\n```sh\n# not a heading\n  - [ ] not a task\n```\nafter")).toEqual([
      { kind: "paragraph", text: "text" },
      { kind: "code", language: "sh", text: "# not a heading\n  - [ ] not a task" },
      { kind: "paragraph", text: "after" },
    ]);
  });

  it("closes a fence only with the same marker, at least as long, without info", () => {
    expect(parseBlocks("````\n```\n~~~~\n```` js\n````")).toEqual([
      { kind: "code", language: "", text: "```\n~~~~\n```` js" },
    ]);
  });

  it("keeps an unclosed fence open until the end", () => {
    expect(parseBlocks("~~~\ncode")).toEqual([{ kind: "code", language: "", text: "code" }]);
  });

  it("groups consecutive task lines", () => {
    const blocks = parseBlocks("intro\n- [x] a\n- [ ] b #tag\n\n- [ ] c");
    expect(blocks.map((block) => block.kind)).toEqual(["paragraph", "tasks", "tasks"]);
    expect(blocks[1]).toEqual({
      kind: "tasks",
      tasks: [
        { done: true, text: "a", stateOffset: 3 },
        { done: false, text: "b #tag", stateOffset: 3 },
      ],
    });
  });

  it("groups bullet lists and stops at tasks", () => {
    expect(parseBlocks("- one\n* two\n- [ ] task\n+ three")).toEqual([
      { kind: "list", items: ["one", "two"] },
      { kind: "tasks", tasks: [{ done: false, text: "task", stateOffset: 3 }] },
      { kind: "list", items: ["three"] },
    ]);
  });

  it("ends a paragraph at a heading, list or fence", () => {
    expect(parseBlocks("a\n# H\nb\n- c\nd\n```\ne\n```").map((block) => block.kind)).toEqual([
      "paragraph",
      "heading",
      "paragraph",
      "list",
      "paragraph",
      "code",
    ]);
  });

  it("skips front matter", () => {
    expect(parseBlocks("---\ntitle: x\n---\n# Title")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
    ]);
  });

  it("parses large notes quickly", () => {
    const text = Array.from({ length: 20_000 }, (_, i) => `line ${i} #tag \`code\``).join("\n");
    const start = Date.now();
    parseBlocks(text);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe("parseInline", () => {
  it("splits code spans and tags", () => {
    expect(parseInline("run `pnpm build` for #release")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "pnpm build" },
      { kind: "text", text: " for " },
      { kind: "tag", text: "#release" },
    ]);
  });

  it("does not look for tags inside code", () => {
    expect(parseInline("`#not-a-tag`")).toEqual([{ kind: "code", text: "#not-a-tag" }]);
  });

  it("keeps unmatched backticks and drops empty spans", () => {
    expect(parseInline("a ` b")).toEqual([{ kind: "text", text: "a ` b" }]);
    expect(parseInline("a``b")).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
    ]);
    expect(parseInline("")).toEqual([]);
  });
});
