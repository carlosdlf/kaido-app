import { describe, expect, it } from "vitest";
import { isMac } from "./platform";

describe("isMac", () => {
  it("detects macOS from the user agent", () => {
    expect(isMac("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15")).toBe(true);
    expect(isMac("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe(false);
    expect(isMac("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
  });

  it("reads the current user agent by default", () => {
    expect(isMac()).toBe(/Macintosh|Mac OS X/.test(navigator.userAgent));
  });
});
