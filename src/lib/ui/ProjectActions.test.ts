import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "$lib/storage";
import { AppState } from "./appState.svelte";
import AppShell from "./AppShell.svelte";

const ROOT = "/home/me/notes";

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] read [spec](../api/spec.md)\n",
  "inbox/idea.md": "# Idea\n",
  "api/tasks.md": "- [ ] ship\n  - [ ] sub\n",
  "api/spec.md": "# Spec\n",
  "api/docs/deep.md": "# Deep\n",
  "web/tasks.md": "- [ ] w\n",
  "_archive/old/n.md": "# Old note\n",
};

async function ready(extra: Record<string, string> = {}) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...files, ...extra } },
    settings: JSON.stringify({ version: 1, workspace: ROOT }),
  });
  const app = new AppState(storage, { defer: (task) => task(), saveDelay: 10 });
  render(AppShell, { app });
  await app.start();
  await app.settled();
  await screen.findByRole("navigation", { name: "Workspace" });
  return { storage, app, user: userEvent.setup() };
}

const nav = () => within(screen.getByRole("navigation", { name: "Workspace" }));
const projectRow = (name: string) => nav().getByRole("button", { name });
const list = () => within(screen.getByRole("region", { name: (name) => name !== "Notifications" }));
const fileText = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;
const exists = (storage: MemoryStorage, path: string) =>
  storage.folders.get(ROOT)?.has(path) ?? false;
const menuItems = () =>
  within(screen.getByRole("menu", { name: "Project actions" }))
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.replace(/\s+/g, " ").trim());

