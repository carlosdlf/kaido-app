import { describe, expect, it } from "vitest";
import {
  isNewProjectShortcut,
  MAX_PROJECT_NAME_BYTES,
  newProjectShortcutLabels,
  projectTasksPath,
  validateProjectName,
} from "./projectNames";

const existing = ["inbox", "api-payments", "Dotfiles"];
const reason = (input: string) => {
  const result = validateProjectName(input, existing);
  return result.ok ? null : result.reason;
};

describe("validateProjectName", () => {
  it("accepts names as typed, trimmed, without adding an extension", () => {
    expect(validateProjectName("  side project ", existing)).toEqual({
      ok: true,
      name: "side project",
    });
    expect(validateProjectName("Ñandú 🐕", existing)).toEqual({ ok: true, name: "Ñandú 🐕" });
    expect(validateProjectName("notes.md", existing)).toEqual({ ok: true, name: "notes.md" });
  });

  it("refuses names that break on some OS", () => {
    expect(reason("  ")).toBe("Enter a name.");
    expect(reason("a/b")).toBe("Names cannot contain / or \\.");
    expect(reason("a\\b")).toBe("Names cannot contain / or \\.");
    expect(reason("a\u0007b")).toBe("Names cannot contain control characters.");
    expect(reason("a:b")).toBe('Names cannot contain < > : " | ? or *.');
    expect(reason(".hidden")).toBe("Names cannot start with a dot.");
    expect(reason("trailing.")).toBe("Names cannot end with a space or a dot.");
    expect(reason("con")).toBe("CON is a reserved name on Windows.");
    expect(reason("LPT1.backup")).toBe("LPT1 is a reserved name on Windows.");
  });

  it("refuses the folders the workspace treats specially", () => {
    expect(reason("Inbox")).toBe("inbox already exists.");
    expect(reason("_archive")).toBe("Project names cannot start with _.");
    expect(reason("_drafts")).toBe("Project names cannot start with _.");
    expect(reason("node_modules")).toBe("node_modules is ignored in workspaces.");
  });

  it("refuses existing projects, ignoring case", () => {
    expect(reason("API-Payments")).toBe("A project named api-payments already exists.");
    expect(reason("dotfiles")).toBe("A project named Dotfiles already exists.");
  });

  it("caps names at 100 UTF-8 bytes", () => {
    expect(reason("a".repeat(MAX_PROJECT_NAME_BYTES))).toBeNull();
    expect(reason("a".repeat(MAX_PROJECT_NAME_BYTES + 1))).toBe("This name is too long.");
    expect(reason("é".repeat(51))).toBe("This name is too long.");
  });
});

describe("projectTasksPath", () => {
  it("puts the task list at the project root", () => {
    expect(projectTasksPath("side")).toBe("side/tasks.md");
  });
});

describe("new project shortcut", () => {
  const press = (key: string, modifiers: Partial<Record<string, boolean>> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it("is Ctrl+Shift+N, or Cmd+Shift+N on macOS", () => {
    expect(isNewProjectShortcut(press("N", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isNewProjectShortcut(press("n", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isNewProjectShortcut(press("n", { ctrlKey: true }), false)).toBe(false);
    expect(isNewProjectShortcut(press("n", { metaKey: true, shiftKey: true }), false)).toBe(false);
    expect(isNewProjectShortcut(press("n", { ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(
      isNewProjectShortcut(press("n", { ctrlKey: true, shiftKey: true, altKey: true }), false),
    ).toBe(false);
    expect(isNewProjectShortcut(press("m", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it("has labels for assistive technology and hints", () => {
    expect(newProjectShortcutLabels(false)).toEqual({ aria: "Control+Shift+N", hint: "^⇧N" });
    expect(newProjectShortcutLabels(true)).toEqual({ aria: "Meta+Shift+N", hint: "⌘⇧N" });
  });
});
