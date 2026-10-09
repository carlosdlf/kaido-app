/**
 * The "terminal native" look of the note editor: Markdown markers stay
 * visible but dimmed, headings are sized, prose uses the note font and code
 * and tables the UI monospace font. Every value comes from the design tokens.
 */

import { syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { tagHighlighter, tags } from "@lezer/highlight";

/** Classes for Markdown syntax, styled by `editorTheme`. */
const markdownClasses = tagHighlighter([
  { tag: tags.heading1, class: "cm-md-h1" },
  { tag: tags.heading2, class: "cm-md-h2" },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], class: "cm-md-h3" },
  { tag: tags.strong, class: "cm-md-strong" },
  { tag: tags.emphasis, class: "cm-md-em" },
  { tag: tags.strikethrough, class: "cm-md-strike" },
  { tag: tags.link, class: "cm-md-link" },
  { tag: tags.url, class: "cm-md-url" },
  { tag: tags.quote, class: "cm-md-quote" },
  { tag: tags.monospace, class: "cm-md-code" },
  { tag: [tags.processingInstruction, tags.atom, tags.contentSeparator], class: "cm-md-mark" },
  { tag: [tags.labelName, tags.comment], class: "cm-md-meta" },
  // Inside fenced code blocks.
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], class: "cm-code-keyword" },
  { tag: [tags.string, tags.regexp], class: "cm-code-string" },
  { tag: [tags.number, tags.bool, tags.null], class: "cm-code-literal" },
  { tag: [tags.lineComment, tags.blockComment], class: "cm-md-meta" },
]);

/** Line classes for block nodes whose lines are styled as a whole. */
const blockLineDecorations: ReadonlyMap<string, Decoration> = new Map([
  ["FencedCode", Decoration.line({ class: "cm-md-codeblock" })],
  ["CodeBlock", Decoration.line({ class: "cm-md-codeblock" })],
  ["Table", Decoration.line({ class: "cm-md-table" })],
]);

function blockLines(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const decoration = blockLineDecorations.get(node.name);
        if (!decoration) return;
        const first = doc.lineAt(Math.max(node.from, from));
        const last = doc.lineAt(Math.min(node.to, to));
        for (let line = first.number; line <= last.number; line += 1) {
          const start = doc.line(line).from;
          builder.add(start, start, decoration);
        }
        return false;
      },
    });
  }
  return builder.finish();
}

/**
 * Gives every line of a code block a background, so blocks read as one box,
 * and every line of a table the monospace font, so its columns line up.
 */
const blocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = blockLines(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = blockLines(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--color-bg)",
      color: "var(--color-text-note)",
      fontSize: "var(--font-size-note)",
    },
    // The caret alone is easy to miss; an accent bar marks the focused editor.
    "&.cm-focused": {
      outline: "none",
      boxShadow: "inset var(--selection-bar-width) 0 0 var(--color-accent)",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-note)",
      lineHeight: "var(--line-height-note)",
    },
    ".cm-content": {
      boxSizing: "border-box",
      width: "100%",
      maxWidth: "var(--note-max-width)",
      padding: "var(--space-40) var(--space-48) var(--space-80)",
      caretColor: "var(--color-accent)",
    },
    ".cm-line": {
      padding: "0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--color-accent)",
      borderLeftWidth: "var(--space-2)",
    },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "var(--color-text-selection)",
      },
    ".cm-md-h1, .cm-md-h2, .cm-md-h3": {
      color: "var(--color-heading)",
      fontWeight: "var(--font-weight-semibold)",
    },
    ".cm-md-h1": {
      fontSize: "var(--font-size-note-h1)",
      lineHeight: "var(--line-height-heading)",
    },
    ".cm-md-h2": {
      fontSize: "var(--font-size-note-h2)",
    },
    ".cm-md-strong": {
      color: "var(--color-heading)",
      fontWeight: "var(--font-weight-semibold)",
    },
    ".cm-md-em": {
      fontStyle: "italic",
    },
    ".cm-md-strike": {
      color: "var(--color-muted)",
      textDecoration: "line-through",
    },
    ".cm-md-link": {
      color: "var(--color-accent)",
    },
    ".cm-md-url": {
      color: "var(--color-muted)",
    },
    ".cm-md-quote": {
      color: "var(--color-muted)",
    },
    ".cm-md-code": {
      fontFamily: "var(--font-ui)",
      fontSize: "var(--font-size-ui)",
      color: "var(--color-text)",
    },
    ".cm-md-codeblock": {
      backgroundColor: "var(--color-surface-raised)",
      fontFamily: "var(--font-ui)",
      fontSize: "var(--font-size-ui)",
      color: "var(--color-text)",
      paddingInline: "var(--space-16)",
    },
    // Same font and size as code, so aligned columns line up.
    ".cm-md-table": {
      fontFamily: "var(--font-ui)",
      fontSize: "var(--font-size-ui)",
    },
    ".cm-code-keyword": {
      color: "var(--color-heading)",
      fontWeight: "var(--font-weight-semibold)",
    },
    ".cm-code-string, .cm-code-literal": {
      color: "var(--color-text-note)",
    },
    ".cm-md-meta": {
      color: "var(--color-muted)",
    },
    // Control characters, e.g. a stray line break of another kind.
    ".cm-specialChar": {
      color: "var(--color-danger)",
    },
    // Last, so markers inside headings and links stay dimmed.
    ".cm-md-mark": {
      color: "var(--color-dim)",
      fontFamily: "var(--font-ui)",
      fontWeight: "var(--font-weight-regular)",
      fontStyle: "normal",
      textDecoration: "none",
    },
  },
  { dark: true },
);

export const terminalNative: Extension = [editorTheme, syntaxHighlighting(markdownClasses), blocks];
