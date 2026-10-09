import { describe, expect, it } from "vitest";
import { contentHash } from "./contentHash";

describe("contentHash", () => {
  it("is deterministic and hex", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).toMatch(/^[0-9a-f]{14}$/);
    expect(contentHash("")).toMatch(/^[0-9a-f]{14}$/);
  });

  it("tells different contents apart", () => {
    const hashes = new Set(
      ["", "a", "b", "ab", "ba", "héllo", "hello", "hello\n"].map(contentHash),
    );
    expect(hashes.size).toBe(8);
  });
});
