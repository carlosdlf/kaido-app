import { render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NewWorkspaceOutcome, PickedFolder } from "./appState.svelte";
import StartScreen from "./StartScreen.svelte";

type Props = Parameters<typeof render<typeof StartScreen>>[1];

function setup(props: Partial<NonNullable<Props>> = {}) {
  const handlers = {
    onpick: vi.fn(),
    onopenrecent: vi.fn(),
    onremoverecent: vi.fn(),
    onpickfolder: vi.fn(async (): Promise<PickedFolder> => ({ kind: "picked", path: "/home/me" })),
    oncreate: vi.fn(async (): Promise<NewWorkspaceOutcome> => ({ kind: "opened" })),
    onclone: vi.fn(async (): Promise<NewWorkspaceOutcome> => ({ kind: "opened" })),
    oncancelclone: vi.fn(),
    onback: vi.fn(),
  };
  const result = render(StartScreen, {
    title: "Open a workspace",
    message: "Choose a folder.",
    ...handlers,
    ...props,
  });
  return { ...handlers, ...result };
}

describe("StartScreen", () => {
  it("focuses Open folder and shows the git line", () => {
    setup({ git: { available: true, version: "2.43.0" } });
    expect(screen.getByRole("button", { name: "Open folder…" })).toHaveFocus();
    expect(screen.getByText("git 2.43.0 found")).toBeInTheDocument();
  });

  it("warns without git, never blocking", () => {
    setup({ git: { available: false, version: null } });
    expect(
      screen.getByText("git not found — Kaido works, but sync is off. Install git to sync."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open folder…" })).toBeEnabled();
  });

  it("says git was found without a version", () => {
    setup({ git: { available: true, version: null } });
    expect(screen.getByText("git found")).toBeInTheDocument();
  });

  it("shows only the title and message while busy", () => {
    setup({ busy: true, recents: ["/a"] });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  });

  it("shows errors as alerts", () => {
    setup({ error: true, message: "Nope" });
    expect(screen.getByRole("alert")).toHaveTextContent("Nope");
  });

  it("opens a folder", async () => {
    const user = userEvent.setup();
    const { onpick } = setup();
    await user.click(screen.getByRole("button", { name: "Open folder…" }));
    expect(onpick).toHaveBeenCalled();
  });

  it("creates a workspace in a chosen folder", async () => {
    const user = userEvent.setup();
    const { oncreate, onpickfolder } = setup();
    await user.click(screen.getByRole("button", { name: "Create new…" }));
    const form = within(screen.getByRole("form", { name: "Create a new workspace" }));
    expect(form.getByRole("button", { name: /Choose…/ })).toHaveFocus();
    expect(form.getByText("no folder chosen")).toBeInTheDocument();
    await user.click(form.getByRole("button", { name: /Choose…/ }));
    expect(onpickfolder).toHaveBeenCalled();
    expect(form.getByText("/home/me")).toBeInTheDocument();
    const name = form.getByRole("textbox", { name: "Folder name" });
    expect(name).toHaveValue("notes");
    await user.clear(name);
    await user.type(name, "work{Enter}");
    expect(oncreate).toHaveBeenCalledWith("/home/me", "work");
  });

  it("shows why creating failed and keeps the form", async () => {
    const user = userEvent.setup();
    const { oncreate, onpickfolder } = setup();
    oncreate.mockResolvedValueOnce({ kind: "invalid", message: "The folder is not empty." });
    onpickfolder.mockResolvedValueOnce({ kind: "failed", message: "No dialog" });
    await user.click(screen.getByRole("button", { name: "Create new…" }));
    await user.click(screen.getByRole("button", { name: /Choose…/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("No dialog");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The folder is not empty.");
    expect(screen.getByRole("textbox", { name: "Folder name" })).toHaveValue("notes");
  });

  it("closes the form with Escape and Cancel, returning focus", async () => {
    const user = userEvent.setup();
    setup();
    const create = screen.getByRole("button", { name: "Create new…" });
    await user.click(create);
    expect(create).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("form")).toBeNull();
    expect(create).toHaveFocus();
    const clone = screen.getByRole("button", { name: "Clone from URL…" });
    await user.click(clone);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(clone).toHaveFocus();
  });

  it("clones with the folder name taken from the URL until it is edited", async () => {
    const user = userEvent.setup();
    const { onclone } = setup();
    await user.click(screen.getByRole("button", { name: "Clone from URL…" }));
    const form = within(screen.getByRole("form", { name: "Clone a repository" }));
    const url = form.getByRole("textbox", { name: "Repository URL" });
    expect(url).toHaveFocus();
    await user.type(url, "git@github.com:me/work-notes.git");
    const name = form.getByRole("textbox", { name: "Folder name" });
    expect(name).toHaveValue("work-notes");
    await user.click(form.getByRole("button", { name: /Choose…/ }));
    await user.click(form.getByRole("button", { name: "Clone" }));
    expect(onclone).toHaveBeenCalledWith(
      "git@github.com:me/work-notes.git",
      "/home/me",
      "work-notes",
    );

    await user.clear(name);
    await user.type(name, "mine");
    await user.type(url, "x");
    expect(name).toHaveValue("mine");
  });

  it("shows progress while cloning and cancels it", async () => {
    const user = userEvent.setup();
    let finish: (outcome: NewWorkspaceOutcome) => void = () => undefined;
    const { onclone, oncancelclone } = setup();
    onclone.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await user.click(screen.getByRole("button", { name: "Clone from URL…" }));
    await user.type(screen.getByRole("textbox", { name: "Repository URL" }), "https://h/n.git");
    await user.click(screen.getByRole("button", { name: "Clone" }));
    expect(screen.getByRole("status")).toHaveTextContent("Cloning…");
    expect(screen.getByRole("textbox", { name: "Repository URL" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(oncancelclone).toHaveBeenCalledTimes(1);
    screen.getByRole("button", { name: "Cancel" }).focus();
    await user.keyboard("{Escape}");
    expect(oncancelclone).toHaveBeenCalledTimes(2);
    finish({ kind: "cancelled" });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Cloning was cancelled."),
    );
    expect(screen.getByRole("textbox", { name: "Repository URL" })).toHaveValue("https://h/n.git");
  });

  it("opens and removes recent workspaces, marking missing ones", async () => {
    const user = userEvent.setup();
    const { onopenrecent, onremoverecent } = setup({
      recents: ["/home/me/notes", "/old/gone"],
      missing: new Set(["/old/gone"]),
    });
    const recents = within(screen.getByRole("region", { name: "Recent workspaces" }));
    const gone = recents.getByRole("button", { name: /^gone/ });
    expect(gone).toHaveTextContent("not found");
    expect(gone).toHaveAccessibleDescription("The folder was not found.");
    await user.click(recents.getByRole("button", { name: /^notes/ }));
    expect(onopenrecent).toHaveBeenCalledWith("/home/me/notes");
    recents.getByRole("button", { name: /^notes/ }).focus();
    await user.keyboard("{Enter}");
    expect(onopenrecent).toHaveBeenCalledTimes(2);
    await user.click(recents.getByRole("button", { name: "Remove gone from recent workspaces" }));
    expect(onremoverecent).toHaveBeenCalledWith("/old/gone");
  });

  it("goes back to the open workspace", async () => {
    const user = userEvent.setup();
    const { onback } = setup({ current: "/home/me/notes" });
    await user.click(screen.getByRole("button", { name: "← back to notes" }));
    expect(onback).toHaveBeenCalled();
  });
});
