import { describe, expect, it } from "vitest";
import { parseTaskLine, serializeTask, toggleTaskLine, type Task } from "./tasks";

describe("parseTaskLine", () => {
  it("parses an open task", () => {
    expect(parseTaskLine("- [ ] update runbook")).toEqual({
      done: false,
      text: "update runbook",
      stateOffset: 3,
    });
  });

  it("parses a done task with either case of x", () => {
    expect(parseTaskLine("- [x] configure CI")).toMatchObject({ done: true, text: "configure CI" });
    expect(parseTaskLine("- [X] configure CI")).toMatchObject({ done: true, text: "configure CI" });
  });

  it("accepts * and + bullets", () => {
    expect(parseTaskLine("* [ ] a")).toMatchObject({ done: false, text: "a" });
    expect(parseTaskLine("+ [x] b")).toMatchObject({ done: true, text: "b" });
  });

  it("keeps inline markup such as tags in the text", () => {
    expect(parseTaskLine("- [ ] rotate DB credentials #security")).toMatchObject({
      done: false,
      text: "rotate DB credentials #security",
    });
  });

  it("trims surrounding whitespace and a trailing carriage return", () => {
    expect(parseTaskLine("- [ ]   spaced out  \r")).toMatchObject({
      done: false,
      text: "spaced out",
    });
    expect(parseTaskLine("- [ ]\t\ttabbed")).toMatchObject({ text: "tabbed" });
  });

  it("parses a task without text", () => {
    expect(parseTaskLine("- [ ]")).toMatchObject({ done: false, text: "" });
    expect(parseTaskLine("- [x]\r")).toMatchObject({ done: true, text: "" });
  });

  it("recognizes lines containing separators or a lone carriage return mid-line", () => {
    expect(parseTaskLine("- [ ] a\u2028b")).toMatchObject({ text: "a\u2028b" });
    expect(parseTaskLine("- [ ] a\u2029b")).toMatchObject({ text: "a\u2029b" });
    expect(parseTaskLine("- [ ] a\rb")).toMatchObject({ text: "a\rb" });
  });

  it("parses long whitespace runs in linear time", () => {
    const line = `- [ ] a${" ".repeat(50_000)}b`;
    const start = Date.now();
    const task = parseTaskLine(line);
    const elapsed = Date.now() - start;
    expect(task?.text.length).toBe(50_002);
    expect(elapsed).toBeLessThan(50);
  });

  it.each([
    "",
    "plain text",
    "- plain bullet",
    "-[ ] missing space",
    "- [] empty box",
    "- [y] unknown state",
    "- [ ]no space after box",
    "  - [ ] indented",
    "1. [ ] ordered",
  ])("returns null for %j", (line) => {
    expect(parseTaskLine(line)).toBeNull();
  });
});

describe("serializeTask", () => {
  it("writes canonical task lines", () => {
    expect(serializeTask({ done: false, text: "a" })).toBe("- [ ] a");
    expect(serializeTask({ done: true, text: "b" })).toBe("- [x] b");
    expect(serializeTask({ done: false, text: "" })).toBe("- [ ]");
  });

  it("never emits more than one line", () => {
    expect(serializeTask({ done: false, text: "a\nb" })).toBe("- [ ] a b");
    expect(serializeTask({ done: false, text: "a\r\nb" })).toBe("- [ ] a b");
    expect(serializeTask({ done: false, text: "a\rb\u2028c\u2029d" })).toBe("- [ ] a b c d");
    expect(serializeTask({ done: true, text: "\n\n" })).toBe("- [x]");
  });
});

describe("toggleTaskLine", () => {
  it("flips the state character only", () => {
    expect(toggleTaskLine("- [ ] update runbook")).toBe("- [x] update runbook");
    expect(toggleTaskLine("- [x] update runbook")).toBe("- [ ] update runbook");
    expect(toggleTaskLine("- [X] update runbook")).toBe("- [ ] update runbook");
  });

  it("preserves bullet, spacing and trailing characters", () => {
    expect(toggleTaskLine("* [ ]   spaced  \r")).toBe("* [x]   spaced  \r");
    expect(toggleTaskLine("+ [x]\ttab")).toBe("+ [ ]\ttab");
    expect(toggleTaskLine("- [ ]")).toBe("- [x]");
  });

  it("returns null for non-task lines", () => {
    expect(toggleTaskLine("plain text")).toBeNull();
    expect(toggleTaskLine("  - [ ] indented")).toBeNull();
  });

  it("is its own inverse", () => {
    const line = "- [ ] a #tag  ";
    expect(toggleTaskLine(toggleTaskLine(line) ?? "")).toBe(line);
  });
});

describe("round trip", () => {
  it.each(["- [ ] update runbook", "- [x] configure CI", "- [ ] tag #bug", "- [x]"])(
    "keeps canonical line %j unchanged",
    (line) => {
      const task = parseTaskLine(line);
      expect(task).not.toBeNull();
      if (task) expect(serializeTask(task)).toBe(line);
    },
  );

  it.each<Task>([
    { done: false, text: "write tests" },
    { done: true, text: "ship it #release" },
    { done: false, text: "" },
  ])("parses back what it serializes: %o", (task) => {
    expect(parseTaskLine(serializeTask(task))).toMatchObject(task);
  });

  it("normalizes non-canonical lines", () => {
    const task = parseTaskLine("* [X]  done  ");
    expect(task && serializeTask(task)).toBe("- [x] done");
  });
});