describe("Sidebar project actions", () => {
  it("opens the project menu with Shift+F10, the ContextMenu key and right-click", async () => {
    const { user } = await ready();
    projectRow("api").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(menuItems()).toEqual(["Rename F2", "Archive", "Copy path", "Delete… Del"]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(projectRow("api")).toHaveFocus());
    await user.keyboard("{ContextMenu}");
    expect(screen.getByRole("menu", { name: "Project actions" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    // Neither the inbox nor All tasks has one.
    fireEvent.contextMenu(nav().getByRole("button", { name: /inbox/ }));
    expect(screen.queryByRole("menu", { name: "Project actions" })).toBeNull();
    nav().getByRole("button", { name: /inbox/ }).focus();
    await user.keyboard("{F2}{Delete}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renames inline with F2: Enter commits, errors show, Escape cancels", async () => {
    const { user, storage, app } = await ready();
    projectRow("api").focus();
    await user.keyboard("{F2}");
    const field = nav().getByRole("textbox", { name: "Rename project api" });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "web{Enter}");
    expect(await nav().findByRole("alert")).toHaveTextContent(
      "A project named web already exists.",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(projectRow("api")).toHaveFocus());

    await user.keyboard("{F2}");
    await user.clear(nav().getByRole("textbox", { name: "Rename project api" }));
    await user.keyboard("backend{Enter}");
    await app.settled();
    await waitFor(() => expect(projectRow("backend")).toHaveFocus());
    expect(exists(storage, "backend/spec.md")).toBe(true);
    expect(screen.getAllByText("Renamed project api to backend").length).toBeGreaterThan(0);

    // Ctrl+Z in the sidebar undoes it.
    await user.keyboard("{Control>}z{/Control}");
    await app.settled();
    expect(await nav().findByRole("button", { name: "api" })).toBeInTheDocument();
    expect(exists(storage, "api/spec.md")).toBe(true);
  });

  it("renames from the menu and cancels when the field loses focus", async () => {
    const { user } = await ready();
    fireEvent.contextMenu(projectRow("web"));
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
    const field = nav().getByRole("textbox", { name: "Rename project web" });
    expect(field).toHaveValue("web");
    await user.click(nav().getByRole("button", { name: /inbox/ }));
    expect(nav().queryByRole("textbox")).toBeNull();
  });

  it("archives a project into the collapsed Archived group and unarchives it", async () => {
    const { user, storage, app } = await ready();
    const toggle = nav().getByRole("button", { name: "archived (1)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(nav().queryByRole("button", { name: "old" })).toBeNull();

    fireEvent.contextMenu(projectRow("web"));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    await app.settled();
    expect(exists(storage, "_archive/web/tasks.md")).toBe(true);
    expect(nav().getByRole("button", { name: "archived (2)" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.click(nav().getByRole("button", { name: "archived (2)" }));
    expect(nav().getByRole("button", { name: "web" })).toBeInTheDocument();

    // An archived project opens like any other.
    await user.click(nav().getByRole("button", { name: "old" }));
    expect(app.folder).toBe("_archive/old");
    expect(list().getByText("_archive/old/")).toBeInTheDocument();

    fireEvent.contextMenu(nav().getByRole("button", { name: "web" }));
    expect(menuItems()).toEqual(["Rename F2", "Unarchive", "Copy path", "Delete… Del"]);
    await user.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    await app.settled();
    expect(exists(storage, "web/tasks.md")).toBe(true);
    await user.click(nav().getByRole("button", { name: "archived (1)" }));
    expect(nav().queryByRole("button", { name: "old" })).toBeNull();
  });

  it("copies the project path", async () => {
    const { user } = await ready();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    fireEvent.contextMenu(projectRow("api"));
    await user.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("api");
  });

  it("asks before deleting, with Cancel focused, and moves the folder to the trash", async () => {
    const { user, storage, app } = await ready();
    projectRow("api").focus();
    await user.keyboard("{Delete}");
    const dialog = within(screen.getByRole("alertdialog", { name: "Delete project" }));
    expect(
      dialog.getByText(/Its folder \(2 notes, 1 task\) moves to the system trash\./),
    ).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Focus stays in the dialog, and global shortcuts wait.
    await user.keyboard("{Tab}");
    expect(dialog.getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(dialog.getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(projectRow("api")).toHaveFocus());
    expect(exists(storage, "api/spec.md")).toBe(true);

    fireEvent.contextMenu(projectRow("api"));
    await user.click(screen.getByRole("menuitem", { name: /Delete/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await app.settled();
    expect(exists(storage, "api/spec.md")).toBe(false);
    expect(screen.getAllByText("Project api moved to the trash").length).toBeGreaterThan(0);
    expect(nav().queryByRole("button", { name: "api" })).toBeNull();
    await waitFor(() => expect(nav().getByRole("button", { name: /inbox/ })).toHaveFocus());
  });

  it("keeps focus in the delete dialog opened from the menu, by mouse and Shift+F10", async () => {
    const { user, storage } = await ready();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.contextMenu(projectRow("api"));
    // The row behind the dialog never takes focus while it is open.
    const rowFocus = vi.fn();
    projectRow("api").addEventListener("focus", rowFocus);
    await user.click(screen.getByRole("menuitem", { name: /Delete/ }));
    await settle();
    expect(rowFocus).not.toHaveBeenCalled();
    let dialog = within(screen.getByRole("alertdialog", { name: "Delete project" }));
    expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(projectRow("api")).toHaveFocus());

    await user.keyboard("{Shift>}{F10}{/Shift}{End}{Enter}");
    await settle();
    dialog = within(screen.getByRole("alertdialog", { name: "Delete project" }));
    expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
    // Enter on the focused Cancel button keeps the project.
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(projectRow("api")).toHaveFocus());
    expect(exists(storage, "api/spec.md")).toBe(true);
  });

  it("never lets keys act behind the delete dialog", async () => {
    const { user, storage } = await ready();
    projectRow("api").focus();
    await user.keyboard("{Delete}");
    const dialog = within(screen.getByRole("alertdialog", { name: "Delete project" }));
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    // Focus moved behind the dialog comes back.
    projectRow("web").focus();
    expect(cancel).toHaveFocus();
    // Keys pressed while nothing inside has focus stay with the dialog.
    cancel.blur();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(cancel).toHaveFocus();
    cancel.blur();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(dialog.getByRole("button", { name: "Delete" })).toHaveFocus();
    cancel.blur();
    await user.keyboard("{Tab}");
    expect(cancel).toHaveFocus();
    cancel.blur();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(projectRow("api")).toHaveFocus());
    expect(exists(storage, "api/spec.md")).toBe(true);
  });

  it("focuses the project where it went after archiving or unarchiving from the menu", async () => {
    const { user, app } = await ready();
    fireEvent.contextMenu(projectRow("web"));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    await app.settled();
    // The Archived group is collapsed, so its heading takes focus.
    await waitFor(() => expect(nav().getByRole("button", { name: "archived (2)" })).toHaveFocus());
    await user.click(nav().getByRole("button", { name: "archived (2)" }));
    projectRow("web").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    await app.settled();
    await waitFor(() => expect(projectRow("web")).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);

    // Shown archived projects take focus themselves.
    fireEvent.contextMenu(projectRow("api"));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    await app.settled();
    await waitFor(() => expect(projectRow("api")).toHaveFocus());
    expect(projectRow("api").dataset["navId"]).toBe("_archive/api");
  });

  it("cancels the delete with a click outside", async () => {
    const { user, storage } = await ready();
    projectRow("web").focus();
    await user.keyboard("{Delete}");
    const backdrop = screen.getByRole("alertdialog").parentElement;
    if (backdrop) await fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(exists(storage, "web/tasks.md")).toBe(true);
  });
});

describe("Moving notes and tasks", () => {
  it("moves a note with the picker: filter, arrows, Enter, and undo", async () => {
    const { user, storage, app } = await ready();
    const row = list().getByRole("button", { name: /idea\.md/ });
    row.focus();
    await user.keyboard("{ContextMenu}");
    await user.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const picker = within(screen.getByRole("dialog", { name: "Move idea.md to…" }));
    const filter = picker.getByRole("combobox", { name: "Filter folders" });
    expect(filter).toHaveFocus();
    expect(picker.getAllByRole("option").map((option) => option.textContent?.trim())).toEqual([
      "api",
      "api/docs/",
      "web",
    ]);
    await user.keyboard("{ArrowDown}");
    expect(picker.getByRole("option", { name: "api/docs/" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(picker.getByRole("option", { name: "web" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(picker.getByRole("option", { name: "api" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Control>}{End}{/Control}{Control>}{Home}{/Control}{Tab}");
    expect(filter).toHaveFocus();
    await user.type(filter, "docs");
    expect(picker.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    await app.settled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(exists(storage, "api/docs/idea.md")).toBe(true);
    expect(screen.getAllByText("Moved idea.md to api/docs/").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Undo/ }));
    await app.settled();
    expect(exists(storage, "inbox/idea.md")).toBe(true);
  });

  it("shows why a note cannot be moved there and closes with Escape", async () => {
    const { user } = await ready({ "web/idea.md": "" });
    fireEvent.contextMenu(list().getByRole("button", { name: /idea\.md/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const picker = within(screen.getByRole("dialog"));
    await user.type(picker.getByRole("combobox"), "zzz");
    expect(picker.getByText("No matching folder")).toBeInTheDocument();
    await user.keyboard("{Enter}{ArrowDown}");
    await user.clear(picker.getByRole("combobox"));
    await user.click(picker.getByRole("option", { name: "web" }));
    expect(await picker.findByRole("alert")).toHaveTextContent(
      "A note named idea.md already exists there.",
    );
    await user.keyboard("{Control>}n{/Control}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(list().getByRole("button", { name: /tasks\.md/ })).toHaveFocus());
  });

  it("closes the picker with a click outside", async () => {
    const { user } = await ready();
    fireEvent.contextMenu(list().getByRole("button", { name: /idea\.md/ }));
    await user.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const backdrop = screen.getByRole("dialog").parentElement;
    if (backdrop) await fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves a task to another project from its menu", async () => {
    const { user, storage, app } = await ready();
    await user.click(nav().getByRole("button", { name: "api" }));
    await app.settled();
    const tasks = within(screen.getByRole("main", { name: "Tasks" }));
    const subtask = tasks.getByRole("checkbox", { name: "sub" });
    subtask.focus();
    await user.keyboard("{ContextMenu}");
    expect(screen.queryByRole("menuitem", { name: "Move to project…" })).toBeNull();
    await user.keyboard("{Escape}");

    tasks.getByRole("checkbox", { name: "ship" }).focus();
    await user.keyboard("{ContextMenu}");
    await user.click(screen.getByRole("menuitem", { name: "Move to project…" }));
    const picker = within(screen.getByRole("dialog", { name: "Move task to project…" }));
    await waitFor(() => expect(picker.getByRole("combobox")).toHaveFocus());
    expect(picker.getAllByRole("option").map((option) => option.textContent?.trim())).toEqual([
      "inbox",
      "web",
    ]);
    await user.click(picker.getByRole("option", { name: "web" }));
    await app.settled();
    await vi.waitFor(async () =>
      expect(await fileText(storage, "web/tasks.md")).toBe("- [ ] w\n- [ ] ship\n  - [ ] sub\n"),
    );
    await vi.waitFor(async () => expect(await fileText(storage, "api/tasks.md")).toBe(""));
    expect(screen.getAllByText("Moved task to web").length).toBeGreaterThan(0);
    // Focus goes back to the task list.
    await waitFor(() =>
      expect(screen.getByRole("main", { name: "Tasks" }).contains(document.activeElement)).toBe(
        true,
      ),
    );
  });
});
