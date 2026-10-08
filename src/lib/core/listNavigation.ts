/**
 * Keyboard movement within a vertical list. Returns the index to move to,
 * or `null` if the key does not move the selection.
 */
export function nextListIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const from = Math.min(Math.max(current, 0), last);
  switch (key) {
    case "ArrowDown":
      return Math.min(from + 1, last);
    case "ArrowUp":
      return Math.max(from - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}
