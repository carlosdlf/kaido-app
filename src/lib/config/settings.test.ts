import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPTURE_SHORTCUT,
  DEFAULT_EDITOR_FONT_SIZE,
  effectiveSettings,
  hideDoneOf,
  isAbsolutePath,
  isOpenedWorkspace,
  MAX_DISMISSED_SETUP,
  MAX_HIDE_DONE_PATHS,
  MAX_HIDE_DONE_ROOTS,
  MAX_RECENT_WORKSPACES,
  parseSettings,
  reloadSettings,
  serializeSettings,
  SETTINGS_VERSION,
  withDismissedSetup,
  withHideDone,
  withOpenedWorkspace,
  withoutRecentWorkspace,
  type DeviceSettings,
} from "./settings";

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

describe("device settings fields", () => {
  const parse = (fields: Record<string, unknown>) =>
    parseSettings(JSON.stringify({ version: 1, ...fields }));

  it("reads every field", () => {
    const result = parse({
      recentWorkspaces: ["/a", "C:\\b"],
      editorFontSize: 18,
      autoSync: false,
      captureShortcut: "CmdOrCtrl+Shift+K",
      hideDone: { "/a": ["inbox/tasks.md", "~/all-tasks"] },
      dismissedSetup: ["/a"],
    });
    expect(result.warnings).toEqual([]);
    expect(result.value).toEqual({
      version: 1,
      recentWorkspaces: ["/a", "C:\\b"],
      editorFontSize: 18,
      autoSync: false,
      captureShortcut: "CmdOrCtrl+Shift+K",
      hideDone: { "/a": ["inbox/tasks.md", "~/all-tasks"] },
      dismissedSetup: ["/a"],
    });
  });

  it("accepts a disabled capture shortcut", () => {
    expect(parse({ captureShortcut: null }).value.captureShortcut).toBeNull();
  });

  it("caps and deduplicates lists", () => {
    const paths = Array.from({ length: 8 }, (_, index) => `/w${index}`);
    const hidden = Array.from({ length: MAX_HIDE_DONE_PATHS + 5 }, (_, index) => `p${index}.md`);
    const roots = Array.from({ length: MAX_DISMISSED_SETUP + 3 }, (_, index) => `/r${index}`);
    const result = parse({
      recentWorkspaces: ["/w0", ...paths],
      hideDone: { "/a": [...hidden, "p0.md"] },
      dismissedSetup: roots,
    });
    expect(result.warnings).toEqual([]);
    expect(result.value.recentWorkspaces).toEqual(paths.slice(0, MAX_RECENT_WORKSPACES));
    expect(result.value.hideDone?.["/a"]).toHaveLength(MAX_HIDE_DONE_PATHS);
    expect(result.value.hideDone?.["/a"]?.at(-1)).toBe("p204.md");
    expect(result.value.dismissedSetup).toEqual(roots.slice(-MAX_DISMISSED_SETUP));
  });

  it("keeps the last workspaces of hideDone", () => {
    const record = Object.fromEntries(
      Array.from({ length: MAX_HIDE_DONE_ROOTS + 2 }, (_, index) => [`/r${index}`, ["x.md"]]),
    );
    const roots = Object.keys(parse({ hideDone: record }).value.hideDone ?? {});
    expect(roots).toEqual(Object.keys(record).slice(-MAX_HIDE_DONE_ROOTS));
  });

  it.each<[string, unknown, string]>([
    ["recentWorkspaces", ["relative"], "expected a list of absolute folder paths"],
    ["recentWorkspaces", "/a", "expected a list of absolute folder paths"],
    ["editorFontSize", 11, "expected a whole number from 12 to 20"],
    ["editorFontSize", 21, "expected a whole number from 12 to 20"],
    ["editorFontSize", 14.5, "expected a whole number from 12 to 20"],
    ["editorFontSize", "14", "expected a whole number from 12 to 20"],
    ["autoSync", "yes", "expected true or false"],
    [
      "captureShortcut",
      "Space",
      'expected a shortcut such as "CommandOrControl+Alt+Space", or null',
    ],
    ["captureShortcut", 3, 'expected a shortcut such as "CommandOrControl+Alt+Space", or null'],
    ["hideDone", { "/a": "x.md" }, "expected an object of lists of paths"],
    ["hideDone", ["x"], "expected an object of lists of paths"],
    ["dismissedSetup", [1], "expected a list of folder paths"],
  ])("falls back to the default for an invalid %s (%j)", (name, input, expected) => {
    const result = parse({ [name]: input });
    expect(result.value).toEqual({ version: 1 });
    expect(result.warnings).toEqual([
      { field: name, message: `settings.json: ${name}: ${expected}; using the default` },
    ]);
    expect(result.invalid).toEqual({ [name]: input });
  });

  it("fills in defaults", () => {
    expect(effectiveSettings({ version: 1 })).toEqual({
      recentWorkspaces: [],
      editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
      autoSync: true,
      captureShortcut: DEFAULT_CAPTURE_SHORTCUT,
    });
    expect(
      effectiveSettings({
        version: 1,
        recentWorkspaces: ["/a"],
        editorFontSize: 12,
        autoSync: false,
        captureShortcut: null,
      }),
    ).toEqual({
      recentWorkspaces: ["/a"],
      editorFontSize: 12,
      autoSync: false,
      captureShortcut: null,
    });
  });

  it("writes back an invalid value until the app sets one", () => {
    const original = parse({ editorFontSize: 99 });
    expect(JSON.parse(serializeSettings(original.value, original))).toEqual({
      version: 1,
      editorFontSize: 99,
    });
    const changed = { ...original.value, editorFontSize: 16 };
    expect(JSON.parse(serializeSettings(changed, original))).toEqual({
      version: 1,
      editorFontSize: 16,
    });
  });
});

