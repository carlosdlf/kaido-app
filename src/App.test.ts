import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App.svelte";

describe("App", () => {
  it("runs on the sample workspace outside the desktop app", async () => {
    const user = userEvent.setup();
    const { unmount } = render(App);
    await user.click(await screen.findByRole("button", { name: "Open folder…" }));
    expect(await screen.findByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
    unmount();
  });
});
