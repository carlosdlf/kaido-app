/**
 * Tab and Shift+Tab inside GFM tables. The table is found in the syntax
 * tree; parsing, aligning and moving between cells live in the core.
 */

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { ChangeSpec, EditorState, Line } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";
import {
  nextCell,
  previousCell,
  tablePrefixLength,
  type TableCursor,
} from "$lib/core/markdownTable";

/** Longest wait for the parser to reach the end of the note, in milliseconds. */
const PARSE_BUDGET = 20;

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

interface TableLine {
  line: Line;
  /** The quote markers or list indentation before the table text. */
  prefix: string;
  text: string;
}

interface TableAtCursor {
  /** Never fewer than two: a table has a header and a delimiter row. */
  lines: TableLine[];
  cursor: TableCursor;
}

function enclosingTable(node: SyntaxNode | null): SyntaxNode | null {
  for (let current = node; current; current = current.parent) {
    if (current.name === "Table") return current;
  }
  return null;
}

function tableAt(state: EditorState): TableAtCursor | null {
  const head = state.selection.main.head;
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET) ?? syntaxTree(state);
  const table =
    enclosingTable(tree.resolveInner(head, 1)) ?? enclosingTable(tree.resolveInner(head, -1));
  if (!table) return null;
  const { doc } = state;
  const first = doc.lineAt(table.from);
  const last = doc.lineAt(table.to);
  const lines: TableLine[] = [];
  for (let number = first.number; number <= last.number; number += 1) {
    const line = doc.line(number);
    // The first line's prefix ends where the table starts, e.g. after a list marker.
    const length = number === first.number ? table.from - line.from : tablePrefixLength(line.text);
    lines.push({ line, prefix: line.text.slice(0, length), text: line.text.slice(length) });
  }
  const cursorLine = doc.lineAt(head);
  const prefix = lines[cursorLine.number - first.number]?.prefix.length ?? 0;
  return {
    lines,
    cursor: {
      line: cursorLine.number - first.number,
      column: Math.max(0, head - cursorLine.from - prefix),
    },
  };
}

/**
 * Aligns the table's columns and moves to the next cell, adding a row after
 * the last one. Outside a table it does nothing, so Tab keeps moving focus.
 */
export const nextTableCell: Command = (view) => {
  const { state } = view;
  const table = tableAt(state);
  const edit =
    table &&
    nextCell(
      table.lines.map((line) => line.text),
      table.cursor,
    );
  if (!table || !edit) return false;
  const last = table.lines[table.lines.length - 1];
  // A table has at least two lines.
  if (!last) return false;
  const changes: ChangeSpec[] = [];
  edit.lines.forEach((text, index) => {
    const current = table.lines[index];
    if (!current) {
      // An added row continues the last line's quote or list prefix.
      changes.push({ from: last.line.to, insert: state.lineBreak + last.prefix + text });
    } else if (current.text !== text) {
      changes.push({
        from: current.line.from + current.prefix.length,
        to: current.line.to,
        insert: text,
      });
    }
  });
  const changeSet = state.changes(changes);
  const doc = changeSet.apply(state.doc);
  const firstLine = last.line.number - table.lines.length + 1;
  const target = doc.line(firstLine + edit.cursor.line);
  const prefix = (table.lines[edit.cursor.line] ?? last).prefix.length;
  view.dispatch({
    changes: changeSet,
    selection: { anchor: target.from + prefix + edit.cursor.column },
    scrollIntoView: true,
    userEvent: "input.table",
  });
  return true;
};

/**
 * Moves to the previous cell of the table. In the first header cell and
 * outside a table it does nothing, so Shift+Tab keeps moving focus.
 */
export const previousTableCell: Command = (view) => {
  const table = tableAt(view.state);
  const cursor =
    table &&
    previousCell(
      table.lines.map((line) => line.text),
      table.cursor,
    );
  const target = cursor && table?.lines[cursor.line];
  if (!cursor || !target) return false;
  view.dispatch({
    selection: { anchor: target.line.from + target.prefix.length + cursor.column },
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};

export const tableKeymap: readonly KeyBinding[] = [
  { key: "Tab", run: nextTableCell, shift: previousTableCell },
];
