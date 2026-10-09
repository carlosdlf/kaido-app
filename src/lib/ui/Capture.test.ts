import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCaptureBus, type CaptureSubmit } from "$lib/storage";
import Capture, {
  CAPTURE_HEIGHT,
  CAPTURE_ROW_HEIGHT,
  NO_ANSWER,
  NO_WORKSPACE,
  RESULT_TIMEOUT,
} from "./Capture.svelte";

function setup(projects: string[] = ["inbox", "api", "web"], workspaceOpen = true) {
  const bus = new MemoryCaptureBus();
  const submits: CaptureSubmit[] = [];
  const requests = vi.fn(() => {
    void bus.host.sendProjects({ projects, workspaceOpen });
  });
  void bus.host.onSubmit((submit) => submits.push(submit));
  void bus.host.onProjectsRequest(requests);
  render(Capture, { channel: bus.channel });
  bus.show();
  return { bus, submits, requests, user: userEvent.setup({ delay: null }) };
}

const input = () => screen.getByRole("textbox", { name: "Capture a task or note" });
const chip = () => screen.getByRole("button", { name: /Project:/ });
const picker = () => screen.getByRole("combobox", { name: "Choose a project" });
const options = () => screen.queryAllByRole("option");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Capture", () => {
  it("asks for the projects and focuses the input when shown", async () => {
    const { requests } = setup();
    expect(requests).toHaveBeenCalled();
    await waitFor(() => expect(input()).toHaveFocus());
    expect(chip()).toHaveTextContent("inbox");
    expect(input()).toHaveAccessibleDescription(/Enter adds a task, Shift\+Enter creates a note/);
  });

  it("adds a task with Enter and hides right away", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "  buy milk ");
    await user.keyboard("{Enter}");
    expect(submits).toEqual([
      { id: expect.any(String), kind: "task", text: "buy milk", project: "inbox" },
    ]);
    expect(bus.visible).toBe(false);
    expect(input()).toHaveValue("");
    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: true, message: "Added to inbox" });
    expect(bus.visible).toBe(false);
  });

  it("creates a note with Shift+Enter", async () => {
    const { submits, user } = setup();
    await user.type(input(), "idea");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(submits[0]).toMatchObject({ kind: "note", text: "idea" });
  });

  it("ignores empty text", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "   ");
    await user.keyboard("{Enter}");
    expect(submits).toEqual([]);
    expect(bus.visible).toBe(true);
  });

  it("hides on Escape, keeping typed text for the next time", async () => {
    const { bus, user } = setup();
    await user.type(input(), "half a thought");
    await user.keyboard("{Escape}");
    expect(bus.visible).toBe(false);
    bus.show();
    expect(input()).toHaveValue("half a thought");
  });

  it("drops text that is only spaces when it hides", async () => {
    const { bus, user } = setup();
    await user.type(input(), "  ");
    fireEvent.blur(window);
    expect(bus.visible).toBe(false);
    expect(input()).toHaveValue("");
  });

  it("chooses a project with Tab, typing to filter, and remembers it", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "deploy");
    await user.keyboard("{Tab}");
    expect(picker()).toHaveFocus();
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    expect(options().map((option) => option.textContent?.trim())).toEqual(["inbox", "api", "web"]);
    expect(bus.height).toBe(CAPTURE_HEIGHT + CAPTURE_ROW_HEIGHT * 4);

    await user.keyboard("w");
    expect(options().map((option) => option.textContent?.trim())).toEqual(["web"]);
    expect(picker()).toHaveAttribute("aria-activedescendant", options()[0]?.id);
    await user.keyboard("{Enter}");
    expect(input()).toHaveFocus();
    expect(chip()).toHaveTextContent("web");
    expect(bus.height).toBe(CAPTURE_HEIGHT);

    await user.keyboard("{Enter}");
    expect(submits[0]).toMatchObject({ text: "deploy", project: "web" });
    bus.show();
    expect(chip()).toHaveTextContent("web");
  });

  it("moves through projects with the arrows and goes back with Escape", async () => {
    const { user } = setup();
    await user.keyboard("{Tab}");
    const selected = () => options().find((option) => option.ariaSelected === "true");
    expect(selected()).toHaveTextContent("inbox");
    await user.keyboard("{ArrowUp}");
    expect(selected()).toHaveTextContent("web");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(selected()).toHaveTextContent("api");
    await user.keyboard("{Escape}");
    expect(input()).toHaveFocus();
    expect(chip()).toHaveTextContent("inbox");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("opens the picker from the chip and picks with the mouse", async () => {
    const { user } = setup();
    await user.click(chip());
    expect(picker()).toHaveFocus();
    await user.click(chip());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await user.click(chip());
    const api = options()[1];
    if (!api) throw new Error("no option");
    await user.click(api);
    expect(chip()).toHaveTextContent("api");
  });

  it("says when no project matches", async () => {
    const { user } = setup();
    await user.keyboard("{Tab}zzz");
    expect(options()).toEqual([]);
    expect(screen.getByText("No matching project")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(picker()).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(input()).toHaveFocus();
  });

  it("falls back to the first project when the chosen one is gone", async () => {
    const { bus, user } = setup();
    await user.keyboard("{Tab}web{Enter}");
    await bus.host.sendProjects({ projects: ["inbox", "api"], workspaceOpen: true });
    expect(chip()).toHaveTextContent("inbox");
    await bus.host.sendProjects({ projects: [], workspaceOpen: true });
    expect(chip()).toHaveTextContent("inbox");
  });

  it("shows the text again with the reason when capturing failed", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "buy milk{Enter}");
    // A result for another capture is not this one's.
    await bus.host.sendResult({ id: "other", ok: false, message: "No" });
    expect(bus.visible).toBe(false);
    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: false, message: "Disk full" });
    await waitFor(() => expect(bus.visible).toBe(true));
    expect(input()).toHaveValue("buy milk");
    expect(screen.getByRole("alert")).toHaveTextContent("Disk full");
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(bus.height).toBe(CAPTURE_HEIGHT + CAPTURE_ROW_HEIGHT);
    await waitFor(() => expect(input()).toHaveFocus());

    // Typing clears the message.
    await user.type(input(), "!");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps an earlier capture's text when a later one was sent before it failed", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "first{Enter}");
    bus.show();
    await user.type(input(), "second{Enter}");
    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: false, message: "Disk full" });
    await waitFor(() => expect(bus.visible).toBe(true));
    expect(screen.getByRole("alert")).toHaveTextContent("Disk full");
    expect(input()).toHaveValue("first");
    // The second capture is still waiting for its own answer.
    await bus.host.sendResult({ id: submits[1]?.id ?? "", ok: true, message: "Added to inbox" });
    expect(input()).toHaveValue("first");
    await vi.advanceTimersByTimeAsync(RESULT_TIMEOUT);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("holds a failed capture's text when the input has newer text", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "first{Enter}");
    bus.show();
    await user.type(input(), "second");
    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: false, message: "No" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No"));
    expect(input()).toHaveValue("second");
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(bus.height).toBe(CAPTURE_HEIGHT + CAPTURE_ROW_HEIGHT * 2);

    // Restoring swaps: the draft is held in its place.
    await user.click(screen.getByRole("button", { name: /restore/ }));
    expect(input()).toHaveValue("first");
    expect(input()).toHaveFocus();
    expect(screen.getByText("second")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(submits[1]).toMatchObject({ text: "first" });
    bus.show();
    await user.keyboard("{ArrowUp}");
    expect(input()).toHaveValue("second");
    expect(screen.queryByRole("button", { name: /restore/ })).not.toBeInTheDocument();
    expect(bus.height).toBe(CAPTURE_HEIGHT);
  });

  it("restores held texts oldest first with the up arrow in an empty input", async () => {
    const { bus, submits, user } = setup();
    for (const value of ["one", "two", "three"]) {
      await user.type(input(), `${value}{Enter}`);
      bus.show();
    }
    await user.type(input(), "draft");
    for (const submit of submits) {
      await bus.host.sendResult({ id: submit.id, ok: false, message: "No" });
    }
    await waitFor(() => expect(screen.getByText("+2")).toBeInTheDocument());
    // The arrow does nothing while there is text.
    await user.keyboard("{ArrowUp}");
    expect(input()).toHaveValue("draft");
    await user.clear(input());
    await user.keyboard("{ArrowUp}");
    expect(input()).toHaveValue("one");
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("drops restored text when a capture that timed out is added after all", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "late{Enter}");
    await vi.advanceTimersByTimeAsync(RESULT_TIMEOUT);
    expect(screen.getByRole("alert")).toHaveTextContent(NO_ANSWER);
    expect(input()).toHaveValue("late");

    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: true, message: "Added to inbox" });
    expect(input()).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Added to inbox");
    // Sending it again would add it twice; nothing is left to send.
    await user.keyboard("{Enter}");
    expect(submits).toHaveLength(1);
    // A second answer for the same capture changes nothing.
    await user.type(input(), "new");
    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: true, message: "Added to inbox" });
    expect(input()).toHaveValue("new");
  });

  it("keeps restored text that was edited when the late answer comes", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "late{Enter}");
    await vi.advanceTimersByTimeAsync(RESULT_TIMEOUT);
    await user.type(input(), " and more");
    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: true, message: "Added to inbox" });
    expect(input()).toHaveValue("late and more");
    expect(screen.getByRole("status")).toHaveTextContent("Added to inbox");
  });

  it("drops a held text when its timed-out capture is added after all", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "late{Enter}");
    bus.show();
    await user.type(input(), "draft");
    await vi.advanceTimersByTimeAsync(RESULT_TIMEOUT);
    expect(screen.getByText("late")).toBeInTheDocument();
    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: true, message: "Added to inbox" });
    expect(screen.queryByText("late")).not.toBeInTheDocument();
    expect(input()).toHaveValue("draft");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("gives the reason when a capture that timed out fails later", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "late{Enter}");
    await vi.advanceTimersByTimeAsync(RESULT_TIMEOUT);
    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: false, message: "Disk full" });
    expect(screen.getByRole("alert")).toHaveTextContent("Disk full");
    expect(input()).toHaveValue("late");
  });

  it("clears the late success message when typing or hiding", async () => {
    const { bus, submits, user } = setup();
    await user.type(input(), "late{Enter}");
    await vi.advanceTimersByTimeAsync(RESULT_TIMEOUT);
    await bus.host.sendResult({ id: submits[0]?.id ?? "", ok: true, message: "Added to inbox" });
    await user.type(input(), "x");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await user.clear(input());
    await user.type(input(), "again{Enter}");
    await vi.advanceTimersByTimeAsync(RESULT_TIMEOUT);
    await bus.host.sendResult({ id: submits[1]?.id ?? "", ok: true, message: "Added to inbox" });
    expect(screen.getByRole("status")).toHaveTextContent("Added to inbox");
    await user.keyboard("{Escape}");
    bus.show();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the text when the backend refuses a capture", async () => {
    const { bus, user } = setup();
    bus.channel.submit = () => Promise.reject({ kind: "TooLarge", message: "Text is too long." });
    await user.type(input(), "huge{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Text is too long."));
    expect(input()).toHaveValue("huge");
  });

  it("says when the main window does not answer", async () => {
    const { bus, user } = setup();
    await user.type(input(), "lost{Enter}");
    await vi.advanceTimersByTimeAsync(RESULT_TIMEOUT);
    expect(bus.visible).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent(NO_ANSWER);
    expect(input()).toHaveValue("lost");
  });

  it("says when sending fails", async () => {
    const { bus, user } = setup();
    bus.channel.submit = () => Promise.reject(new Error("event denied"));
    await user.type(input(), "lost{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("event denied"));
    expect(bus.visible).toBe(true);
    expect(input()).toHaveValue("lost");
    // The timeout of that capture does nothing more.
    await vi.advanceTimersByTimeAsync(RESULT_TIMEOUT);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("asks to open a workspace first", async () => {
    const { bus, submits } = setup([], false);
    expect(screen.getByRole("status")).toHaveTextContent(NO_WORKSPACE);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "a" });
    expect(bus.visible).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(bus.visible).toBe(false);
    expect(submits).toEqual([]);
  });
});
