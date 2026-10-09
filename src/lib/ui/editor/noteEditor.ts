/**
 * One CodeMirror view shared by every note. Each note keeps its own editor
 * state (text, selection, undo history) in a small LRU cache, so switching
 * back to a recent note restores where the user was and what they can undo.
 *
 * Text goes in and out byte for byte: each note is split only on the line
 * separator it uses (`\n`, `\r\n` or `\r`, taken from its first line
 * break) and joined with the same one, so saving never rewrites line
 * endings. Stray separators of another kind stay in the text and are shown
 * as special characters.
 */

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
  type Text,
} from "@codemirror/state";
import { drawSelection, EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { LruCache } from "$lib/core/lru";
import { tableKeymap } from "./tables";
import { terminalNative } from "./theme";

/** Notes whose editor state is kept while other notes are shown. */
export const CACHED_NOTES = 20;

/** Marks changes that come from disk, so they are not reported as edits. */
const fromDisk = Annotation.define<boolean>();

/** The line separator a note uses: the kind of its first line break, `\n` without any. */
export function detectLineSeparator(text: string): string {
  const match = /\r\n?|\n/.exec(text);
  return match ? match[0] : "\n";
}

/** Turns every kind of line break in `text` into `separator`. */
export function normalizeLineBreaks(text: string, separator: string): string {
  return text.replace(/\r\n?|\n/g, separator);
}

export type EditListener = (path: string, read: () => string) => void;

interface CachedNote {
  state: EditorState;
  scroll: ReturnType<EditorView["scrollSnapshot"]> | null;
}

/** The smallest replacement that turns `before` into `after`. */
export function textChange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let end = 0;
  while (
    end < limit - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end += 1;
  }
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

export class NoteEditor {
  readonly view: EditorView;
  readonly #cache = new LruCache<string, CachedNote>(CACHED_NOTES);
  readonly #shared: Extension;
  /** Holds each state's line separator, so it can follow the file. */
  readonly #separator = new Compartment();
  #path: string | null = null;

  constructor(parent: HTMLElement, onEdit: EditListener) {
    this.#shared = [
      history(),
      drawSelection(),
      highlightSpecialChars(),
      // Pasted or dropped text uses the note's own line breaks.
      EditorView.clipboardInputFilter.of((text, state) =>
        normalizeLineBreaks(text, state.lineBreak),
      ),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      // Tab only acts inside tables; elsewhere it moves focus out of the editor.
      keymap.of([...tableKeymap, ...defaultKeymap, ...historyKeymap]),
      terminalNative,
      EditorView.contentAttributes.of({ "aria-label": "Note text" }),
      EditorView.updateListener.of((update) => {
        const path = this.#path;
        if (path === null) return;
        const edited = update.transactions.some(
          (transaction) => transaction.docChanged && !transaction.annotation(fromDisk),
        );
        if (!edited) return;
        // States are immutable, so the snapshot is safe to read later.
        const state = update.state;
        onEdit(path, () => state.sliceDoc());
      }),
    ];
    this.view = new EditorView({ parent, state: this.#create("\n") });
  }

  /** The path shown, or `null` before the first note. */
  get path(): string | null {
    return this.#path;
  }

  /** The shown text, exactly as it would be saved. */
  get text(): string {
    return this.view.state.sliceDoc();
  }

  /**
   * Shows `text` for `path`. Switching notes restores the note's cached
   * state; if the text differs from it (or from what is shown), the
   * difference is applied as one change from disk, keeping the cursor close.
   * Changes from disk are not added to the undo history.
   */
  show(path: string, text: string): void {
    if (path !== this.#path) {
      this.#stash();
      const cached = this.#cache.get(path);
      this.#path = path;
      this.view.setState(cached?.state ?? this.#create(detectLineSeparator(text), text));
      if (cached?.scroll) this.view.dispatch({ effects: cached.scroll });
    }
    let state = this.view.state;
    if (state.sliceDoc() === text) return;
    const separator = detectLineSeparator(text);
    if (state.lineBreak !== separator) {
      this.view.dispatch({
        effects: this.#separator.reconfigure(EditorState.lineSeparator.of(separator)),
        annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
      });
      state = this.view.state;
    }
    // Compared with every line break counted as one character, as the
    // editor does, so positions match the document.
    const next = state.toText(text);
    const change = textChange(state.doc.toString(), next.toString()) ?? {
      from: 0,
      to: state.doc.length,
      insert: next.toString(),
    };
    this.#fromDisk(
      change.from,
      change.to,
      next.slice(change.from, change.from + change.insert.length),
    );
    // A stray separator inside a line reads like a line break above; then
    // the whole text is replaced.
    if (this.view.state.sliceDoc() !== text) this.#fromDisk(0, this.view.state.doc.length, next);
  }

  /**
   * Moves a note's editor state to its new path after a rename, keeping
   * text, selection and undo history. Edits are reported under `to` from
   * now on.
   */
  rename(from: string, to: string): void {
    if (from === to) return;
    // State left from another note at `to` never outlives the move.
    this.#cache.delete(to);
    if (this.#path === from) {
      this.#path = to;
      return;
    }
    const cached = this.#cache.get(from);
    if (!cached) return;
    this.#cache.delete(from);
    this.#cache.set(to, cached);
  }

  /** Forgets a note's editor state, e.g. after it was deleted. */
  forget(path: string): void {
    this.#cache.delete(path);
    if (path !== this.#path) return;
    this.#path = null;
    this.view.setState(this.#create("\n"));
  }

  /** Puts the cursor at the start of a line (0-based, clamped) and scrolls it into view. */
  revealLine(line: number): void {
    const doc = this.view.state.doc;
    const number = Math.min(Math.max(Math.floor(line) + 1, 1), doc.lines);
    const position = doc.line(number).from;
    this.view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
  }

  focus(): void {
    this.view.focus();
  }

  /** Moves focus out of the editor, e.g. before it is hidden. */
  blur(): void {
    this.view.contentDOM.blur();
  }

  destroy(): void {
    this.view.destroy();
    this.#cache.clear();
  }

  #fromDisk(from: number, to: number, insert: Text): void {
    this.view.dispatch({
      changes: { from, to, insert },
      annotations: [fromDisk.of(true), Transaction.addToHistory.of(false)],
    });
  }

  #stash(): void {
    if (this.#path === null) return;
    this.#cache.set(this.#path, { state: this.view.state, scroll: this.view.scrollSnapshot() });
  }

  #create(separator: string, text = ""): EditorState {
    return EditorState.create({
      doc: text,
      extensions: [this.#shared, this.#separator.of(EditorState.lineSeparator.of(separator))],
    });
  }
}
