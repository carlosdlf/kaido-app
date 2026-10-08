import { describe, expect, it } from "vitest";
import { formatAge } from "./time";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("formatAge", () => {
  it.each([
    [0, "now"],
    [59_999, "now"],
    [MINUTE, "1m"],
    [59 * MINUTE, "59m"],
    [60 * MINUTE, "1h"],
    [DAY - 1, "23h"],
    [DAY, "1d"],
    [6 * DAY, "6d"],
    [7 * DAY, "1w"],
    [29 * DAY, "4w"],
    [30 * DAY, "1mo"],
    [364 * DAY, "12mo"],
    [365 * DAY, "1y"],
    [800 * DAY, "2y"],
  ])("formats %d ms as %s", (elapsed, label) => {
    expect(formatAge(1_000_000_000_000, 1_000_000_000_000 + elapsed)).toBe(label);
  });

  it("treats timestamps in the future as now", () => {
    expect(formatAge(2000, 1000)).toBe("now");
  });
});
