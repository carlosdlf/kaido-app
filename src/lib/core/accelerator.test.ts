import { describe, expect, it } from "vitest";
import {
  acceleratorKey,
  acceleratorKeys,
  isValidAccelerator,
  normalizeAccelerator,
  parseAccelerator,
  recordShortcut,
  sameAccelerator,
  type CodedKeyPress,
} from "./accelerator";

function press(code: string, key: string, mods: Partial<CodedKeyPress> = {}): CodedKeyPress {
  return { code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("acceleratorKey", () => {
  it.each([
    ["KeyA", "A"],
    ["Digit7", "7"],
    ["F1", "F1"],
    ["F24", "F24"],
    ["Space", "Space"],
    ["Comma", "Comma"],
    ["ArrowUp", "ArrowUp"],
  ])("maps %s to %s", (code, key) => {
    expect(acceleratorKey(code)).toBe(key);
  });

  it.each(["F25", "F0", "ShiftLeft", "NumpadEnter", "IntlBackslash", ""])("refuses %s", (code) => {
    expect(acceleratorKey(code)).toBeNull();
  });
});

describe("parseAccelerator", () => {
  it("orders modifiers and accepts their aliases", () => {
    expect(parseAccelerator("shift+alt+CmdOrCtrl+space")).toEqual({
      modifiers: ["CommandOrControl", "Alt", "Shift"],
      key: "Space",
    });
    expect(parseAccelerator("Ctrl+Option+Cmd+k")).toEqual({
      modifiers: ["Control", "Super", "Alt"],
      key: "K",
    });
  });

  it.each([
    ["CommandOrControl+Alt+Space", true],
    ["Ctrl+KeyJ", true],
    ["Super+Digit1", true],
    ["Alt+f5", true],
    ["Alt+5", true],
    ["Alt+pageup", true],
    ["Space", false],
    ["Shift+A", false],
    ["Ctrl+Ctrl+A", false],
    ["Hyper+A", false],
    ["Ctrl+", false],
    ["Ctrl+Nope", false],
    ["", false],
    [`Ctrl+${"A".repeat(120)}`, false],
  ])("%s valid: %s", (accelerator, valid) => {
    expect(isValidAccelerator(accelerator)).toBe(valid);
  });
});

describe("normalizeAccelerator and sameAccelerator", () => {
  it("spells accelerators one way", () => {
    expect(normalizeAccelerator("alt+cmdorctrl+Space")).toBe("CommandOrControl+Alt+Space");
    expect(normalizeAccelerator("nope")).toBeNull();
  });

  it("compares shortcuts", () => {
    expect(sameAccelerator("CmdOrCtrl+Alt+Space", "CommandOrControl+Alt+Space")).toBe(true);
    expect(sameAccelerator("Ctrl+A", "Ctrl+B")).toBe(false);
    expect(sameAccelerator(null, null)).toBe(true);
    expect(sameAccelerator(null, "Ctrl+A")).toBe(false);
    expect(sameAccelerator("weird", "weird")).toBe(true);
  });
});

describe("recordShortcut", () => {
  it("records Ctrl as CommandOrControl elsewhere than macOS", () => {
    expect(recordShortcut(press("KeyJ", "j", { ctrlKey: true, altKey: true }), false)).toEqual({
      kind: "shortcut",
      accelerator: "CommandOrControl+Alt+J",
    });
    expect(recordShortcut(press("KeyJ", "j", { metaKey: true }), false)).toEqual({
      kind: "shortcut",
      accelerator: "Super+J",
    });
  });

  it("records Cmd as CommandOrControl on macOS and Ctrl as Control", () => {
    expect(recordShortcut(press("Space", " ", { metaKey: true, shiftKey: true }), true)).toEqual({
      kind: "shortcut",
      accelerator: "CommandOrControl+Shift+Space",
    });
    expect(recordShortcut(press("KeyA", "a", { ctrlKey: true }), true)).toEqual({
      kind: "shortcut",
      accelerator: "Control+A",
    });
  });

  it("cancels on Esc and disables on Backspace", () => {
    expect(recordShortcut(press("Escape", "Escape"), false)).toEqual({ kind: "cancel" });
    expect(recordShortcut(press("Backspace", "Backspace"), false)).toEqual({ kind: "disable" });
  });

  it("keeps listening for modifiers alone, keys without a modifier and unknown keys", () => {
    expect(recordShortcut(press("ControlLeft", "Control", { ctrlKey: true }), false)).toEqual({
      kind: "incomplete",
    });
    expect(recordShortcut(press("KeyA", "a"), false)).toEqual({ kind: "incomplete" });
    expect(recordShortcut(press("KeyA", "A", { shiftKey: true }), false)).toEqual({
      kind: "incomplete",
    });
    expect(recordShortcut(press("NumpadEnter", "Enter", { ctrlKey: true }), false)).toEqual({
      kind: "incomplete",
    });
    expect(recordShortcut(press("Escape", "Escape", { ctrlKey: true }), false)).toEqual({
      kind: "incomplete",
    });
  });
});

describe("acceleratorKeys", () => {
  it("shows keys for the platform", () => {
    expect(acceleratorKeys("CommandOrControl+Alt+Space", false)).toEqual(["Ctrl", "Alt", "Space"]);
    expect(acceleratorKeys("CommandOrControl+Alt+Space", true)).toEqual(["⌘", "⌥", "Space"]);
    expect(acceleratorKeys("Control+Super+Shift+Comma", true)).toEqual(["⌃", "⌘", "⇧", ","]);
    expect(acceleratorKeys("Super+ArrowUp", false)).toEqual(["Super", "↑"]);
  });

  it("shows an accelerator it cannot read as it is", () => {
    expect(acceleratorKeys("Hyper+X", false)).toEqual(["Hyper+X"]);
  });
});
