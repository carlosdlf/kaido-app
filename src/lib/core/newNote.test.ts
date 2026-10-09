import { describe, expect, it } from "vitest";
import {
  isNewNoteShortcut,
  MAX_UNTITLED_NAMES,
  newNoteFolder,
  newNotePath,
  newNoteShortcutLabels,
  untitledName,
} from "./newNote";
import { ALL_TASKS } from "./views";

describe("newNoteFolder", () => {
  it("uses the selected project", () => {
    expect(newNoteFolder("api")).toBe("api");
    expect(newNoteFolder("inbox")).toBe("inbox");
  });

  it("falls back to the inbox without a project", () => {
    expect(newNoteFolder(ALL_TASKS)).toBe("inbox");
    expect(newNoteFolder("")).toBe("inbox");
  });
});

describe("untitledName", () => {
  it("numbers names after the first", () => {
    expect(untitledName(1)).toBe("untitled.md");
    expect(untitledName(2)).toBe("untitled 2.md");
    expect(untitledName(10)).toBe("untitled 10.md");
  });
});

describe("newNotePath", () => {
  it("starts with untitled.md", () => {
    expect(newNotePath("inbox", () => false)).toBe("inbox/untitled.md");
  });

  it("returns the first free name", () => {
    const taken = new Set(["api/untitled.md", "api/untitled 2.md", "api/untitled 4.md"]);
    expect(newNotePath("api", (path) => taken.has(path))).toBe("api/untitled 3.md");
  });

  it("gives up after the limit", () => {
    const tried: string[] = [];
    const isTaken = (path: string) => {
      tried.push(path);
      return true;
    };
    expect(newNotePath("inbox", isTaken, 3)).toBeNull();
    expect(tried).toEqual(["inbox/untitled.md", "inbox/untitled 2.md", "inbox/untitled 3.md"]);
    expect(newNotePath("inbox", () => true)).toBeNull();
    expect(MAX_UNTITLED_NAMES).toBeGreaterThan(1);
  });
});

describe("isNewNoteShortcut", () => {
  const press = (key: string, modifiers: Partial<Record<string, boolean>> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it("matches Ctrl+N outside macOS", () => {
    expect(isNewNoteShortcut(press("n", { ctrlKey: true }), false)).toBe(true);
    expect(isNewNoteShortcut(press("N", { ctrlKey: true }), false)).toBe(true);
    expect(isNewNoteShortcut(press("n", { metaKey: true }), false)).toBe(false);
    expect(isNewNoteShortcut(press("n", { ctrlKey: true, metaKey: true }), false)).toBe(false);
  });

  it("matches Cmd+N on macOS", () => {
    expect(isNewNoteShortcut(press("n", { metaKey: true }), true)).toBe(true);
    expect(isNewNoteShortcut(press("n", { ctrlKey: true }), true)).toBe(false);
  });

  it("ignores other keys and extra modifiers", () => {
    expect(isNewNoteShortcut(press("n"), false)).toBe(false);
    expect(isNewNoteShortcut(press("m", { ctrlKey: true }), false)).toBe(false);
    expect(isNewNoteShortcut(press("n", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isNewNoteShortcut(press("n", { ctrlKey: true, altKey: true }), false)).toBe(false);
  });
});

describe("newNoteShortcutLabels", () => {
  it("describes the platform's shortcut", () => {
    expect(newNoteShortcutLabels(false)).toEqual({ aria: "Control+N", hint: "^N" });
    expect(newNoteShortcutLabels(true)).toEqual({ aria: "Meta+N", hint: "⌘N" });
  });
});
