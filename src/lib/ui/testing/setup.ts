/**
 * jsdom does no layout. The editor measures text ranges, so give ranges the
 * empty geometry an element gets in jsdom.
 */

import "@testing-library/jest-dom/vitest";

function emptyRects(): DOMRectList {
  const list: DOMRect[] = [];
  return Object.assign(list, {
    item: (index: number) => list[index] ?? null,
  }) as unknown as DOMRectList;
}

if (typeof Range !== "undefined") {
  Range.prototype.getClientRects ??= emptyRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);
}

/**
 * In a browser the document keeps focus while focus moves between its
 * elements; jsdom reports no focus in between. Tests run in a focused
 * window, so say so; a test can still simulate leaving the window.
 */
if (typeof Document !== "undefined") {
  Document.prototype.hasFocus = () => true;
}
