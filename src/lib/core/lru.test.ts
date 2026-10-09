import { describe, expect, it } from "vitest";
import { LruCache } from "./lru";

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("refreshes entries on write and keeps undefined values", () => {
    const cache = new LruCache<string, number | undefined>(2);
    cache.set("a", undefined);
    cache.set("b", 2);
    cache.set("a", 3);
    cache.set("c", 4);
    expect(cache.has("b")).toBe(false);
    expect(cache.get("a")).toBe(3);
    expect(cache.get("missing")).toBeUndefined();
    cache.set("d", undefined);
    expect(cache.has("d")).toBe(true);
    expect(cache.get("d")).toBeUndefined();
  });

  it("deletes, clears and keeps at least one entry", () => {
    const cache = new LruCache<string, number>(0);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(1);
    expect(cache.delete("b")).toBe(true);
    expect(cache.delete("b")).toBe(false);
    cache.set("c", 3);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
