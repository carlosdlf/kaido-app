/**
 * Keeps links in task lists pointing at the same notes after notes, task
 * lists or whole folders move.
 *
 * A link `[label](target.md)` is resolved like a task link (relative to the
 * list, `%`-decoded, see `taskLinks.ts`). When the file it points to moved,
 * or the list itself moved so that the relative target no longer reaches
 * the file, the target is written again, relative to the list's new place
 * and percent-encoded like the links the app writes. A `?query` or
 * `#anchor` after the path is kept. Everything else stays byte-identical,
 * and lines without such a link are never touched. Links inside inline
 * code, fenced code blocks and front matter are left alone.
 */

import { folderOf, movedPath, relativePath, type PathMove } from "./pathMoves";
import { joinLines, splitLines, type SourceLine } from "./taskDocument";
import { codeSpans, encodeLinkTarget, resolveLinkTarget } from "./taskLinks";

/** The rewritten text and the indices of the lines that changed. */
export interface LinkEdits {
  text: string;
  lines: number[];
}

/** `[label](target)` with a target without spaces or parentheses, as in `taskLinks.ts`. */
const LINK = /\[([^\]\n]*)\]\(([^()\s]*)\)/g;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const FRONT_MATTER_END = /^(?:---|\.\.\.)[ \t]*$/;

/** Indices of lines that are code or front matter, whose links are not links. */
function skippedLines(lines: readonly SourceLine[]): Set<number> {
  const skipped = new Set<number>();
  let start = 0;
  if (lines[0]?.text.trimEnd() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && FRONT_MATTER_END.test(line.text));
    if (end !== -1) {
      for (let index = 0; index <= end; index += 1) skipped.add(index);
      start = end + 1;
    }
  }
  let fence: string | null = null;
  for (let index = start; index < lines.length; index += 1) {
    const marker = FENCE.exec(lines[index]?.text ?? "")?.[1];
    if (fence !== null) {
      skipped.add(index);
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
    } else if (marker !== undefined) {
      skipped.add(index);
      fence = marker;
    }
  }
  return skipped;
}

/** The target to write instead of `target`, or `null` to leave it. */
function retarget(
  target: string,
  listPath: string,
  newListPath: string,
  moves: readonly PathMove[],
): string | null {
  const resolved = resolveLinkTarget(target, listPath);
  if (resolved === null) return null;
  const destination = movedPath(resolved, moves);
  // Still reaches the same file from where the list is now.
  if (resolveLinkTarget(target, newListPath) === destination) return null;
  const cut = target.search(/[?#]/);
  const suffix = cut === -1 ? "" : target.slice(cut);
  return encodeLinkTarget(relativePath(folderOf(newListPath), destination)) + suffix;
}

/**
 * Rewrites the links of the task list `text` at `listPath` after `moves`.
 * `newListPath` is where the list is after them (by default where `moves`
 * put it). Returns `null` when no link needs to change.
 */
export function retargetLinks(
  text: string,
  listPath: string,
  moves: readonly PathMove[],
  newListPath: string = movedPath(listPath, moves),
): LinkEdits | null {
  if (!text.includes("](")) return null;
  const lines = splitLines(text);
  const skipped = skippedLines(lines);
  const changed: number[] = [];
  const next = lines.map((line, index): SourceLine => {
    if (skipped.has(index) || !line.text.includes("](")) return line;
    const spans = codeSpans(line.text);
    let edited = "";
    let last = 0;
    for (const match of line.text.matchAll(LINK)) {
      if (spans.some(([start, end]) => match.index >= start && match.index < end)) continue;
      const target = match[2] ?? "";
      const replacement = retarget(target, listPath, newListPath, moves);
      if (replacement === null) continue;
      // `[label](` stays; only the target between the parentheses changes.
      const targetStart = match.index + match[0].length - 1 - target.length;
      edited += line.text.slice(last, targetStart) + replacement;
      last = targetStart + target.length;
    }
    if (last === 0) return line;
    changed.push(index);
    return { text: edited + line.text.slice(last), eol: line.eol };
  });
  return changed.length === 0 ? null : { text: joinLines(next), lines: changed };
}
