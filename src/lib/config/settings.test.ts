import { describe, expect, it } from "vitest";
import { isAbsolutePath, parseSettings, serializeSettings, SETTINGS_VERSION } from "./settings";

describe("parseSettings", () => {
  it("uses defaults without warnings when the file is missing", () => {
    expect(parseSettings(null)).toEqual({
      value: { version: SETTINGS_VERSION },
      warnings: [],
      unknown: {},
      invalid: {},
      writable: true,
    });
  });

  it("reads a valid file", () => {
    const result = parseSettings('{ "version": 1, "workspace": "/home/a/notes" }');
    expect(result.value).toEqual({ version: 1, workspace: "/home/a/notes" });
    expect(result.warnings).toEqual([]);
  });

  it.each(["", "{", "not json", '{"version": 1,}'])("falls back on invalid JSON %j", (text) => {
    const result = parseSettings(text);
    expect(result.value).toEqual({ version: SETTINGS_VERSION });
    expect(result.warnings).toEqual([
      {
        field: "",
        message: "settings.json: not valid JSON; using defaults and leaving the file unchanged",
      },
    ]);
    expect(result.writable).toBe(false);
  });

  it.each(["[]", "null", "42", '"text"'])("falls back when the root is %s", (text) => {
    const result = parseSettings(text);
    expect(result.value).toEqual({ version: SETTINGS_VERSION });
    expect(result.warnings[0]?.message).toBe(
      "settings.json: expected a JSON object; using defaults and leaving the file unchanged",
    );
    expect(result.writable).toBe(false);
  });

  it("drops an invalid field and keeps the rest", () => {
    const result = parseSettings('{ "version": 1, "workspace": "relative/path", "theme": "x" }');
    expect(result.value).toEqual({ version: 1 });
    expect(result.warnings).toEqual([
      {
        field: "workspace",
        message: "settings.json: workspace: expected an absolute folder path; using the default",
      },
    ]);
    expect(result.unknown).toEqual({ theme: "x" });
    expect(result.invalid).toEqual({ workspace: "relative/path" });
    expect(result.writable).toBe(true);
  });

  it.each([42, null, ""])("rejects a workspace of %j", (workspace) => {
    const result = parseSettings(JSON.stringify({ version: 1, workspace }));
    expect(result.value.workspace).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
  });

  it("assumes the current version when it is missing or malformed", () => {
    for (const version of [undefined, "1", 0, 1.5, -1]) {
      const result = parseSettings(JSON.stringify({ version, workspace: "/w" }));
      expect(result.value).toEqual({ version: SETTINGS_VERSION, workspace: "/w" });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.field).toBe("version");
      expect(result.writable).toBe(true);
    }
  });

  it("uses defaults and refuses to overwrite a file from a newer version", () => {
    const result = parseSettings('{ "version": 99, "workspace": "/w" }');
    expect(result.value).toEqual({ version: SETTINGS_VERSION });
    expect(result.writable).toBe(false);
    expect(result.warnings[0]?.message).toMatch(/newer version of Kaido \(99\)/);
  });
});

describe("serializeSettings", () => {
  it("writes formatted JSON with the current version first", () => {
    expect(serializeSettings({ version: 1, workspace: "/w" })).toBe(
      '{\n  "version": 1,\n  "workspace": "/w"\n}\n',
    );
  });

  it("omits unset fields", () => {
    expect(serializeSettings({ version: 1 })).toBe('{\n  "version": 1\n}\n');
  });

  it("keeps unknown fields and round-trips", () => {
    const parsed = parseSettings('{ "theme": "dark", "version": 1, "workspace": "C:\\\\notes" }');
    const text = serializeSettings(parsed.value, parsed);
    expect(JSON.parse(text)).toEqual({ version: 1, workspace: "C:\\notes", theme: "dark" });
    expect(parseSettings(text)).toEqual(parsed);
  });

  it("always writes the current version", () => {
    const original = { unknown: { version: 7 }, invalid: { version: 8 } };
    expect(JSON.parse(serializeSettings({ version: 0 }, original))).toEqual({ version: 1 });
  });

  it("keeps an invalid field's raw value unless the app replaces it", () => {
    const parsed = parseSettings('{ "version": 1, "workspace": "notes", "theme": "dark" }');
    expect(JSON.parse(serializeSettings(parsed.value, parsed))).toEqual({
      version: 1,
      workspace: "notes",
      theme: "dark",
    });
    expect(JSON.parse(serializeSettings({ ...parsed.value, workspace: "/w" }, parsed))).toEqual({
      version: 1,
      workspace: "/w",
      theme: "dark",
    });
  });
});

describe("isAbsolutePath", () => {
  it.each(["/home/a", "C:\\notes", "c:/notes", "\\\\server\\share"])("accepts %j", (path) => {
    expect(isAbsolutePath(path)).toBe(true);
  });

  it.each(["notes", "./notes", "C:notes", "~/notes", ""])("rejects %j", (path) => {
    expect(isAbsolutePath(path)).toBe(false);
  });
});
