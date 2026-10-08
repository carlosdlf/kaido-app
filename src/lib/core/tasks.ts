/**
 * Markdown task lines: `- [ ] text` (open) and `- [x] text` (done).
 *
 * Only top-level lines are recognized for now; indented (nested) tasks are
 * treated as regular lines.
 */

export interface Task {
  done: boolean;
  text: string;
}

export interface ParsedTask extends Task {
  /** Offset in the line of the state character between the brackets. */
  stateOffset: number;
}

/**
 * Matches only the fixed-length prefix. The rest of the line is sliced and
 * trimmed separately, which keeps parsing linear for any input.
 */
const TASK_PREFIX = /^[-*+] \[([ xX])\](?:[ \t]|\r?$)/;

/** Offset of the state character: bullet, space, `[`. */
const STATE_OFFSET = 3;

/** Length of `- [ ]`. */
const PREFIX_LENGTH = 5;

/** Parses a single Markdown line. Returns `null` if it is not a task. */
export function parseTaskLine(line: string): ParsedTask | null {
  const match = TASK_PREFIX.exec(line);
  if (!match) return null;
  return {
    done: match[1] !== " ",
    text: line.slice(PREFIX_LENGTH).trim(),
    stateOffset: STATE_OFFSET,
  };
}

const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;

/**
 * Serializes a task in canonical form: `- [ ] text` or `- [x] text`.
 *
 * Meant for writing new lines only. Line breaks in the text are collapsed to
 * a space so the result is always a single line. To change an existing line,
 * use `toggleTaskLine`, which preserves its original formatting.
 */
export function serializeTask(task: Task): string {
  const prefix = task.done ? "- [x]" : "- [ ]";
  const text = task.text.replace(LINE_BREAKS, " ").trim();
  return text === "" ? prefix : `${prefix} ${text}`;
}

/**
 * Flips the done state of a task line by replacing only the state character,
 * so the bullet, spacing and text stay exactly as written. Returns `null` if
 * the line is not a task.
 */
export function toggleTaskLine(line: string): string | null {
  const task = parseTaskLine(line);
  if (!task) return null;
  const state = task.done ? " " : "x";
  return line.slice(0, task.stateOffset) + state + line.slice(task.stateOffset + 1);
}
