import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, mergeLayers, resolveConfig } from "./resolve";

describe("mergeLayers", () => {
  it("returns the defaults without layers", () => {
    expect(mergeLayers()).toEqual(DEFAULT_CONFIG);
  });

  it("lets later layers win and skips undefined values", () => {
    expect(
      mergeLayers(
        { workspace: "/a", ignore: ["x"] },
        { workspace: "/b" },
        { workspace: undefined, ignore: ["y"] },
      ),
    ).toEqual({ workspace: "/b", ignore: ["y"] });
  });

  it("can reset the workspace with null", () => {
    expect(mergeLayers({ workspace: "/a" }, { workspace: null }).workspace).toBeNull();
  });

  it("copies lists so the result can be changed safely", () => {
    const ignore = ["x"];
    const result = mergeLayers({ ignore });
    result.ignore.push("y");
    expect(ignore).toEqual(["x"]);
    expect(DEFAULT_CONFIG.ignore).toEqual([]);
  });
});

describe("resolveConfig", () => {
  it("combines workspace and device files", () => {
    expect(
      resolveConfig({ version: 1, ignore: ["drafts"] }, { version: 1, workspace: "/notes" }),
    ).toEqual({ workspace: "/notes", ignore: ["drafts"] });
  });

  it("uses defaults for missing files", () => {
    expect(resolveConfig(null, null)).toEqual({ workspace: null, ignore: [] });
  });
});