describe("settings updates", () => {
  it("moves an opened workspace to the front of the recent ones", () => {
    let settings: DeviceSettings = { version: 1 };
    expect(isOpenedWorkspace(settings, "/a")).toBe(false);
    settings = withOpenedWorkspace(settings, "/a");
    expect(settings).toEqual({ version: 1, workspace: "/a", recentWorkspaces: ["/a"] });
    expect(isOpenedWorkspace(settings, "/a")).toBe(true);
    for (const path of ["/b", "/c", "/d", "/e", "/f", "/b"]) {
      settings = withOpenedWorkspace(settings, path);
    }
    expect(settings.recentWorkspaces).toEqual(["/b", "/f", "/e", "/d", "/c"]);
    expect(isOpenedWorkspace({ version: 1, workspace: "/b" }, "/b")).toBe(false);
  });

  it("removes a recent workspace", () => {
    expect(withoutRecentWorkspace({ version: 1 }, "/a").recentWorkspaces).toEqual([]);
    expect(
      withoutRecentWorkspace({ version: 1, recentWorkspaces: ["/a", "/b"] }, "/a").recentWorkspaces,
    ).toEqual(["/b"]);
  });

  it("remembers hidden done tasks per workspace", () => {
    let settings = withHideDone({ version: 1 }, "/a", ["x.md", "y.md", "x.md"]);
    expect(settings.hideDone).toEqual({ "/a": ["x.md", "y.md"] });
    expect(hideDoneOf(settings, "/a")).toEqual(["x.md", "y.md"]);
    expect(hideDoneOf(settings, "/b")).toEqual([]);
    settings = withHideDone(settings, "/b", ["z.md"]);
    settings = withHideDone(settings, "/a", []);
    expect(settings.hideDone).toEqual({ "/b": ["z.md"] });
    const many = Array.from({ length: MAX_HIDE_DONE_PATHS + 1 }, (_, index) => `${index}.md`);
    expect(hideDoneOf(withHideDone(settings, "/a", many), "/a")).toEqual(many.slice(1));
  });

  it("keeps the most recently changed workspaces' hidden done tasks", () => {
    let settings: DeviceSettings = { version: 1 };
    for (let index = 0; index <= MAX_HIDE_DONE_ROOTS; index += 1) {
      settings = withHideDone(settings, `/r${index}`, ["x.md"]);
    }
    const roots = Object.keys(settings.hideDone ?? {});
    expect(roots).toHaveLength(MAX_HIDE_DONE_ROOTS);
    expect(roots[0]).toBe("/r1");
    // Changing a remembered workspace makes it the most recent one.
    settings = withHideDone(settings, "/r1", ["y.md"]);
    settings = withHideDone(settings, "/new", ["z.md"]);
    expect(Object.keys(settings.hideDone ?? {})).not.toContain("/r2");
    expect(hideDoneOf(settings, "/r1")).toEqual(["y.md"]);
  });

  it("remembers dismissed setup banners", () => {
    let settings = withDismissedSetup({ version: 1 }, "/a");
    settings = withDismissedSetup(settings, "/b");
    settings = withDismissedSetup(settings, "/a");
    expect(settings.dismissedSetup).toEqual(["/b", "/a"]);
    for (let index = 0; index < MAX_DISMISSED_SETUP; index += 1) {
      settings = withDismissedSetup(settings, `/r${index}`);
    }
    expect(settings.dismissedSetup).toHaveLength(MAX_DISMISSED_SETUP);
    expect(settings.dismissedSetup?.[0]).toBe("/r0");
  });
});

