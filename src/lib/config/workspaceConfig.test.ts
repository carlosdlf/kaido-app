import { describe, expect, it } from "vitest";
import {
  parseWorkspaceConfig,
  serializeWorkspaceConfig,
  WORKSPACE_CONFIG_VERSION,
} from "./workspaceConfig";

describe("parseWorkspaceConfig", () => {
  it("defaults to no extra ignore patterns", () => {
    expect(parseWorkspaceConfig(null).value).toEqual({
      version: WORKSPACE_CONFIG_VERSION,
      ignore: [],
    });
  });

  it("reads ignore patterns", () => {
    const result = parseWorkspaceConfig('{ "version": 1, "ignore": ["drafts", "*.tmp.md"] }');
    expect(result.value.ignore).toEqual(["drafts", "*.tmp.md"]);
    expect(result.warnings).toEqual([]);
  });

  it.each(['"drafts"', '["a", 1]', "null", "{}"])("rejects ignore = %s", (ignore) => {
    const result = parseWorkspaceConfig(`{ "version": 1, "ignore": ${ignore} }`);
    expect(result.value.ignore).toEqual([]);
    expect(result.warnings).toEqual([
      {
        field: "ignore",
        message: ".kaido/config.json: ignore: expected a list of strings; using the default",
      },
    ]);
  });

  it("does not share the default list between results", () => {
    const first = parseWorkspaceConfig(null);
    first.value.ignore.push("x");
    expect(parseWorkspaceConfig(null).value.ignore).toEqual([]);
  });

  it("refuses to overwrite a file from a newer version", () => {
    const result = parseWorkspaceConfig('{ "version": 2, "ignore": ["a"] }');
    expect(result.value.ignore).toEqual([]);
    expect(result.writable).toBe(false);
  });
});

describe("serializeWorkspaceConfig", () => {
  it("round-trips with unknown fields", () => {
    const parsed = parseWorkspaceConfig('{ "version": 1, "ignore": ["a"], "order": ["x"] }');
    const text = serializeWorkspaceConfig(parsed.value, parsed);
    expect(text).toBe(
      '{\n  "version": 1,\n  "ignore": [\n    "a"\n  ],\n  "order": [\n    "x"\n  ]\n}\n',
    );
    expect(parseWorkspaceConfig(text)).toEqual(parsed);
  });

  it("keeps an invalid list until the app sets a new one", () => {
    const parsed = parseWorkspaceConfig('{ "version": 1, "ignore": "drafts" }');
    expect(JSON.parse(serializeWorkspaceConfig(parsed.value, parsed)).ignore).toBe("drafts");
    const replaced = serializeWorkspaceConfig({ ...parsed.value, ignore: ["x"] }, parsed);
    expect(JSON.parse(replaced).ignore).toEqual(["x"]);
  });

  it("works without unknown fields", () => {
    expect(JSON.parse(serializeWorkspaceConfig({ version: 1, ignore: [] }))).toEqual({
      version: 1,
      ignore: [],
    });
  });
});
