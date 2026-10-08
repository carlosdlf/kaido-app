import { describe, expect, it } from "vitest";
import { scrollTopFor, visibleRange } from "./virtualList";

describe("visibleRange", () => {
  it("renders the rows in view plus overscan", () => {
    expect(visibleRange(1000, 50, 0, 500, 5)).toEqual({ start: 0, end: 16 });
    expect(visibleRange(1000, 50, 1000, 500, 5)).toEqual({ start: 15, end: 36 });
  });

  it("clamps at the end of the list", () => {
    expect(visibleRange(10, 50, 10_000, 500, 5)).toEqual({ start: 9, end: 10 });
    expect(visibleRange(10, 50, 0, 5000, 5)).toEqual({ start: 0, end: 10 });
  });

  it("handles empty lists and bad input", () => {
    expect(visibleRange(0, 50, 0, 500, 5)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(10, 0, 0, 500, 5)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(10, 50, -20, -5, 0)).toEqual({ start: 0, end: 1 });
  });
});

describe("scrollTopFor", () => {
  it("keeps the position when the row is visible", () => {
    expect(scrollTopFor(3, 50, 100, 300)).toBe(100);
  });

  it("scrolls up to a row above the view", () => {
    expect(scrollTopFor(1, 50, 100, 300)).toBe(50);
  });

  it("scrolls down just enough for a row below the view", () => {
    expect(scrollTopFor(10, 50, 0, 300)).toBe(250);
    expect(scrollTopFor(0, 50, 0, 20)).toBe(0);
  });
});