describe("reloadSettings", () => {
  const current: DeviceSettings = {
    version: 1,
    workspace: "/notes",
    autoSync: false,
    editorFontSize: 18,
    captureShortcut: "Alt+K",
    hideDone: { "/notes": ["inbox/tasks.md"] },
  };

  it("applies a valid file", () => {
    const text = JSON.stringify({ version: 1, workspace: "/b", editorFontSize: 13 });
    const reloaded = reloadSettings(current, text);
    // Auto-sync stays off: the new file does not turn it on explicitly.
    expect(reloaded.value).toEqual({
      version: 1,
      workspace: "/b",
      editorFontSize: 13,
      autoSync: false,
    });
    expect(reloaded.file).toEqual(parseSettings(text));
    expect(reloaded.warnings).toEqual([]);
    // Turning auto-sync on takes an explicit true.
    const on = reloadSettings(current, JSON.stringify({ version: 1, autoSync: true }));
    expect(on.value.autoSync).toBe(true);
  });

  it.each([
    ["not valid JSON", "{ broken"],
    ["expected a JSON object", "[]"],
    ["written by a newer version of Kaido (2)", '{"version":2,"autoSync":true}'],
  ])("keeps every current setting when the file says %s", (problem, text) => {
    const reloaded = reloadSettings(current, text);
    expect(reloaded.value).toBe(current);
    expect(reloaded.file.writable).toBe(false);
    expect(reloaded.warnings).toEqual([
      {
        field: problem.startsWith("written") ? "version" : "",
        message: `settings.json: ${problem.startsWith("written") ? "version: " : ""}${problem}; keeping the current settings and leaving the file unchanged`,
      },
    ]);
  });

  it("keeps the current value of each invalid field", () => {
    const text = JSON.stringify({
      version: 1,
      workspace: "relative",
      autoSync: "yes",
      editorFontSize: 99,
      captureShortcut: "Space",
      hideDone: "x",
      dismissedSetup: [1],
    });
    const reloaded = reloadSettings(current, text);
    expect(reloaded.value).toEqual(current);
    expect(reloaded.warnings.map((warning) => warning.message)).toContain(
      "settings.json: editorFontSize: expected a whole number from 12 to 20; keeping the current value",
    );
    // Writes start from the file, so its invalid values are written back unchanged.
    expect(reloaded.file.value).toEqual({ version: 1 });
    expect(reloaded.file.invalid).toMatchObject({ editorFontSize: 99, autoSync: "yes" });
  });

  it("never turns auto-sync on without an explicit true", () => {
    for (const autoSync of [undefined, "yes", null]) {
      const text = JSON.stringify({ version: 1, autoSync });
      expect(reloadSettings(current, text).value.autoSync).toBe(false);
    }
    expect(reloadSettings(current, null).value).toEqual({ version: 1, autoSync: false });
    // A default that was on stays on.
    expect(reloadSettings({ version: 1 }, '{"version":1}').value.autoSync).toBeUndefined();
  });
});
