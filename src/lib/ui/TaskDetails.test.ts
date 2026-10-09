import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "$lib/storage";
import { AppState, missingNoteMessage } from "./appState.svelte";
import AppShell from "./AppShell.svelte";

const ROOT = "/home/me/notes";

const files: Record<string, string> = {
  "inbox/tasks.md": [
    "- [ ] plan [note](plan.md)",
    "  why it matters  ",
    "  - [x] draft",
    "  - [ ] review",
    "- [ ] call [note](gone.md)",
    "- [ ] Ship it: v2",
    "",
  ].join("\n"),
  "inbox/plan.md": "# Plan\n",
  "inbox/drafts/old (conflict 2026-10-08 0905).md": "x",
};

async function ready() {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...files } },
    settings: JSON.stringify({ version: 1, workspace: ROOT }),
  });
  const app = new AppState(storage, { defer: (task) => task(), saveDelay: 10 });
  render(AppShell, { app });
  await app.start();
  await app.settled();
  await screen.findByRole("navigation", { name: "Workspace" });
  return { storage, app, user: userEvent.setup() };
}

const pane = () => within(screen.getByRole("main", { name: "Tasks" }));
const task = (name: string) => pane().getByRole("checkbox", { name });
const fileText = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;
const saved = (storage: MemoryStorage, path: string, text: string) =>
  waitFor(async () => expect(await fileText(storage, path)).toBe(text));
const editor = () => within(screen.getByRole("main", { name: "Editor" }));

