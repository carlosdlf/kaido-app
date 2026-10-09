/**
 * GFM tables: splitting rows into cells, aligning columns and moving
 * between cells.
 *
 * Functions take the table's lines without any container prefix (quote
 * markers or list indentation, see `tablePrefixLength`): the header row,
 * the delimiter row, then the body rows. Cursor columns are UTF-16 offsets
 * in those lines, like string indexes.
 *
 * As in GFM, every `|` separates cells unless it is escaped (`\|`), also
 * inside inline code spans.
 */

export type Alignment = "none" | "left" | "right" | "center";

export interface TableCursor {
  /** Index of the table line. */
  line: number;
  /** Offset in the line. */
  column: number;
}

export interface TableEdit {
  lines: string[];
  cursor: TableCursor;
}

/** A cell of a row as written. */
export interface RowCell {
  /** The content without surrounding spaces and tabs. */
  text: string;
  /** Offset of the cell, just after the `|` before it (or the line start). */
  from: number;
  /** Offset of the `|` after the cell, or the line end. */
  to: number;
}

/** Narrowest column, so a delimiter cell always has three dashes. */
const MIN_WIDTH = 3;

const DELIMITER_CELL = /^:?-+:?$/;
const EDGE_SPACE = /^[ \t]+|[ \t]+$/g;
const PREFIX = /^(?:[ \t]*>)*[ \t]*/;

/**
 * Display width of cell text, counted in code points, so characters
 * outside the Basic Multilingual Plane (most emoji) count once.
 * Full-width East Asian characters (two columns in a monospace font) and
 * combining marks are not accounted for, so columns holding them may not
 * line up exactly.
 */
export function textWidth(text: string): number {
  return Array.from(text).length;
}

/**
 * Length of the container prefix before a table line inside a quote or a
 * list item: indentation and `>` markers.
 */
export function tablePrefixLength(line: string): number {
  return line.length - line.replace(PREFIX, "").length;
}

/** The element at an index the caller knows to be in range. */
function item<T>(items: readonly T[], index: number): T {
  // Callers only pass checked indexes, so the element exists.
  return items[index] as T;
}

/** Offsets of the `|` characters that separate cells. */
function separators(line: string): number[] {
  const found: number[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "\\") {
      index += 2;
    } else {
      if (char === "|") found.push(index);
      index += 1;
    }
  }
  return found;
}

/**
 * Splits a row into cells. Leading and trailing pipes are optional; a row
 * without separators is one cell.
 */
export function splitRow(line: string): RowCell[] {
  const found = separators(line);
  const first = line.search(/[^ \t]/);
  const last = line.search(/[ \t]*$/) - 1;
  const leading = found.length > 0 && found[0] === first;
  const trailing = found.length > (leading ? 1 : 0) && found[found.length - 1] === last;
  const inner = found.slice(leading ? 1 : 0, trailing ? -1 : undefined);
  const starts = [leading ? first + 1 : 0, ...inner.map((offset) => offset + 1)];
  const ends = [...inner, trailing ? last : line.length];
  return starts.map((from, index) => {
    const to = item(ends, index);
    return { text: line.slice(from, to).replace(EDGE_SPACE, ""), from, to };
  });
}

/** Where the cursor goes in a cell: its first non-space, or just past one space. */
function contentStart(row: Row, column: number): number {
  const cell = item(row.cells, column);
  const offset = row.text.slice(cell.from, cell.to).search(/[^ \t]/);
  return cell.from + (offset === -1 ? Math.min(1, cell.to - cell.from) : offset);
}

/** The cell the cursor is in; a cursor right before a `|` belongs to the cell on its left. */
function cellAt(row: Row, column: number): number {
  const index = row.cells.findIndex((cell) => cell.to >= column);
  return index === -1 ? row.cells.length - 1 : index;
}

function alignment(cell: string): Alignment {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":") && cell.length > 1;
  if (left && right) return "center";
  if (left) return "left";
  return right ? "right" : "none";
}

interface Row {
  text: string;
  /** Never empty: a row has at least one cell. */
  cells: RowCell[];
}

interface Table {
  rows: Row[];
  alignments: Alignment[];
  columns: number;
}

