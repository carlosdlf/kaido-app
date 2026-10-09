import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SettingsDialog from "./SettingsDialog.svelte";

type Props = NonNullable<Parameters<typeof render<typeof SettingsDialog>>[1]>;

function setup(props: Partial<Props> = {}) {
  const opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.append(opener);
  opener.focus();
  const handlers = {
    onswitch: vi.fn(),
    onsetup: vi.fn(async () => undefined),
    onfontsize: vi.fn(),
    onautosync: vi.fn(),
    onshortcut: vi.fn(async (): Promise<string | null> => null),
    oncopy: vi.fn(),
    onclose: vi.fn(),
  };
  const result = render(SettingsDialog, {
    workspace: "/home/me/notes",
    setupMissing: [".gitattributes", ".gitignore"],
    fontSize: 15,
    fontMin: 12,
    fontMax: 20,
    autoSync: true,
    shortcut: "CommandOrControl+Alt+Space",
    captureAvailable: true,
    version: "1.2.3",
    ...handlers,
    ...props,
  });
  return { ...handlers, ...result, opener };
}

const dialog = () => screen.getByRole("dialog", { name: "Settings" });

describe("SettingsDialog", () => {
  it("is a modal dialog with focus inside", () => {
    setup();
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus();
    expect(screen.getByText("/home/me/notes")).toBeInTheDocument();
    expect(screen.getByText("Kaido 1.2.3")).toBeInTheDocument();
  });

  it("closes with Escape, Ctrl+, and the close button, giving focus back", async () => {
    const user = userEvent.setup();
    const first = setup();
    await user.keyboard("{Escape}");
    expect(first.onclose).toHaveBeenCalledTimes(1);
    expect(first.opener).toHaveFocus();
    first.unmount();

    const second = setup();
    await user.keyboard("{Control>},{/Control}");
    expect(second.onclose).toHaveBeenCalledTimes(1);
    second.unmount();

    const third = setup();
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(third.onclose).toHaveBeenCalledTimes(1);
  });

  it("gives focus to the element it was told to on close", async () => {
    const user = userEvent.setup();
    const target = document.createElement("button");
    document.body.append(target);
    const { onclose } = setup({ returnFocus: target });
    await user.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalled();
    expect(target).toHaveFocus();
    target.remove();
  });

  it("closes on a click outside", async () => {
    const { onclose } = setup();
    const backdrop = dialog().parentElement;
    if (!backdrop) throw new Error("no backdrop");
    await fireEvent.mouseDown(backdrop);
    expect(onclose).toHaveBeenCalled();
    await fireEvent.mouseDown(dialog());
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the dialog", async () => {
    const user = userEvent.setup();
    setup();
    const close = screen.getByRole("button", { name: "Close settings" });
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("button", { name: "Copy link" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it("switches workspace and sets up git files", async () => {
    const user = userEvent.setup();
    const { onswitch, onsetup } = setup();
    await user.click(screen.getByRole("button", { name: "Switch…" }));
    expect(onswitch).toHaveBeenCalled();
    const setUp = screen.getByRole("button", { name: "Set up git files" });
    expect(setUp).toHaveAccessibleDescription(
      "Adds lines to .gitattributes and .gitignore so task lists merge cleanly.",
    );
    await user.click(setUp);
    expect(onsetup).toHaveBeenCalled();
  });

  it("disables set up when nothing is missing or not known yet", async () => {
    const user = userEvent.setup();
    const { rerender, onsetup } = setup({ setupMissing: [] });
    const setUp = screen.getByRole("button", { name: "Set up git files" });
    expect(setUp).toHaveAttribute("aria-disabled", "true");
    await user.click(setUp);
    expect(onsetup).not.toHaveBeenCalled();
    expect(screen.getByText(".gitattributes and .gitignore are set up.")).toBeInTheDocument();
    await rerender({ setupMissing: null });
    expect(screen.getByText("Checking the git setup files…")).toBeInTheDocument();
  });

  it("works without a workspace", () => {
    setup({ workspace: null });
    expect(screen.getByText("No workspace is open.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch…" })).toBeNull();
  });

  it("steps and types the font size within range", async () => {
    const user = userEvent.setup();
    const { onfontsize, rerender } = setup();
    await user.click(screen.getByRole("button", { name: "Larger text" }));
    expect(onfontsize).toHaveBeenLastCalledWith(16);
    await user.click(screen.getByRole("button", { name: "Smaller text" }));
    expect(onfontsize).toHaveBeenLastCalledWith(14);
    const input = screen.getByRole("spinbutton", { name: "Font size" });
    await fireEvent.change(input, { target: { value: "18" } });
    expect(onfontsize).toHaveBeenLastCalledWith(18);
    onfontsize.mockClear();
    await fireEvent.change(input, { target: { value: "" } });
    expect(onfontsize).not.toHaveBeenCalled();
    await rerender({ fontSize: 20 });
    onfontsize.mockClear();
    const larger = screen.getByRole("button", { name: "Larger text" });
    expect(larger).toHaveAttribute("aria-disabled", "true");
    await user.click(larger);
    await rerender({ fontSize: 12 });
    const smaller = screen.getByRole("button", { name: "Smaller text" });
    expect(smaller).toHaveAttribute("aria-disabled", "true");
    await user.click(smaller);
    expect(onfontsize).not.toHaveBeenCalled();
    expect(larger).toHaveAttribute("aria-disabled", "false");
  });

  it("toggles auto-sync", async () => {
    const user = userEvent.setup();
    const { onautosync } = setup();
    const toggle = screen.getByRole("switch", { name: "Auto-sync" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(onautosync).toHaveBeenCalledWith(false);
  });

  it("shows the shortcut keys and records a new one", async () => {
    const user = userEvent.setup();
    const { onshortcut } = setup();
    expect(screen.getByText("Ctrl")).toBeInTheDocument();
    expect(screen.getByText("Space")).toBeInTheDocument();
    const change = screen.getByRole("button", { name: "Change" });
    await user.click(change);
    expect(change).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Press a shortcut…")).toBeInTheDocument();
    // A modifier alone and a key alone keep listening.
    await user.keyboard("{Control}");
    await user.keyboard("j");
    expect(onshortcut).not.toHaveBeenCalled();
    await user.keyboard("{Control>}{Alt>}j{/Alt}{/Control}");
    expect(onshortcut).toHaveBeenCalledWith("CommandOrControl+Alt+J");
    await waitFor(() => expect(change).toHaveAttribute("aria-pressed", "false"));
    expect(change).toHaveFocus();
  });

  it("keeps focus on a stepper button that reaches the end of the range", async () => {
    const user = userEvent.setup();
    const { rerender, onclose } = setup({ fontSize: 19 });
    const larger = screen.getByRole("button", { name: "Larger text" });
    larger.focus();
    await user.keyboard("{Enter}");
    await rerender({ fontSize: 20 });
    // Still focusable, so focus stays in the dialog and Escape still closes it.
    expect(larger).not.toBeDisabled();
    expect(larger).toHaveAttribute("aria-disabled", "true");
    expect(larger).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalled();
  });

  it("keeps focus on set up and the shortcut button while they work", async () => {
    const user = userEvent.setup();
    let finishSetup = () => {};
    let finishShortcut: (result: string | null) => void = () => {};
    const { onclose } = setup({
      onsetup: () => new Promise<void>((resolve) => (finishSetup = resolve)),
      onshortcut: () => new Promise<string | null>((resolve) => (finishShortcut = resolve)),
    });
    const setUp = screen.getByRole("button", { name: "Set up git files" });
    setUp.focus();
    await user.keyboard("{Enter}");
    expect(setUp).toHaveAttribute("aria-disabled", "true");
    expect(setUp).toHaveFocus();
    finishSetup();
    await waitFor(() => expect(setUp).toHaveAttribute("aria-disabled", "false"));

    const change = screen.getByRole("button", { name: "Change" });
    await user.click(change);
    await user.keyboard("{Control>}{Alt>}j{/Alt}{/Control}");
    expect(change).toHaveAttribute("aria-disabled", "true");
    expect(change).toHaveFocus();
    // Clicking while saving does not start recording again.
    await user.click(change);
    expect(change).toHaveAttribute("aria-pressed", "false");
    finishShortcut(null);
    await waitFor(() => expect(change).toHaveAttribute("aria-disabled", "false"));
    await user.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalled();
  });

  it("cancels recording with Escape without closing the dialog", async () => {
    const user = userEvent.setup();
    const { onshortcut, onclose } = setup();
    const change = screen.getByRole("button", { name: "Change" });
    await user.click(change);
    await user.keyboard("{Escape}");
    expect(onshortcut).not.toHaveBeenCalled();
    expect(onclose).not.toHaveBeenCalled();
    expect(change).toHaveAttribute("aria-pressed", "false");
    await user.click(change);
    await user.click(change);
    expect(change).toHaveAttribute("aria-pressed", "false");
  });

  it("turns the shortcut off with Backspace", async () => {
    const user = userEvent.setup();
    const { onshortcut, rerender } = setup();
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.keyboard("{Backspace}");
    expect(onshortcut).toHaveBeenCalledWith(null);
    await rerender({ shortcut: null });
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("stops recording when focus leaves", async () => {
    const user = userEvent.setup();
    setup();
    const change = screen.getByRole("button", { name: "Change" });
    await user.click(change);
    await user.tab();
    expect(change).toHaveAttribute("aria-pressed", "false");
  });

  it("says when the shortcut is taken", async () => {
    const user = userEvent.setup();
    const { onshortcut } = setup();
    onshortcut.mockResolvedValueOnce("That shortcut is in use by another app");
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.keyboard("{Control>}{Alt>}k{/Alt}{/Control}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That shortcut is in use by another app",
    );
  });

  it("says when the configured shortcut is not registered", () => {
    setup({ shortcutUnavailable: true });
    expect(screen.getByText("That shortcut is in use by another app")).toBeInTheDocument();
  });

  it("explains when quick capture cannot be configured", () => {
    setup({ captureAvailable: false });
    expect(
      screen.getByText("Quick capture is only available in the desktop app."),
    ).toBeInTheDocument();
  });

  it("copies the repository link", async () => {
    const user = userEvent.setup();
    const { oncopy } = setup();
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(oncopy).toHaveBeenCalledWith("https://github.com/carlosdlf/kaido-app");
  });
});
