import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SetupBanner from "./SetupBanner.svelte";

function setup(onsetup: () => Promise<void> = async () => undefined) {
  const outside = document.createElement("button");
  outside.textContent = "outside";
  document.body.append(outside);
  const handlers = { onsetup: vi.fn(onsetup), ondismiss: vi.fn(), onfocusexit: vi.fn() };
  const result = render(SetupBanner, handlers);
  return { ...handlers, ...result, outside };
}

describe("SetupBanner", () => {
  it("keeps Set up focused and ignores clicks while it works", async () => {
    const user = userEvent.setup();
    let finish = () => {};
    const { onsetup, ondismiss, outside } = setup(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const setUp = screen.getByRole("button", { name: "Set up" });
    const notNow = screen.getByRole("button", { name: "Not now" });
    await user.click(setUp);
    expect(setUp).toHaveAttribute("aria-disabled", "true");
    expect(setUp).toHaveFocus();
    await user.click(setUp);
    await user.click(notNow);
    expect(onsetup).toHaveBeenCalledTimes(1);
    expect(ondismiss).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(setUp).toHaveAttribute("aria-disabled", "false"));
    outside.remove();
  });

  it("gives focus back to where it came from when it goes away", async () => {
    const { unmount, outside, onfocusexit } = setup();
    outside.focus();
    screen.getByRole("button", { name: "Not now" }).focus();
    unmount();
    expect(outside).toHaveFocus();
    expect(onfocusexit).not.toHaveBeenCalled();
    outside.remove();
  });

  it("asks the caller where focus goes when it came from nowhere", () => {
    const { unmount, outside, onfocusexit } = setup();
    screen.getByRole("button", { name: "Set up" }).focus();
    // Moving between its own buttons keeps focus inside.
    screen.getByRole("button", { name: "Not now" }).focus();
    unmount();
    expect(onfocusexit).toHaveBeenCalledTimes(1);
    outside.remove();
  });

  it("leaves focus alone once it moved elsewhere", () => {
    const { unmount, outside, onfocusexit } = setup();
    screen.getByRole("button", { name: "Set up" }).focus();
    outside.focus();
    unmount();
    expect(outside).toHaveFocus();
    expect(onfocusexit).not.toHaveBeenCalled();
    outside.remove();
  });

  it("does nothing on unmount when it never had focus", () => {
    const { unmount, outside, onfocusexit } = setup();
    unmount();
    expect(onfocusexit).not.toHaveBeenCalled();
    outside.remove();
  });
});
