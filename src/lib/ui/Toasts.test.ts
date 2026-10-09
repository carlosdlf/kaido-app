import { fireEvent, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Toast } from "./appState.svelte";
import Toasts from "./Toasts.svelte";

function renderToasts(toasts: Toast[], duration = 8_000) {
  const ondismiss = vi.fn();
  const onaction = vi.fn();
  const onfocusexit = vi.fn();
  const view = render(Toasts, { toasts, ondismiss, onaction, onfocusexit, duration });
  return { view, ondismiss, onaction, onfocusexit };
}

const undoToast: Toast = { id: 1, message: "Deleted a.md", action: "Undo" };
const plainToast: Toast = { id: 2, message: "Saved elsewhere" };

afterEach(() => {
  vi.useRealTimers();
});

describe("Toasts", () => {
  it("shows an action button that runs the action", async () => {
    const user = userEvent.setup();
    const { onaction, ondismiss } = renderToasts([undoToast, plainToast]);
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toHaveAccessibleDescription("Deleted a.md");
    expect(undo).toHaveAttribute("aria-keyshortcuts", "Control+Z Meta+Z");
    await user.click(undo);
    expect(onaction).toHaveBeenCalledWith(1);
    await user.click(screen.getAllByRole("button", { name: "Dismiss" })[1] as HTMLElement);
    expect(ondismiss).toHaveBeenCalledWith(2);
  });

  it("announces only the messages, not the buttons", () => {
    renderToasts([undoToast, plainToast]);
    const region = screen.getByRole("region", { name: "Notifications" });
    const status = within(region).getByRole("status");
    expect(status).toHaveTextContent("Deleted a.mdSaved elsewhere");
    expect(within(status).queryAllByRole("button")).toEqual([]);
    expect(region).not.toHaveAttribute("aria-live");
    // The visible copies are not read a second time.
    const visible = within(region)
      .getAllByText("Deleted a.md")
      .filter((node) => !status.contains(node));
    expect(visible).toHaveLength(1);
    expect(visible[0]).toHaveAttribute("aria-hidden", "true");
  });

  it("undoes with Ctrl+Z or Cmd+Z while a toast with an action is focused", async () => {
    const user = userEvent.setup();
    const { onaction } = renderToasts([undoToast, plainToast]);
    const [first, second] = screen.getAllByRole("button", { name: "Dismiss" });
    first?.focus();
    await user.keyboard("{Control>}z{/Control}");
    expect(onaction).toHaveBeenCalledTimes(1);
    await user.keyboard("{Meta>}z{/Meta}");
    expect(onaction).toHaveBeenCalledTimes(2);
    await user.keyboard("z{Control>}{Shift>}z{/Shift}{/Control}");
    expect(onaction).toHaveBeenCalledTimes(2);
    second?.focus();
    await user.keyboard("{Control>}z{/Control}");
    expect(onaction).toHaveBeenCalledTimes(2);
  });

  it("dismisses after the duration, but not while hovered or focused", async () => {
    vi.useFakeTimers();
    const { ondismiss } = renderToasts([undoToast], 1_000);
    const toast = screen.getByRole("button", { name: "Undo" }).parentElement as HTMLElement;

    await fireEvent.pointerEnter(toast);
    vi.advanceTimersByTime(5_000);
    expect(ondismiss).not.toHaveBeenCalled();
    await fireEvent.pointerLeave(toast);

    const undo = screen.getByRole("button", { name: "Undo" });
    undo.focus();
    vi.advanceTimersByTime(5_000);
    expect(ondismiss).not.toHaveBeenCalled();
    // Moving within the toast keeps it.
    screen.getByRole("button", { name: "Dismiss" }).focus();
    vi.advanceTimersByTime(5_000);
    expect(ondismiss).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "Dismiss" }).blur();
    vi.advanceTimersByTime(999);
    expect(ondismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ondismiss).toHaveBeenCalledWith(1);
  });

  it("moves focus to the next toast when the focused one goes away", async () => {
    const { view, onfocusexit } = renderToasts([undoToast, plainToast]);
    screen.getByRole("button", { name: "Undo" }).focus();
    await view.rerender({ toasts: [plainToast] });
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
    expect(onfocusexit).not.toHaveBeenCalled();

    await view.rerender({ toasts: [] });
    expect(onfocusexit).toHaveBeenCalledOnce();
  });

  it("leaves focus alone when it was elsewhere", async () => {
    const { view, onfocusexit } = renderToasts([undoToast]);
    await view.rerender({ toasts: [] });
    expect(onfocusexit).not.toHaveBeenCalled();
  });
});
