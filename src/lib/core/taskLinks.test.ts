import { describe, expect, it } from "vitest";
import {
  encodeLinkTarget,
  linkedNote,
  noteLink,
  noteNameFromTask,
  resolveLinkTarget,
  taskLinks,
  textWithoutLinks,
  withoutLink,
} from "./taskLinks";

describe("resolveLinkTarget", () => {
  it("resolves relative Markdown paths against the task list's folder", () => {
    expect(resolveLinkTarget("plan.md", "api/tasks.md")).toBe("api/plan.md");
    expect(resolveLinkTarget("./docs/My%20Plan.md#top", "api/tasks.md")).toBe(
      "api/docs/My Plan.md",
    );
    expect(resolveLinkTarget("../web/x.MD?raw", "api/tasks.md")).toBe("web/x.MD");
    expect(resolveLinkTarget("a//b.md", "tasks.md")).toBe("a/b.md");
  });

  it("ignores URLs, absolute paths, anchors, other files and paths outside the workspace", () => {
    for (const target of [
      "https://example.com/a.md",
      "mailto:a@b.md",
      "/abs.md",
      "#heading",
      "image.png",
      "../../out.md",
      "bad%E0%A4%A.md",
    ]) {
      expect(resolveLinkTarget(target, "api/tasks.md")).toBeNull();
    }
  });
});

describe("taskLinks and linkedNote", () => {
  const exists = (path: string) => path === "p/b.md";

  it("finds links to notes in order with their positions", () => {
    const text = "do [a](a.md) and [b](b.md) see [site](https://x.dev)";
    expect(taskLinks(text, "p/tasks.md")).toEqual([
      { start: 3, end: 12, label: "a", path: "p/a.md" },
      { start: 17, end: 26, label: "b", path: "p/b.md" },
    ]);
  });

  it("prefers the first existing note, else the first link as missing", () => {
    expect(linkedNote("[a](a.md) [b](b.md)", "p/tasks.md", exists)).toMatchObject({
      path: "p/b.md",
      exists: true,
    });
    expect(linkedNote("[a](a.md)", "p/tasks.md", exists)).toMatchObject({
      path: "p/a.md",
      exists: false,
    });
    expect(linkedNote("no links", "p/tasks.md", exists)).toBeNull();
  });

  it("removes a link for display", () => {
    const text = "write  [note](plan.md)  today";
    const link = taskLinks(text, "p/tasks.md")[0];
    expect(link && withoutLink(text, link)).toBe("write today");
    expect(textWithoutLinks("a [x](y.md) b [z](https://q)")).toBe("a b");
  });
});

describe("noteNameFromTask", () => {
  it("uses the task text without links, made valid for every OS", () => {
    expect(noteNameFromTask("Plan the Q3 launch [note](old.md)")).toBe("Plan the Q3 launch");
    expect(noteNameFromTask('fix a/b: "why?" <now>*')).toBe("fix a b why now");
    expect(noteNameFromTask("..hidden. ")).toBe("hidden");
    expect(noteNameFromTask("tab\there\u0007")).toBe("tab here");
  });

  it("falls back to untitled for empty, reserved and device names", () => {
    for (const text of ["", "  ", "[x](y.md)", "///", "CON", "tasks", "..."]) {
      expect(noteNameFromTask(text)).toBe("untitled");
    }
  });

  it("truncates to fit 200 bytes with .md, on a code point boundary", () => {
    const name = noteNameFromTask("é".repeat(150));
    expect(name).toBe("é".repeat(98));
    expect(noteNameFromTask(`${"a".repeat(196)} b`)).toBe("a".repeat(196));
  });
});

describe("link edge cases", () => {
  it("round-trips names with #, %, parentheses, brackets and non-ASCII characters", () => {
    for (const name of ["C# notes.md", "100% (done) [v2].md", "Ñandú <x> 🐕.md", "a#b%23.md"]) {
      const link = noteLink(name);
      expect(taskLinks(`task ${link}`, "p/tasks.md").map((found) => found.path)).toEqual([
        `p/${name}`,
      ]);
    }
    expect(encodeLinkTarget("C# notes.md")).toBe("C%23%20notes.md");
  });

  it("ignores links in inline code and links to task lists", () => {
    expect(taskLinks("`[x](y.md)` and ``a ` [z](z.md)``", "p/tasks.md")).toEqual([]);
    expect(taskLinks("`open code [x](y.md)", "p/tasks.md").map((link) => link.path)).toEqual([
      "p/y.md",
    ]);
    expect(taskLinks("[list](tasks.md) [other](../q/tasks.md)", "p/tasks.md")).toEqual([]);
    expect(taskLinks("[sub](sub/tasks.md)", "p/tasks.md").map((link) => link.path)).toEqual([
      "p/sub/tasks.md",
    ]);
  });

  it("drops a trailing .md from task text used as a name", () => {
    expect(noteNameFromTask("read plan.MD")).toBe("read plan");
  });
});

describe("links written by the app", () => {
  it("encodes characters that would break the link", () => {
    expect(encodeLinkTarget("My (draft) 100% [v2] <x>.md")).toBe(
      "My%20%28draft%29%20100%25%20%5Bv2%5D%20%3Cx%3E.md",
    );
    expect(noteLink("Plan B.md")).toBe("[note](Plan%20B.md)");
    expect(resolveLinkTarget(encodeLinkTarget("My (draft) 100%.md"), "p/tasks.md")).toBe(
      "p/My (draft) 100%.md",
    );
  });
});
