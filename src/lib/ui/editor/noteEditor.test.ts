import { insertNewline, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CACHED_NOTES,
  detectLineSeparator,
  normalizeLineBreaks,
  NoteEditor,
  textChange,
} from "./noteEditor";

describe("textChange", () => {
  it("finds the smallest replacement", () => {
    expect(textChange("same", "same")).toBeNull();
    expect(textChange("hello world", "hello brave world")).toEqual({
      from: 6,
      to: 6,
      insert: "brave ",
    });
    expect(textChange("abc", "")).toEqual({ from: 0, to: 3, insert: "" });
    expect(textChange("", "abc")).toEqual({ from: 0, to: 0, insert: "abc" });
    expect(textChange("aaa", "aa")).toEqual({ from: 2, to: 3, insert: "" });
    expect(textChange("abcd", "axyd")).toEqual({ from: 1, to: 3, insert: "xy" });
  });
});

describe("line separators", () => {
  it("takes the kind of the first line break", () => {
    expect(detectLineSeparator("")).toBe("\n");
    expect(detectLineSeparator("one line")).toBe("\n");
    expect(detectLineSeparator("a\nb\r\n")).toBe("\n");
    expect(detectLineSeparator("a\r\nb\n")).toBe("\r\n");
    expect(detectLineSeparator("a\rb\n")).toBe("\r");
  });

  it("normalizes every kind of line break", () => {
    expect(normalizeLineBreaks("a\nb\r\nc\rd", "\r\n")).toBe("a\r\nb\r\nc\r\nd");
    expect(normalizeLineBreaks("a\r\nb", "\n")).toBe("a\nb");
  });
});

