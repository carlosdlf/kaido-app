import { describe, expect, it } from "vitest";
import { isViewModeShortcut, viewModeShortcutLabels } from "./shortcuts";

const press = (key: string, modifiers: Partial<Record<string, boolean>> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("view mode shortcut", () => {
  it("is Ctrl+Shift+M, or Cmd+Shift+M on macOS", () => {
    expect(isViewModeShortcut(press("M", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isViewModeShortcut(press("m", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isViewModeShortcut(press("m", { ctrlKey: true }), false)).toBe(false);
    expect(isViewModeShortcut(press("m", { ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(isViewModeShortcut(press("m", { metaKey: true, shiftKey: true }), false)).toBe(false);
    expect(
      isViewModeShortcut(press("m", { ctrlKey: true, shiftKey: true, altKey: true }), false),
    ).toBe(false);
    expect(isViewModeShortcut(press("n", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it("has labels for assistive technology and hints", () => {
    expect(viewModeShortcutLabels(false)).toEqual({ aria: "Control+Shift+M", hint: "^⇧M" });
    expect(viewModeShortcutLabels(true)).toEqual({ aria: "Meta+Shift+M", hint: "⌘⇧M" });
  });
});