describe("Task rows", () => {
  it("show linked notes as chips, subtask progress and a chevron for detail", async () => {
    await ready();
    expect(task("plan")).toHaveAccessibleDescription("Linked note plan 1 of 2 subtasks done");
    expect(pane().getByRole("button", { name: "Linked note plan" })).toHaveTextContent("plan");
    expect(pane().queryByText(/\[note\]/)).toBeNull();
    const missing = pane().getByRole("button", { name: /^Linked note gone\s*, missing$/ });
    expect(missing).toHaveAttribute("title", "missing");
    expect(pane().getAllByRole("button", { name: "Show detail" })).toHaveLength(1);
  });

  it("opens the linked note with Ctrl+Enter or the chip, focusing the editor", async () => {
    const { user, app } = await ready();
    task("plan").focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await app.settled();
    await waitFor(() => expect(editor().getByRole("textbox", { name: "Note text" })).toHaveFocus());
    expect(app.item).toBe("inbox/plan.md");

    await user.click(
      within(screen.getByRole("region", { name: "~/inbox" })).getByRole("button", {
        name: /tasks\.md/,
      }),
    );
    await app.settled();
    await user.click(pane().getByRole("button", { name: "Linked note plan" }));
    expect(app.item).toBe("inbox/plan.md");
  });

  it("offers to create a missing linked note", async () => {
    const { user, storage, app } = await ready();
    task("call").focus();
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect((await screen.findAllByText(missingNoteMessage("gone.md"))).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Create" }));
    await app.settled();
    expect(await fileText(storage, "inbox/gone.md")).toBe("# call\n");
    expect(app.item).toBe("inbox/gone.md");
  });
});

describe("Task detail", () => {
  it("expands with → into a text area; Ctrl+Enter saves and collapses", async () => {
    const { user, storage } = await ready();
    task("plan").focus();
    await user.keyboard("{ArrowRight}");
    const field = pane().getByRole("textbox", { name: "Detail of plan" });
    expect(field).toHaveFocus();
    expect(field).toHaveValue("why it matters  ");
    expect(pane().getByRole("button", { name: "Hide detail" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await user.keyboard("{End}{Enter}{Enter}more");
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(pane().queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(task("plan")).toHaveFocus());
    await saved(
      storage,
      "inbox/tasks.md",
      [
        "- [ ] plan [note](plan.md)",
        "  why it matters  ",
        "",
        "  more",
        "  - [x] draft",
        "  - [ ] review",
        "- [ ] call [note](gone.md)",
        "- [ ] Ship it: v2",
        "",
      ].join("\n"),
    );
  });

  it("collapses with ← and Escape, saves on blur, and adds detail to a task without one", async () => {
    const { user, storage } = await ready();
    await user.click(pane().getByRole("button", { name: "Show detail" }));
    await user.keyboard("{Escape}");
    expect(pane().queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(task("plan")).toHaveFocus());
    // ← only leaves the detail from the very start of the text, with nothing selected.
    await user.keyboard("{ArrowRight}");
    const area = pane().getByRole("textbox", { name: "Detail of plan" }) as HTMLTextAreaElement;
    area.setSelectionRange(3, 3);
    await user.keyboard("{ArrowLeft}");
    expect(area).toBeInTheDocument();
    area.setSelectionRange(0, 2);
    await user.keyboard("{ArrowLeft}");
    expect(area).toBeInTheDocument();
    area.setSelectionRange(0, 0);
    fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
    expect(area).toBeInTheDocument();
    fireEvent.keyDown(area, { key: "ArrowLeft" });
    expect(pane().queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(task("plan")).toHaveFocus());

    task("Ship it: v2").focus();
    await user.keyboard("{ArrowRight}");
    await user.keyboard("first detail");
    // Leaving the window keeps it open; leaving the field saves.
    const field = pane().getByRole("textbox", { name: "Detail of Ship it: v2" });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.blur(field);
    hasFocus.mockRestore();
    expect(field).toBeInTheDocument();
    await user.click(pane().getByText("call"));
    expect(pane().queryByRole("textbox")).toBeNull();
    await waitFor(async () =>
      expect(await fileText(storage, "inbox/tasks.md")).toContain(
        "- [ ] Ship it: v2\n  first detail\n",
      ),
    );
    // Subtasks have no detail.
    task("review").focus();
    await user.keyboard("{ArrowRight}");
    expect(pane().queryByRole("textbox")).toBeNull();
  });
});

describe("Task detail, review fixes", () => {
  it("writes nothing when the detail is opened and closed unchanged", async () => {
    const { user, storage, app } = await ready();
    const write = vi.spyOn(storage, "writeFile");
    task("plan").focus();
    await user.keyboard("{ArrowRight}{Control>}{Enter}{/Control}");
    await user.keyboard("{ArrowRight}{Escape}");
    await user.click(pane().getByRole("button", { name: "Show detail" }));
    await user.click(pane().getByText("call", { selector: ".text" }));
    await app.settled();
    expect(write).not.toHaveBeenCalled();
    expect(await fileText(storage, "inbox/tasks.md")).toBe(files["inbox/tasks.md"]);
  });

  it("collapses when the chevron is clicked while the detail is open", async () => {
    const { user } = await ready();
    await user.click(pane().getByRole("button", { name: "Show detail" }));
    expect(pane().getByRole("textbox", { name: "Detail of plan" })).toHaveFocus();
    await user.click(pane().getByRole("button", { name: "Hide detail" }));
    expect(pane().queryByRole("textbox")).toBeNull();
    expect(pane().getByRole("button", { name: "Show detail" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await waitFor(() => expect(task("plan")).toHaveFocus());
  });

  it("saves a draft to the task found by its text when the list changes meanwhile", async () => {
    const { user, storage, app } = await ready();
    task("Ship it: v2").focus();
    await user.keyboard("{ArrowRight}");
    await user.keyboard("keep me");
    storage.setExternal("inbox/tasks.md", `- [ ] zero\n${files["inbox/tasks.md"] ?? ""}`);
    await app.settled();
    await waitFor(() => expect(pane().queryByRole("textbox")).toBeNull());
    expect(screen.queryAllByText(/changed on disk/)).toHaveLength(0);
    await waitFor(async () =>
      expect(await fileText(storage, "inbox/tasks.md")).toContain("- [ ] Ship it: v2\n  keep me\n"),
    );
  });

  it("keeps a hard break in a detail line it did not change", async () => {
    const { user, storage } = await ready();
    task("plan").focus();
    await user.keyboard(
      "{ArrowRight}{Control>}{End}{/Control}{Enter}second{Control>}{Enter}{/Control}",
    );
    await waitFor(async () =>
      expect(await fileText(storage, "inbox/tasks.md")).toContain(
        "  why it matters  \n  second\n  - [x] draft",
      ),
    );
  });
});

describe("New subtasks", () => {
  it("indents the new task with Tab and outdents it with Shift+Tab", async () => {
    const { user, storage } = await ready();
    task("Ship it: v2").focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Tab}");
    const input = pane().getByRole("textbox", { name: "New subtask" });
    expect(input).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(pane().getByRole("textbox", { name: "New subtask" })).toHaveFocus();
    await user.keyboard("step one{Enter}");
    await waitFor(() => expect(pane().getByRole("textbox", { name: "New subtask" })).toHaveFocus());
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(pane().getByRole("textbox", { name: "New task" })).toHaveFocus();
    await user.keyboard("next{Enter}{Escape}");
    await saved(
      storage,
      "inbox/tasks.md",
      `${files["inbox/tasks.md"] ?? ""}  - [ ] step one\n- [ ] next\n`,
    );
    expect(task("step one").closest("li")).toHaveClass("nested");
  });
});

describe("Task context menu", () => {
  it("opens with Shift+F10 and right-click, with the task actions", async () => {
    const { user } = await ready();
    task("Ship it: v2").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = within(screen.getByRole("menu", { name: "Task actions" }));
    expect(menu.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "Edit F2",
      "Create note from task",
      "Copy text",
      "Delete Del",
    ]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(task("Ship it: v2")).toHaveFocus());

    fireEvent.contextMenu(pane().getByText("plan", { selector: ".text" }));
    const linked = within(screen.getByRole("menu", { name: "Task actions" }));
    expect(linked.getByRole("menuitem", { name: /Open note/ })).toBeInTheDocument();
    await user.click(linked.getByRole("menuitem", { name: /Edit/ }));
    expect(pane().getByRole("textbox", { name: "Edit task" })).toHaveValue("plan [note](plan.md)");
  });

  it("creates a note from the task, links it and opens it", async () => {
    const { user, storage, app } = await ready();
    task("Ship it: v2").focus();
    await user.keyboard("{ContextMenu}");
    await user.click(screen.getByRole("menuitem", { name: "Create note from task" }));
    await app.settled();
    expect(await fileText(storage, "inbox/Ship it v2.md")).toBe("# Ship it: v2\n");
    expect(app.item).toBe("inbox/Ship it v2.md");
    await waitFor(() => expect(editor().getByRole("textbox", { name: "Note text" })).toHaveFocus());
    await waitFor(async () =>
      expect(await fileText(storage, "inbox/tasks.md")).toContain(
        "- [ ] Ship it: v2 [note](Ship%20it%20v2.md)\n",
      ),
    );
  });

  it("copies the text, opens the note and deletes from the menu", async () => {
    const { user, app } = await ready();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      task("call").focus();
      await user.keyboard("{Shift>}{F10}{/Shift}");
      await user.click(screen.getByRole("menuitem", { name: "Copy text" }));
      expect(writeText).toHaveBeenCalledWith("call [note](gone.md)");
      expect((await screen.findAllByText("Copied the task text")).length).toBeGreaterThan(0);

      await user.keyboard("{Shift>}{F10}{/Shift}");
      await user.click(screen.getByRole("menuitem", { name: /Open note/ }));
      expect((await screen.findAllByText(missingNoteMessage("gone.md"))).length).toBeGreaterThan(0);

      task("call").focus();
      await user.keyboard("{Shift>}{F10}{/Shift}");
      await user.click(screen.getByRole("menuitem", { name: /Delete/ }));
      expect(pane().queryByRole("checkbox", { name: "call" })).toBeNull();

      task("plan").focus();
      await user.keyboard("{Shift>}{F10}{/Shift}");
      await user.click(screen.getByRole("menuitem", { name: /Open note/ }));
      expect(app.item).toBe("inbox/plan.md");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});

describe("List and sidebar icons", () => {
  it("marks conflict copies and dims the folder of notes in subfolders", async () => {
    await ready();
    const list = within(screen.getByRole("region", { name: "~/inbox" }));
    const conflict = list.getByRole("button", { name: /old \(conflict/ });
    expect(conflict.querySelector("[title='Conflict copy'] svg")).not.toBeNull();
    expect(within(conflict).getByText("drafts/")).toHaveClass("folder");
    const icons = screen.getByRole("navigation").querySelectorAll("svg[aria-hidden='true']");
    expect(icons.length).toBeGreaterThanOrEqual(3);
  });
});
