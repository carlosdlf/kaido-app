/** Windowing math for lists with fixed-height rows. */

export interface VisibleRange {
  /** First rendered index. */
  start: number;
  /** One past the last rendered index. */
  end: number;
}

/** Rows to render for a scroll position, with `overscan` extra rows on each side. */
export function visibleRange(
  count: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VisibleRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(scrollTop, 0) / rowHeight);
  const visible = Math.ceil(Math.max(viewportHeight, 0) / rowHeight) + 1;
  const start = Math.min(Math.max(first - overscan, 0), count - 1);
  const end = Math.min(first + visible + overscan, count);
  return { start, end: Math.max(end, start + 1) };
}

/** The scroll position that brings row `index` fully into view, changing as little as possible. */
export function scrollTopFor(
  index: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  // A row taller than the viewport aligns to its top.
  if (bottom > scrollTop + viewportHeight)
    return Math.max(Math.min(bottom - viewportHeight, top), 0);
  return scrollTop;
}
