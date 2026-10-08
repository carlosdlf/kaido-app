import { describe, expect, it } from "vitest";
import { countOpenTasks, fileStem, noteTitle, TITLE_SCAN_LIMIT } from "./markdown";

describe("noteTitle", () => {
  it("uses the first level-one heading", () => {
    expect(noteTitle("a/deploy.md", "# Deploy\n\n# Second")).toBe("Deploy");
  });

  it("skips text and deeper headings before it", () => {
    expect(noteTitle("a.md", "intro\n## Section\n# Real title\n")).toBe("Real title");
  });

  it("accepts up to three spaces of indentation, tabs and CRLF", () => {
    expect(noteTitle("a.md", "   #\tIndented  \r\nbody")).toBe("Indented");
    expect(noteTitle("a.md", "    # Code block\n")).toBe("a");
  });

  it("removes a closing sequence of hashes", () => {
    expect(noteTitle("a.md", "# Title ##")).toBe("Title");
    expect(noteTitle("a.md", "# C# tips")).toBe("C# tips");
    expect(noteTitle("a.md", "# Issue#")).toBe("Issue#");
  });

  it("ignores headings that are empty", () => {
    expect(noteTitle("a.md", "# \n# ##\n# Kept")).toBe("Kept");
  });

  it("requires a space after the hash", () => {
    expect(noteTitle("notes/x.md", "#tag\n##also")).toBe("x");
  });

  it("falls back to the file name without the extension", () => {
    expect(noteTitle("api/auth-flow.md", "")).toBe("auth-flow");
    expect(noteTitle("README.MD", "no heading")).toBe("README");
  });

  it("skips headings inside fenced code", () => {
    const text = "```sh\n# install deps\n```\n~~~\n# also code\n~~~\n# Title";
    expect(noteTitle("a.md", text)).toBe("Title");
  });

  it("only closes a fence with the same marker of at least the same length", () => {
    const text = "````\n```\n# inside\n~~~~\n````\n# After";
    expect(noteTitle("a.md", text)).toBe("After");
  });

  it("treats an unclosed fence as code until the end", () => {
    expect(noteTitle("a.md", "```\n# inside")).toBe("a");
  });

  it("skips front matter", () => {
    expect(noteTitle("a.md", "---\ntitle: x\n# not a heading\n---\n# Real")).toBe("Real");
    expect(noteTitle("a.md", "---\ntags: []\n...\n# Dots")).toBe("Dots");
  });

  it("treats an unclosed leading rule as normal text", () => {
    expect(noteTitle("a.md", "---\n# Title")).toBe("Title");
  });

  it("handles long lines in linear time", () => {
    const line = `# a${" ".repeat(100_000)}b${"#".repeat(100_000)}`;
    const start = Date.now();
    noteTitle("a.md", line);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe("countOpenTasks", () => {
  it("counts unchecked tasks only", () => {
    expect(countOpenTasks("- [ ] a\n- [x] b\n* [ ] c\n+ [X] d\ntext")).toBe(2);
  });

  it("handles CRLF line endings and empty text", () => {
    expect(countOpenTasks("- [ ] a\r\n- [ ] b\r\n")).toBe(2);
    expect(countOpenTasks("")).toBe(0);
  });

  it("ignores tasks in code blocks and front matter", () => {
    expect(countOpenTasks("---\n- [ ] meta\n---\n```\n- [ ] code\n```\n- [ ] real")).toBe(1);
  });
});

describe("noteTitle limits", () => {
  it("only scans the head of long notes", () => {
    const filler = "text\n".repeat(TITLE_SCAN_LIMIT / 5 + 10);
    expect(noteTitle("long.md", `${filler}# Late title`)).toBe("long");
    expect(noteTitle("short.md", `intro\n# Early\n${filler}`)).toBe("Early");
  });

  it("gives up on front matter that runs past the head", () => {
    const meta = `---\n${"key: value\n".repeat(TITLE_SCAN_LIMIT / 10)}# comment\n---\n# Title`;
    expect(noteTitle("meta.md", meta)).toBe("meta");
  });

  it("scans a 1 MB note quickly", () => {
    const text = `# Title\n${"- [ ] task\n".repeat(100_000)}`;
    const start = Date.now();
    expect(noteTitle("a.md", text)).toBe("Title");
    expect(countOpenTasks(text)).toBe(100_000);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe("fileStem", () => {
  it("drops folders and the extension", () => {
    expect(fileStem("a/b/Notes.MD")).toBe("Notes");
    expect(fileStem("x")).toBe("x");
  });
});