describe("NoteEditor", () => {
  let editor: NoteEditor | null = null;

  function create() {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onEdit = vi.fn<(path: string, read: () => string) => void>();
    editor = new NoteEditor(parent, onEdit);
    return { editor, onEdit, parent };
  }

  const typeAt = (target: NoteEditor, position: number, text: string) =>
    target.view.dispatch({ changes: { from: position, insert: text }, userEvent: "input" });

  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.replaceChildren();
  });

  it("moves the cursor to a line without reporting an edit", () => {
    const { editor, onEdit } = create();
    editor.show("a.md", "one\r\ntwo\r\nthree");
    editor.revealLine(2);
    expect(editor.view.state.selection.main.head).toBe(8);
    editor.revealLine(99);
    expect(editor.view.state.selection.main.head).toBe(8);
    editor.revealLine(-3);
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("shows a note and reports edits with a snapshot reader", () => {
    const { editor, onEdit } = create();
    expect(editor.path).toBeNull();
    typeAt(editor, 0, "ignored before any note");
    expect(onEdit).not.toHaveBeenCalled();

    editor.show("a.md", "# A");
    expect(editor.path).toBe("a.md");
    expect(editor.view.state.doc.toString()).toBe("# A");
    expect(onEdit).not.toHaveBeenCalled();

    typeAt(editor, 3, "!");
    expect(onEdit).toHaveBeenCalledTimes(1);
    const [path, read] = onEdit.mock.calls[0] ?? [];
    expect(path).toBe("a.md");
    typeAt(editor, 4, "?");
    // The first reader still returns the text at the time of its edit.
    expect(read?.()).toBe("# A!");
  });

  it("applies new text from disk without reporting it as an edit", () => {
    const { editor, onEdit } = create();
    editor.show("a.md", "one two");
    editor.view.dispatch({ selection: { anchor: 7 } });
    editor.show("a.md", "one and two");
    expect(editor.view.state.doc.toString()).toBe("one and two");
    expect(editor.view.state.selection.main.head).toBe(11);
    expect(onEdit).not.toHaveBeenCalled();
    editor.show("a.md", "one and two");
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("keeps each note's history across switches", () => {
    const { editor } = create();
    editor.show("a.md", "a");
    typeAt(editor, 1, "1");
    editor.show("b.md", "b");
    expect(editor.view.state.doc.toString()).toBe("b");
    editor.show("a.md", "a1");
    expect(editor.view.state.doc.toString()).toBe("a1");
    expect(undo(editor.view)).toBe(true);
    expect(editor.view.state.doc.toString()).toBe("a");
  });

  it("reconciles a cached note with newer text", () => {
    const { editor } = create();
    editor.show("a.md", "old");
    editor.show("b.md", "b");
    editor.show("a.md", "new");
    expect(editor.view.state.doc.toString()).toBe("new");
  });

  it("starts fresh for forgotten and evicted notes", () => {
    const { editor } = create();
    editor.show("a.md", "a");
    typeAt(editor, 1, "1");
    editor.show("b.md", "b");
    editor.forget("a.md");
    editor.show("a.md", "a1");
    expect(undo(editor.view)).toBe(false);

    for (let index = 0; index <= CACHED_NOTES; index += 1) editor.show(`n${index}.md`, "");
    editor.show("a.md", "a1");
    expect(undo(editor.view)).toBe(false);
  });

  it("moves the shown note to its new path with its history", () => {
    const { editor, onEdit } = create();
    editor.show("a.md", "a");
    typeAt(editor, 1, "1");
    editor.rename("a.md", "b.md");
    expect(editor.path).toBe("b.md");
    editor.show("b.md", "a1");
    expect(editor.view.state.doc.toString()).toBe("a1");
    typeAt(editor, 2, "2");
    expect(onEdit.mock.calls.at(-1)?.[0]).toBe("b.md");
    expect(undo(editor.view)).toBe(true);
    expect(undo(editor.view)).toBe(true);
    expect(editor.view.state.doc.toString()).toBe("a");
  });

  it("moves the cached state of a note that is not shown", () => {
    const { editor } = create();
    editor.show("a.md", "a");
    typeAt(editor, 1, "1");
    editor.show("c.md", "c");
    editor.rename("a.md", "b.md");
    editor.rename("missing.md", "other.md");
    editor.rename("c.md", "c.md");
    expect(editor.path).toBe("c.md");
    editor.show("b.md", "a1");
    expect(undo(editor.view)).toBe(true);
    expect(editor.view.state.doc.toString()).toBe("a");
    editor.show("a.md", "fresh");
    expect(undo(editor.view)).toBe(false);
  });

  it("drops the cached state at the target even when nothing moves there", () => {
    const { editor } = create();
    // A note once shown at b.md leaves state behind.
    editor.show("b.md", "old");
    typeAt(editor, 3, "!");
    editor.show("c.md", "c");
    // a.md has no cached state and is not shown, so nothing moves to b.md.
    editor.rename("a.md", "b.md");
    // Same text as the old note, so only its history would tell them apart.
    editor.show("b.md", "old!");
    expect(undo(editor.view)).toBe(false);
    expect(editor.view.state.doc.toString()).toBe("old!");
  });

  it("labels the text area and takes focus", () => {
    const { editor, parent } = create();
    editor.show("a.md", "text");
    const content = parent.querySelector(".cm-content");
    expect(content).toHaveAttribute("aria-label", "Note text");
    editor.focus();
    expect(editor.view.hasFocus).toBe(true);
  });

  it("highlights Markdown with dimmed markers and code blocks", () => {
    const { editor, parent } = create();
    editor.show("a.md", "# Title\n\n**bold** `code`\n\n```\nx\n```\n");
    const marks = [...parent.querySelectorAll(".cm-md-mark")].map((mark) => mark.textContent);
    expect(marks).toEqual(expect.arrayContaining(["#", "**", "`", "```"]));
    expect(parent.querySelectorAll(".cm-md-codeblock")).toHaveLength(3);
    // Code block backgrounds follow edits.
    typeAt(editor, editor.view.state.doc.length, "```\ny\n```\n");
    expect(parent.querySelectorAll(".cm-md-codeblock")).toHaveLength(6);
  });

  describe("keeps the bytes of every note", () => {
    const cases: [string, string][] = [
      ["CRLF", "# Title\r\n\r\nbody\r\n"],
      ["LF", "# Title\n\nbody\n"],
      ["mixed, CRLF first", "a\r\nb\nc\r\n"],
      ["mixed, LF first", "a\nb\r\nc\n"],
      ["CR", "a\rb\r"],
      ["no trailing line break", "a\r\nb"],
      ["empty", ""],
    ];

    it.each(cases)("%s", (_name, text) => {
      const { editor, onEdit } = create();
      editor.show("a.md", text);
      expect(editor.text).toBe(text);
      // Showing it again is not a change from disk, and nothing is an edit.
      editor.show("a.md", text);
      expect(onEdit).not.toHaveBeenCalled();
      expect(undo(editor.view)).toBe(false);

      typeAt(editor, 0, "x");
      expect(onEdit).toHaveBeenCalledTimes(1);
      expect(onEdit.mock.calls[0]?.[1]()).toBe(`x${text}`);

      // The same text comes back from a cached state.
      editor.show("b.md", "b");
      editor.show("a.md", `x${text}`);
      expect(editor.text).toBe(`x${text}`);
    });
  });

  it("breaks lines in a CRLF note with CRLF, also when pasting", () => {
    const { editor, onEdit } = create();
    editor.show("a.md", "a\r\nb");
    editor.view.dispatch({ selection: { anchor: 1 } });
    expect(insertNewline(editor.view)).toBe(true);
    expect(onEdit.mock.lastCall?.[1]()).toBe("a\r\n\r\nb");

    const filters = editor.view.state.facet(EditorView.clipboardInputFilter);
    const pasted = filters.reduce((text, filter) => filter(text, editor.view.state), "x\ny\rz");
    expect(pasted).toBe("x\r\ny\r\nz");
  });

  it("follows a file whose line breaks changed on disk", () => {
    const { editor, onEdit } = create();
    editor.show("a.md", "a\nb\n");
    editor.show("a.md", "a\r\nb\r\nc\r\n");
    expect(editor.text).toBe("a\r\nb\r\nc\r\n");
    expect(editor.view.state.lineBreak).toBe("\r\n");
    expect(onEdit).not.toHaveBeenCalled();
    expect(undo(editor.view)).toBe(false);
  });

  it("replaces the text when a stray separator hides the difference", () => {
    const { editor } = create();
    editor.show("a.md", "a\r\nb\nc");
    // Same text when every line break counts as one character.
    editor.show("a.md", "a\r\nb\r\nc");
    expect(editor.text).toBe("a\r\nb\r\nc");
    editor.show("a.md", "a\r\nb\nc");
    // A smaller change that would keep the stray separator.
    editor.show("a.md", "a\r\nb\r\ncX");
    expect(editor.text).toBe("a\r\nb\r\ncX");
  });

  it("keeps changes from disk out of the undo history", () => {
    const { editor } = create();
    editor.show("a.md", "one");
    typeAt(editor, 3, " two");
    editor.show("a.md", "zero one two");
    expect(undo(editor.view)).toBe(true);
    // Only the typed text is undone; the change from disk stays.
    expect(editor.text).toBe("zero one");
    expect(undo(editor.view)).toBe(false);
  });

  it("forgets the note it shows", () => {
    const { editor, onEdit } = create();
    editor.show("a.md", "a");
    typeAt(editor, 1, "1");
    editor.forget("a.md");
    expect(editor.path).toBeNull();
    typeAt(editor, 0, "ignored");
    expect(onEdit).toHaveBeenCalledTimes(1);
    editor.show("a.md", "a");
    expect(undo(editor.view)).toBe(false);
  });

  it("gives up focus", () => {
    const { editor } = create();
    editor.show("a.md", "text");
    editor.focus();
    editor.blur();
    expect(editor.view.hasFocus).toBe(false);
  });
});
