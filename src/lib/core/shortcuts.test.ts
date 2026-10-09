import { describe, expect, it } from "vitest";
import {
  isSearchShortcut,
  isSyncShortcut,
  isViewModeShortcut,
  searchShortcutLabels,
  syncShortcutLabels,
  viewModeShortcutLabels,
} from "./shortcuts";

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

describe("sync shortcut", () => {
  it("is Ctrl+Shift+S, or Cmd+Shift+S on macOS", () => {
    expect(isSyncShortcut(press("S", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isSyncShortcut(press("s", { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isSyncShortcut(press("s", { ctrlKey: true }), false)).toBe(false);
    expect(isSyncShortcut(press("s", { ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(isSyncShortcut(press("s", { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(
      false,
    );
    expect(isSyncShortcut(press("m", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it("has labels for assistive technology and hints", () => {
    expect(syncShortcutLabels(false)).toEqual({ aria: "Control+Shift+S", hint: "^⇧S" });
    expect(syncShortcutLabels(true)).toEqual({ aria: "Meta+Shift+S", hint: "⌘⇧S" });
  });
});

describe("search shortcut", () => {
  it("is Ctrl+K, or Cmd+K on macOS", () => {
    expect(isSearchShortcut(press("k", { ctrlKey: true }), false)).toBe(true);
    expect(isSearchShortcut(press("K", { metaKey: true }), true)).toBe(true);
    expect(isSearchShortcut(press("k", { metaKey: true }), false)).toBe(false);
    expect(isSearchShortcut(press("k", { ctrlKey: true }), true)).toBe(false);
    expect(isSearchShortcut(press("k", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isSearchShortcut(press("k", { ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isSearchShortcut(press("j", { ctrlKey: true }), false)).toBe(false);
  });

  it("has labels for assistive technology and hints", () => {
    expect(searchShortcutLabels(false)).toEqual({ aria: "Control+K", hint: "^K" });
    expect(searchShortcutLabels(true)).toEqual({ aria: "Meta+K", hint: "⌘K" });
  });
});
