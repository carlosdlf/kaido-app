import { undo } from "@codemirror/commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "./noteEditor";

describe("tables in the note editor", () => {
  let editor: NoteEditor | null = null;

  function create(text: string, cursor: number) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const onEdit = vi.fn<(path: string, read: () => string) => void>();
    editor = new NoteEditor(parent, onEdit);
    editor.show("a.md", text);
    editor.view.dispatch({ selection: { anchor: cursor } });
    editor.focus();
    return { editor, onEdit, parent };
  }

  /** Presses a key in the editor; returns whether the editor handled it. */
  function press(target: NoteEditor, shiftKey = false): boolean {
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      keyCode: 9,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    target.view.contentDOM.dispatchEvent(event);
    return event.defaultPrevented;
  }

  const head = (target: NoteEditor) => target.view.state.selection.main.head;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.replaceChildren();
  });

  it("sets table lines in the monospace font with dimmed pipes", () => {
    const { parent, editor } = create("text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n", 0);
    const lines = [...parent.querySelectorAll(".cm-md-table")].map((line) => line.textContent);
    expect(lines).toEqual(["| a | b |", "|---|---|", "| 1 | 2 |"]);
    const marks = [...parent.querySelectorAll(".cm-md-table .cm-md-mark")].map(
      (mark) => mark.textContent,
    );
    expect(marks).toEqual(expect.arrayContaining(["|", "|---|---|"]));
    // The class follows edits.
    editor.view.dispatch({ changes: { from: 0, insert: "| x |\n|---|\n\n" } });
    expect(parent.querySelectorAll(".cm-md-table")).toHaveLength(5);
  });

  it("aligns the table and moves to the next cell on Tab", () => {
    const text = "| a | bb |\n|-|:-:|\n| ccc | d |\n";
    const { editor, onEdit } = create(text, 2);
    expect(press(editor)).toBe(true);
    expect(editor.text).toBe("| a   | bb  |\n| --- | :-: |\n| ccc |  d  |\n");
    expect(head(editor)).toBe(8);
    expect(onEdit).toHaveBeenCalledTimes(1);

    // From the header's last cell to the first body cell.
    expect(press(editor)).toBe(true);
    expect(head(editor)).toBe("| a   | bb  |\n| --- | :-: |\n| ".length);
    expect(editor.text).toBe("| a   | bb  |\n| --- | :-: |\n| ccc |  d  |\n");
  });

  it("only moves the cursor when the table is already aligned", () => {
    const text = "| a   | b   |\n| --- | --- |\n";
    const { editor, onEdit } = create(text, 2);
    expect(press(editor)).toBe(true);
    expect(head(editor)).toBe(8);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("adds a row after the last cell, as one undo step", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |";
    const { editor } = create(text, text.length - 2);
    expect(press(editor)).toBe(true);
    const added = "| a   | b   |\n| --- | --- |\n| 1   | 2   |\n|     |     |";
    expect(editor.text).toBe(added);
    expect(head(editor)).toBe(added.length - "    |     |".length);
    expect(undo(editor.view)).toBe(true);
    expect(editor.text).toBe(text);
    expect(head(editor)).toBe(text.length - 2);
  });

  it("moves to the previous cell on Shift+Tab without changing the text", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    const { editor, onEdit } = create(text, text.indexOf("1"));
    expect(press(editor, true)).toBe(true);
    expect(head(editor)).toBe(text.indexOf("b"));
    expect(press(editor, true)).toBe(true);
    expect(head(editor)).toBe(text.indexOf("a"));
    // The first cell lets focus leave the editor.
    expect(press(editor, true)).toBe(false);
    expect(head(editor)).toBe(text.indexOf("a"));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("leaves Tab alone outside tables", () => {
    const text = "plain | text\n\n| a |\n|---|\n";
    const { editor, onEdit } = create(text, 3);
    expect(press(editor)).toBe(false);
    expect(press(editor, true)).toBe(false);
    expect(editor.text).toBe(text);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("keeps CRLF line breaks", () => {
    const text = "| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n";
    const { editor, onEdit } = create(text, text.indexOf("2"));
    expect(press(editor)).toBe(true);
    expect(editor.text).toBe(
      "| a   | b   |\r\n| --- | --- |\r\n| 1   | 2   |\r\n|     |     |\r\n",
    );
    expect(onEdit.mock.lastCall?.[1]()).toBe(editor.text);
  });

  it("keeps quote markers and list indentation", () => {
    const quoted = "> | a | b |\n> |---|---|\n> | 1 | 2 |\n";
    const { editor } = create(quoted, quoted.indexOf("2"));
    expect(press(editor)).toBe(true);
    expect(editor.text).toBe(
      "> | a   | b   |\n> | --- | --- |\n> | 1   | 2   |\n> |     |     |\n",
    );
    expect(head(editor)).toBe(editor.text.length - "|     |     |\n".length + 2);

    const listed = "- | a |\n  |---|\n";
    editor.show("b.md", listed);
    editor.view.dispatch({ selection: { anchor: listed.indexOf("a") } });
    expect(press(editor)).toBe(true);
    expect(editor.text).toBe("- | a   |\n  | --- |\n  |     |\n");
    expect(press(editor, true)).toBe(true);
    expect(head(editor)).toBe(4);
  });
});
