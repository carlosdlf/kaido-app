/**
 * Inline `#tag` detection.
 *
 * Provisional: the tag syntax is not final and these rules may change.
 *
 * Current rules:
 * - A tag is `#` followed by Unicode letters, digits, `_` or `-`, and must
 *   contain at least one letter, so issue references like `#42` are not tags.
 * - It must start the text or follow whitespace or punctuation. `issue#42`
 *   and `C#-interop` are not tags. `#`, `/` and `&` do not count as a
 *   boundary, so `##tag`, URL fragments (`/#section`) and HTML entities are
 *   not tags either.
 */

export interface TagMatch {
  /** Tag name without the leading `#`. */
  name: string;
  /** Offset of the `#` in the text. */
  start: number;
  /** Offset just past the last character of the tag. */
  end: number;
}

export type TextSegment = { kind: "text"; text: string } | { kind: "tag"; text: string };

const CANDIDATE = /#([\p{L}\p{N}_-]+)/gu;
const HAS_LETTER = /\p{L}/u;
const BOUNDARY = /^[\s\p{P}]$/u;
const NOT_BOUNDARY = new Set(["#", "/", "&"]);

function precededByBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text.codePointAt(index - 1);
  if (before === undefined) return true;
  // A low surrogate belongs to a character outside the BMP (e.g. an emoji),
  // which is neither whitespace nor punctuation.
  if (before >= 0xdc00 && before <= 0xdfff) return false;
  const char = String.fromCodePoint(before);
  return !NOT_BOUNDARY.has(char) && BOUNDARY.test(char);
}

/** Finds the tags in a piece of text, in order. */
export function findTags(text: string): TagMatch[] {
  const tags: TagMatch[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const name = match[1];
    if (name === undefined || !HAS_LETTER.test(name)) continue;
    if (!precededByBoundary(text, match.index)) continue;
    tags.push({ name, start: match.index, end: match.index + match[0].length });
  }
  return tags;
}

/** Splits text into plain runs and tags, for highlighting. */
export function splitTags(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const tag of findTags(text)) {
    if (tag.start > cursor) segments.push({ kind: "text", text: text.slice(cursor, tag.start) });
    segments.push({ kind: "tag", text: text.slice(tag.start, tag.end) });
    cursor = tag.end;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