/** Parses a table; `null` if the second line is not a delimiter row. */
function parseTable(lines: string[]): Table | null {
  if (lines.length < 2) return null;
  const rows = lines.map((text) => ({ text, cells: splitRow(text) }));
  const delimiter = item(rows, 1).cells.map((cell) => cell.text);
  if (!delimiter.every((cell) => DELIMITER_CELL.test(cell))) return null;
  const columns = Math.max(...rows.map((row) => row.cells.length));
  const alignments = Array.from({ length: columns }, (_, index): Alignment =>
    index < delimiter.length ? alignment(item(delimiter, index)) : "none",
  );
  return { rows, alignments, columns };
}

function delimiterCell(align: Alignment, width: number): string {
  switch (align) {
    case "left":
      return `:${"-".repeat(width - 1)}`;
    case "right":
      return `${"-".repeat(width - 1)}:`;
    case "center":
      return `:${"-".repeat(width - 2)}:`;
    case "none":
      return "-".repeat(width);
  }
}

/** Spaces before the text in a cell of `width`. */
function leftPadding(space: number, align: Alignment): number {
  if (align === "right") return space;
  return align === "center" ? Math.floor(space / 2) : 0;
}

interface Formatted {
  lines: string[];
  /** Per line, the offset where each cell's content starts. */
  starts: number[][];
}

function format(table: Table): Formatted {
  const texts = table.rows.map((row) =>
    Array.from({ length: table.columns }, (_, column) =>
      column < row.cells.length ? item(row.cells, column).text : "",
    ),
  );
  const widths = table.alignments.map((_, column) =>
    Math.max(
      MIN_WIDTH,
      ...texts.map((row, line) => (line === 1 ? 0 : textWidth(item(row, column)))),
    ),
  );
  const lines: string[] = [];
  const starts: number[][] = [];
  texts.forEach((row, line) => {
    let text = "|";
    const lineStarts: number[] = [];
    widths.forEach((width, column) => {
      const align = item(table.alignments, column);
      const content = item(row, column);
      text += " ";
      if (line === 1) {
        lineStarts.push(text.length);
        text += delimiterCell(align, width);
      } else {
        const space = width - textWidth(content);
        const before = leftPadding(space, align);
        // An empty cell is entered at its left edge.
        lineStarts.push(text.length + (content === "" ? 0 : before));
        text += " ".repeat(before) + content + " ".repeat(space - before);
      }
      text += " |";
    });
    lines.push(text);
    starts.push(lineStarts);
  });
  return { lines, starts };
}

/** Aligns the columns of a table; `null` if `lines` is not a table. */
export function formatTable(lines: string[]): string[] | null {
  const table = parseTable(lines);
  return table && format(table).lines;
}

function clampLine(lines: string[], line: number): number {
  return Math.min(Math.max(line, 0), lines.length - 1);
}

/**
 * Tab in a table: aligns the columns and moves the cursor to the start of
 * the next cell's content, skipping the delimiter row. From the last cell
 * of the last row, a new empty row is added. `null` if `lines` is not a
 * table.
 */
export function nextCell(lines: string[], cursor: TableCursor): TableEdit | null {
  const table = parseTable(lines);
  if (!table) return null;
  const line = clampLine(lines, cursor.line);
  const column = cellAt(item(table.rows, line), cursor.column);
  let target: TableCursor;
  if (line !== 1 && column + 1 < table.columns) {
    target = { line, column: column + 1 };
  } else {
    target = { line: line === 0 ? 2 : line + 1, column: 0 };
  }
  if (target.line >= table.rows.length) {
    table.rows.push({ text: "", cells: splitRow("") });
    target = { line: table.rows.length - 1, column: 0 };
  }
  const formatted = format(table);
  return {
    lines: formatted.lines,
    cursor: {
      line: target.line,
      column: item(item(formatted.starts, target.line), target.column),
    },
  };
}

/**
 * Shift+Tab in a table: moves the cursor to the start of the previous
 * cell's content without changing the text, skipping the delimiter row.
 * `null` in the first cell of the header, or if `lines` is not a table.
 */
export function previousCell(lines: string[], cursor: TableCursor): TableCursor | null {
  const table = parseTable(lines);
  if (!table) return null;
  const line = clampLine(lines, cursor.line);
  const row = item(table.rows, line);
  const column = line === 1 ? 0 : cellAt(row, cursor.column);
  if (column > 0) return { line, column: contentStart(row, column - 1) };
  if (line === 0) return null;
  const previous = line <= 2 ? 0 : line - 1;
  const target = item(table.rows, previous);
  return { line: previous, column: contentStart(target, target.cells.length - 1) };
}
