/**
 * A small Markdown reader for the read-only note view. It recognizes the
 * blocks notes use most (headings, paragraphs, fenced code, bullet lists
 * and task lists) and treats everything else as paragraph text. It never
 * produces HTML, so note contents cannot inject markup.
 */

import { headingText } from "./markdown";
import { splitTags } from "./tags";
import { parseTaskLine, type ParsedTask } from "./tasks";

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "tasks"; tasks: ParsedTask[] };

export type Inline =
  { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "tag"; text: string };

const LINE_BREAK = /\r?\n/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BULLET = /^[-*+][ \t]+(.*)$/;
const FRONT_MATTER_END = /^(?:---|\.\.\.)\s*$/;

function skipFrontMatter(lines: string[]): number {
  if (lines[0]?.trimEnd() !== "---") return 0;
  const end = lines.findIndex((line, index) => index > 0 && FRONT_MATTER_END.test(line));
  return end > 0 ? end + 1 : 0;
}

export function parseBlocks(text: string): Block[] {
  const lines = text.split(LINE_BREAK);
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  let index = skipFrontMatter(lines);
  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const closing = FENCE.exec(lines[index] ?? "");
        const closer = closing?.[1];
        if (
          closer &&
          closer[0] === marker[0] &&
          closer.length >= marker.length &&
          !closing[2]?.trim()
        )
          break;
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", language: (fence[2] ?? "").trim(), text: body.join("\n") });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      const level = (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: "heading", level, text: headingText(heading[2] ?? "") });
      index += 1;
      continue;
    }

    const task = parseTaskLine(line);
    if (task) {
      flushParagraph();
      const tasks: ParsedTask[] = [task];
      index += 1;
      for (
        let next = parseTaskLine(lines[index] ?? "");
        next;
        next = parseTaskLine(lines[index] ?? "")
      ) {
        tasks.push(next);
        index += 1;
      }
      blocks.push({ kind: "tasks", tasks });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      const items: string[] = [];
      for (
        let next: RegExpExecArray | null = bullet;
        next && !parseTaskLine(lines[index] ?? "");
        next = BULLET.exec(lines[index] ?? "")
      ) {
        items.push((next[1] ?? "").trim());
        index += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }

    if (line.trim() === "") flushParagraph();
    else paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return blocks;
}

/** Splits inline text into plain text, `code` spans and `#tags`. */
export function parseInline(text: string): Inline[] {
  const inlines: Inline[] = [];
  const pushText = (part: string) => {
    for (const segment of splitTags(part)) inlines.push(segment);
  };
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("`", cursor);
    const close = open === -1 ? -1 : text.indexOf("`", open + 1);
    if (close === -1) break;
    if (open > cursor) pushText(text.slice(cursor, open));
    if (close > open + 1) inlines.push({ kind: "code", text: text.slice(open + 1, close) });
    cursor = close + 1;
  }
  if (cursor < text.length) pushText(text.slice(cursor));
  return inlines;
}
