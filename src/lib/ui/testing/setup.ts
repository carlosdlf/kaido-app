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
