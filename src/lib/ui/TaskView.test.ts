import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryStorage, StorageError } from "$lib/storage";
import { AppState, oversizedTasksMessage, TASK_CHANGED } from "./appState.svelte";
import AppShell from "./AppShell.svelte";

const ROOT = "/home/me/notes";

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] one\n- [ ] two\n- [x] old\n- [ ] three\n",
  "inbox/idea.md": "# Idea\n",
  "api/tasks.md": [
    "# Now",
    "- [ ] check timeouts",
    "  - [ ] staging",
    "- [ ] rotate keys",
    "",
    "## Later",
    "- [ ] update runbook",
    "",
  ].join("\n"),
  "api/deploy.md": "# Deploy\n",
  "empty/tasks.md": "",
};

async function ready(folder: Record<string, string> = files) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...folder } },
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
const pane = () => within(screen.getByRole("main", { name: "Tasks" }));
const allPane = () => within(screen.getByRole("main", { name: "All tasks" }));
const task = (name: string | RegExp) => pane().getByRole("checkbox", { name });
/** A checkbox's name, read from the text that labels it. */
const nameOf = (box: HTMLElement) =>
  document.getElementById(box.getAttribute("aria-labelledby") ?? "")?.textContent ?? "";
const names = () => pane().queryAllByRole("checkbox").map(nameOf);
const unchecked = (boxes: HTMLElement[]) =>
  boxes.filter((box) => !(box as HTMLInputElement).checked).map(nameOf);
/** Open tasks in the order shown (done tasks stay in place, struck through). */
const openNames = () => unchecked(pane().queryAllByRole("checkbox"));
const fileText = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;
const saved = (storage: MemoryStorage, path: string, text: string) =>
  waitFor(async () => expect(await fileText(storage, path)).toBe(text));

async function openProject(user: ReturnType<typeof userEvent.setup>, name: string, app: AppState) {
  await user.click(nav().getByRole("button", { name: new RegExp(name) }));
  await app.settled();
}

describe("Task view", () => {
  it("shows every task in file order, done ones in place and struck through", async () => {
    await ready();
    expect(names()).toEqual(["one", "two", "old", "three"]);
    expect(task("old")).toBeChecked();
    expect(task("old").closest("li")).toHaveClass("done");
    expect(pane().queryByRole("button", { name: /^Done/ })).toBeNull();
    expect(pane().getByText("inbox/")).toBeInTheDocument();
    expect(pane().getByText("tasks.md")).toBeInTheDocument();
    expect(pane().getByText(/^saved · /)).toBeInTheDocument();
    // One tab stop: the first task.
    expect(task("one")).toHaveAttribute("tabindex", "0");
    expect(task("two")).toHaveAttribute("tabindex", "-1");
  });

  it("shows headings, nested tasks and plain text", async () => {
    const { user, app } = await ready();
    await openProject(user, "api", app);
    expect(pane().getByRole("heading", { name: "Now" })).toHaveTextContent("# Now");
    expect(pane().getByRole("heading", { name: "Later" })).toHaveTextContent("## Later");
    expect(names()).toEqual(["check timeouts", "staging", "rotate keys", "update runbook"]);
    expect(task("staging").closest("li")).toHaveClass("nested");
  });

  it("toggles with Space and the mouse, keeping the task and focus in place", async () => {
    const { user, storage } = await ready();
    task("two").focus();
    await user.keyboard(" ");
    expect(names()).toEqual(["one", "two", "old", "three"]);
    expect(task("two")).toBeChecked();
    expect(task("two")).toHaveFocus();
    await saved(storage, "inbox/tasks.md", "- [ ] one\n- [x] two\n- [x] old\n- [ ] three\n");
    expect(nav().getByRole("button", { name: /inbox/ })).toHaveTextContent("[2]");

    await user.click(task("one"));
    expect(openNames()).toEqual(["three"]);
    await saved(storage, "inbox/tasks.md", "- [x] one\n- [x] two\n- [x] old\n- [ ] three\n");
    await user.click(task("old"));
    expect(openNames()).toEqual(["old", "three"]);
  });

  it("hides done tasks per list, and focus moves to the task now in place", async () => {
    const { user, app } = await ready();
    const hide = pane().getByRole("button", { name: "hide done" });
    expect(hide).toHaveAttribute("aria-pressed", "false");
    await user.click(hide);
    expect(hide).toHaveAttribute("aria-pressed", "true");
    expect(names()).toEqual(["one", "two", "three"]);

    task("two").focus();
    await user.keyboard(" ");
    expect(names()).toEqual(["one", "three"]);
    await waitFor(() => expect(task("three")).toHaveFocus());

    // Remembered per list while the app runs.
    await openProject(user, "api", app);
    expect(pane().getByRole("button", { name: "hide done" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await openProject(user, "inbox", app);
    expect(pane().getByRole("button", { name: "hide done" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("moves focus with the arrow keys, Home and End", async () => {
    const { user } = await ready();
    task("one").focus();
    await user.keyboard("{ArrowDown}");
    expect(task("two")).toHaveFocus();
    expect(task("two")).toHaveAttribute("tabindex", "0");
    await user.keyboard("{End}");
    expect(task("three")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(task("old")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(task("one")).toHaveFocus();
    // Other modified keys do nothing here.
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}{Shift>}{Enter}{/Shift}");
    expect(task("one")).toHaveFocus();
    expect(pane().queryByRole("textbox")).toBeNull();
  });

  it("adds tasks below with Enter, one after another, and cancels with Escape", async () => {
    const { user, storage } = await ready();
    task("one").focus();
    await user.keyboard("{Enter}");
    const input = pane().getByRole("textbox", { name: "New task" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("placeholder", "Add a task…");
    await user.keyboard("first{Enter}");
    await waitFor(() => expect(pane().getByRole("textbox", { name: "New task" })).toHaveFocus());
    await user.keyboard("second{Enter}");
    expect(openNames()).toEqual(["one", "first", "second", "two", "three"]);
    await waitFor(() => expect(pane().getByRole("textbox", { name: "New task" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(pane().queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(task("second")).toHaveFocus());
    await saved(
      storage,
      "inbox/tasks.md",
      "- [ ] one\n- [ ] first\n- [ ] second\n- [ ] two\n- [x] old\n- [ ] three\n",
    );
  });

  it("closes an empty new task input with Enter and adds what was typed on blur", async () => {
    const { user } = await ready();
    task("three").focus();
    await user.keyboard("{Enter}{Enter}");
    expect(pane().queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(task("three")).toHaveFocus());

    await user.keyboard("{Enter}");
    await user.keyboard("typed");
    await user.click(pane().getByText("one"));
    expect(openNames()).toEqual(["one", "two", "three", "typed"]);
    expect(pane().queryByRole("textbox")).toBeNull();

    // Leaving the window keeps the field as it is.
    task("one").focus();
    await user.keyboard("{Enter}");
    const input = pane().getByRole("textbox", { name: "New task" });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.blur(input);
    hasFocus.mockRestore();
    expect(pane().getByRole("textbox", { name: "New task" })).toBeInTheDocument();
    // Leaving an empty field closes it.
    await user.click(pane().getByText("two"));
    expect(pane().queryByRole("textbox")).toBeNull();
  });

  it("adds after the whole block of a nested task", async () => {
    const { user, app, storage } = await ready();
    await openProject(user, "api", app);
    task("staging").focus();
    await user.keyboard("{Enter}new{Escape}");
    await user.keyboard("{Escape}");
    task("staging").focus();
    await user.keyboard("{Enter}");
    await user.keyboard("after block{Enter}{Escape}");
    expect(openNames()).toEqual([
      "check timeouts",
      "staging",
      "after block",
      "rotate keys",
      "update runbook",
    ]);
    await waitFor(async () =>
      expect(await fileText(storage, "api/tasks.md")).toContain(
        "  - [ ] staging\n- [ ] after block\n- [ ] rotate keys",
      ),
    );
  });

  it("edits inline with F2 and double-click; Escape cancels and leaving saves", async () => {
    const { user, storage } = await ready();
    task("two").focus();
    await user.keyboard("{F2}");
    const input = pane().getByRole("textbox", { name: "Edit task" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("two");
    await user.keyboard("{Control>}a{/Control}2nd{Enter}");
    await waitFor(() => expect(task("2nd")).toHaveFocus());

    await user.keyboard("{F2}changed{Escape}");
    expect(task("2nd")).toHaveFocus();

    await user.dblClick(pane().getByText("one"));
    await user.keyboard("{Control>}a{/Control}first");
    await user.click(pane().getByText("three"));
    expect(openNames()).toEqual(["first", "2nd", "three"]);
    await saved(storage, "inbox/tasks.md", "- [ ] first\n- [ ] 2nd\n- [x] old\n- [ ] three\n");

    // Clearing the text changes nothing.
    task("three").focus();
    await user.keyboard("{F2}{Control>}a{/Control}{Backspace}{Enter}");
    expect(task("three")).toBeInTheDocument();
  });

  it("keeps editing when the window loses focus", async () => {
    const { user } = await ready();
    task("one").focus();
    await user.keyboard("{F2}");
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.blur(pane().getByRole("textbox", { name: "Edit task" }));
    hasFocus.mockRestore();
    expect(pane().getByRole("textbox", { name: "Edit task" })).toBeInTheDocument();
  });

  it("acts once while F2 or Enter is held", async () => {
    const { user } = await ready();
    task("one").focus();
    await user.keyboard("{F2>3/}");
    expect(pane().getAllByRole("textbox")).toHaveLength(1);
    expect(pane().getByRole("textbox", { name: "Edit task" })).toHaveValue("one");
    await user.keyboard("{Escape}");

    task("one").focus();
    await user.keyboard("{Enter>3/}");
    // One field, still open: the repeats neither close it nor add empty tasks.
    expect(pane().getByRole("textbox", { name: "New task" })).toHaveFocus();
    await user.keyboard("held{Enter>3/}");
    expect(openNames()).toEqual(["one", "held", "two", "three"]);
    expect(pane().getByRole("textbox", { name: "New task" })).toHaveFocus();
  });

  it("closes an edit field whose task moved on disk, instead of changing another task", async () => {
    const { user, storage, app } = await ready();
    task("two").focus();
    await user.keyboard("{F2}");
    storage.setExternal("inbox/tasks.md", `- [ ] zero\n${files["inbox/tasks.md"] ?? ""}`);
    await app.settled();
    await waitFor(() => expect(pane().queryByRole("textbox")).toBeNull());
    expect((await screen.findAllByText(TASK_CHANGED)).length).toBeGreaterThan(0);
    expect(openNames()).toEqual(["zero", "one", "two", "three"]);
    expect(pane().getByRole("list", { name: "Tasks" })).toContainElement(
      document.activeElement as HTMLElement,
    );

    // A new task field after a task that changed closes too.
    task("three").focus();
    await user.keyboard("{Enter}pending");
    storage.setExternal("inbox/tasks.md", "- [ ] zero\n- [ ] three changed\n");
    await app.settled();
    await waitFor(() => expect(pane().queryByRole("textbox")).toBeNull());
  });

  it("still edits the right task when lines moved but its line is unchanged", async () => {
    const { user, storage, app } = await ready();
    task("two").focus();
    await user.keyboard("{F2}");
    // Only a later line changed: the field stays and the edit lands on "two".
    storage.setExternal("inbox/tasks.md", "- [ ] one\n- [ ] two\n- [x] old\n- [ ] 3\n");
    await app.settled();
    expect(pane().getByRole("textbox", { name: "Edit task" })).toBeInTheDocument();
    await user.keyboard("{Control>}a{/Control}2{Enter}");
    expect(openNames()).toEqual(["one", "2", "3"]);
    await saved(storage, "inbox/tasks.md", "- [ ] one\n- [ ] 2\n- [x] old\n- [ ] 3\n");
  });

  it("focuses a task when its text is clicked", async () => {
    const { user } = await ready();
    await user.click(pane().getByText("three"));
    expect(task("three")).toHaveFocus();
  });

  it("deletes with Delete once per press, and undoes with Ctrl+Z", async () => {
    const { user, storage } = await ready();
    task("two").focus();
    await user.keyboard("{Delete>3/}");
    expect(openNames()).toEqual(["one", "three"]);
    // The task now in its place (the done one) takes focus.
    await waitFor(() => expect(task("old")).toHaveFocus());
    expect(await screen.findAllByText("Deleted task: two")).not.toHaveLength(0);
    await saved(storage, "inbox/tasks.md", "- [ ] one\n- [x] old\n- [ ] three\n");

    await user.keyboard("{Control>}z{/Control}");
    expect(openNames()).toEqual(["one", "two", "three"]);
    await waitFor(() => expect(task("two")).toHaveFocus());
    await saved(storage, "inbox/tasks.md", files["inbox/tasks.md"] ?? "");
    expect(screen.queryAllByText("Deleted task: two")).toHaveLength(0);
  });

  it("undoes from the toast button and focuses the restored task", async () => {
    const { user } = await ready();
    task("one").focus();
    await user.keyboard("{Delete}");
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(task("one")).toHaveFocus());
  });

  it("reorders open tasks with Alt+arrows within a section", async () => {
    const { user, app, storage } = await ready();
    task("three").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(openNames()).toEqual(["one", "three", "two"]);
    await waitFor(() => expect(task("three")).toHaveFocus());
    await user.keyboard("{Alt>}{ArrowDown}{ArrowDown}{/Alt}");
    expect(openNames()).toEqual(["one", "two", "three"]);
    await saved(storage, "inbox/tasks.md", files["inbox/tasks.md"] ?? "");

    await openProject(user, "api", app);
    task("update runbook").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(openNames()).toEqual(["check timeouts", "staging", "rotate keys", "update runbook"]);
    task("staging").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(task("staging")).toHaveFocus();
  });

  it("offers an input for the first task of an empty list", async () => {
    const { user, app, storage } = await ready();
    await openProject(user, "empty", app);
    const input = pane().getByRole("textbox", { name: "New task" });
    expect(input).not.toHaveFocus();
    await user.click(input);
    await user.keyboard("{Escape}");
    expect(input).toHaveFocus();
    await user.keyboard("first{Enter}");
    expect(openNames()).toEqual(["first"]);
    await waitFor(() => expect(pane().getByRole("textbox", { name: "New task" })).toHaveFocus());
    await user.keyboard("second{Enter}{Escape}");
    expect(openNames()).toEqual(["first", "second"]);
    await saved(storage, "empty/tasks.md", "- [ ] first\n- [ ] second\n");
  });

  it("adds at the end from the new task button", async () => {
    const { user, app } = await ready();
    await user.click(pane().getByRole("button", { name: "new task" }));
    expect(pane().getByRole("textbox", { name: "New task" })).toHaveFocus();
    await user.keyboard("last{Enter}{Escape}");
    expect(openNames()).toEqual(["one", "two", "three", "last"]);

    await openProject(user, "empty", app);
    await user.click(pane().getByRole("button", { name: "new task" }));
    expect(pane().getByRole("textbox", { name: "New task" })).toHaveFocus();
  });

  it("switches between list and text with the view switch, keeping focus on it", async () => {
    const { user, app } = await ready();
    task("one").focus();
    await user.keyboard(" ");
    const switcher = within(pane().getByRole("radiogroup", { name: "View as" }));
    expect(switcher.getByRole("radio", { name: "list" })).toHaveAttribute("aria-checked", "true");
    expect(switcher.getByRole("radio", { name: "list" })).toHaveAttribute("tabindex", "0");
    expect(switcher.getByRole("radio", { name: "text" })).toHaveAttribute("tabindex", "-1");
    await user.click(switcher.getByRole("radio", { name: "text" }));
    const editor = within(screen.getByRole("main", { name: "Editor" }));
    const textOption = editor.getByRole("radio", { name: "text" });
    expect(textOption).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(textOption).toHaveFocus());
    expect(editor.getByRole("textbox", { name: "Note text" })).toHaveTextContent("- [x] one");
    expect(screen.queryByRole("main", { name: "Tasks" })).toBeNull();

    // ← selects the list again; the same switch is focused in the task view.
    app.edit("inbox/tasks.md", () => "- [x] one\n- [ ] typed\n");
    await user.keyboard("{ArrowLeft}");
    const listOption = pane().getByRole("radio", { name: "list" });
    expect(listOption).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(listOption).toHaveFocus());
    expect(openNames()).toEqual(["typed"]);

    // → and Enter/Space on the other option switch too; the checked one changes nothing.
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(
        within(screen.getByRole("main", { name: "Editor" })).getByRole("radio", { name: "text" }),
      ).toHaveFocus(),
    );
    await user.keyboard(" ");
    expect(screen.queryByRole("main", { name: "Tasks" })).toBeNull();
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(pane().getByRole("radio", { name: "list" })).toHaveFocus());
    const textAgain = pane().getByRole("radio", { name: "text" });
    textAgain.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        within(screen.getByRole("main", { name: "Editor" })).getByRole("radio", { name: "text" }),
      ).toHaveFocus(),
    );
    await user.keyboard("{Control>}{ArrowLeft}{/Control}");
    expect(screen.queryByRole("main", { name: "Tasks" })).toBeNull();
  });

  it("toggles the view with Ctrl+Shift+M, also from inside the text editor", async () => {
    const { user, app } = await ready();
    task("two").focus();
    await user.keyboard("{Control>}{Shift>}M{/Shift}{/Control}");
    const editor = within(screen.getByRole("main", { name: "Editor" }));
    const textbox = editor.getByRole("textbox", { name: "Note text" });
    await waitFor(() => expect(textbox).toHaveFocus());
    expect(app.taskTextMode).toBe(true);

    await user.keyboard("{Control>}{Shift>}M{/Shift}{/Control}");
    expect(app.taskTextMode).toBe(false);
    // Back in the list, focus goes to its tab stop.
    await waitFor(() => expect(task("one")).toHaveFocus());

    // Not while typing in a field, and not for notes.
    await user.keyboard("{Enter}");
    await user.keyboard("{Control>}{Shift>}M{/Shift}{/Control}");
    expect(app.taskTextMode).toBe(false);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /idea\.md/ }));
    await user.keyboard("{Control>}{Shift>}M{/Shift}{/Control}");
    expect(app.taskTextMode).toBe(false);
    expect(screen.queryByRole("radiogroup", { name: "View as" })).toBeNull();
  });

  it("explains a task list that cannot be read", async () => {
    // Over 1 MiB, so it is not in the task index and waits for its own read.
    const { user, storage, app } = await ready({
      ...files,
      "big/tasks.md": `- [ ] x\n${"a".repeat(1024 * 1024)}`,
    });
    vi.spyOn(storage, "readFile").mockRejectedValueOnce(new StorageError("InvalidUtf8", "bad"));
    await openProject(user, "big", app);
    await waitFor(() =>
      expect(pane().getByRole("alert")).toHaveTextContent("Could not read this file: bad"),
    );
  });

  it("explains a task list that is too large", async () => {
    const { user, app } = await ready({
      ...files,
      "big/tasks.md": `- [ ] x\n${"a".repeat(8 * 1024 * 1024)}`,
    });
    await openProject(user, "big", app);
    expect(await pane().findByRole("status")).toHaveTextContent("larger than 8 MiB");
  });
});

describe("All tasks view", () => {
  async function openAll(user: ReturnType<typeof userEvent.setup>, app: AppState) {
    await user.click(nav().getByRole("button", { name: /all-tasks/ }));
    await app.settled();
  }

  const allNames = () => allPane().queryAllByRole("checkbox").map(nameOf);
  const allOpenNames = () => unchecked(allPane().queryAllByRole("checkbox"));

  it("groups open tasks by project with counts", async () => {
    const { user, app } = await ready();
    await openAll(user, app);
    expect(
      allPane()
        .getAllByRole("heading")
        .map((heading) => heading.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["inbox/ [3]", "api/ [3]"]);
    expect(allOpenNames()).toEqual([
      "one",
      "two",
      "three",
      "check timeouts",
      "staging",
      "rotate keys",
      "update runbook",
    ]);
    expect(allPane().getByText("6 open")).toBeInTheDocument();
    // Done tasks are shown in place, struck through, unless hidden.
    expect(allNames()).toContain("old");
    await user.click(allPane().getByRole("button", { name: "hide done" }));
    expect(allNames()).not.toContain("old");
    expect(allPane().queryByRole("button", { name: "new task" })).toBeNull();
  });

  it("toggles, adds, edits, deletes and moves in the right file", async () => {
    const { user, app, storage } = await ready();
    await openAll(user, app);
    const box = (name: string) => allPane().getByRole("checkbox", { name });
    await user.click(box("rotate keys"));
    expect(allOpenNames()).not.toContain("rotate keys");

    box("check timeouts").focus();
    await user.keyboard("{Enter}");
    await user.keyboard("api task{Enter}{Escape}");
    box("two").focus();
    await user.keyboard("{F2}{Control>}a{/Control}second{Enter}");
    await waitFor(() => expect(box("second")).toHaveFocus());
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    box("three").focus();
    await user.keyboard("{Delete}");
    expect(allOpenNames()).toEqual([
      "second",
      "one",
      "check timeouts",
      "staging",
      "api task",
      "update runbook",
    ]);
    await saved(storage, "inbox/tasks.md", "- [ ] second\n- [ ] one\n- [x] old\n");
    await saved(
      storage,
      "api/tasks.md",
      [
        "# Now",
        "- [ ] check timeouts",
        "  - [ ] staging",
        "- [ ] api task",
        "- [x] rotate keys",
        "",
        "## Later",
        "- [ ] update runbook",
        "",
      ].join("\n"),
    );
  });

  it("says which lists are too large to show", async () => {
    const { user, app } = await ready({
      ...files,
      "big/tasks.md": `- [ ] x\n${"a".repeat(1024 * 1024)}`,
    });
    await openAll(user, app);
    expect(allPane().getByText(oversizedTasksMessage(["big/tasks.md"]))).toBeInTheDocument();
  });

  it("shows a task list from the list pane and returns to the combined view", async () => {
    const { user, app } = await ready();
    await openAll(user, app);
    const list = within(screen.getByRole("region", { name: "all-tasks" }));
    expect(list.getByRole("button", { name: /all open tasks/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await user.click(list.getByRole("button", { name: /api\/tasks\.md/ }));
    await app.settled();
    expect(openNames()).toContain("rotate keys");
    await user.click(list.getByRole("button", { name: /all open tasks/ }));
    expect(allOpenNames()).toHaveLength(7);
  });
});

describe("New project", () => {
  it("creates a project from the sidebar and focuses its first task input", async () => {
    const { user, storage } = await ready();
    await user.click(nav().getByRole("button", { name: /new project/ }));
    const input = nav().getByRole("textbox", { name: "New project name" });
    expect(input).toHaveFocus();
    await user.keyboard("inbox{Enter}");
    expect(nav().getByRole("alert")).toHaveTextContent("inbox already exists.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.keyboard("x");
    expect(nav().queryByRole("alert")).toBeNull();
    await user.keyboard("{Control>}a{/Control}side project{Enter}");
    await waitFor(() => expect(pane().getByRole("textbox", { name: "New task" })).toHaveFocus());
    expect(nav().getByRole("button", { name: /side project/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav().queryByRole("textbox")).toBeNull();
    await user.keyboard("kick off{Enter}");
    await saved(storage, "side project/tasks.md", "- [ ] kick off\n");
  });

  it("opens with Ctrl+Shift+N, cancels with Escape or an empty name", async () => {
    const { user } = await ready();
    await user.keyboard("{Control>}{Shift>}N{/Shift}{/Control}");
    expect(nav().getByRole("textbox", { name: "New project name" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(nav().queryByRole("textbox")).toBeNull();
    expect(nav().getByRole("button", { name: /new project/ })).toHaveFocus();
    expect(nav().getByRole("button", { name: /new project/ })).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Shift+N",
    );

    await user.keyboard("{Control>}{Shift>}N{/Shift}{/Control}{Enter}");
    expect(nav().queryByRole("textbox")).toBeNull();
    expect(nav().getByRole("button", { name: /new project/ })).toHaveFocus();
  });

  it("cancels when the field loses focus, but not when the window does", async () => {
    const { user } = await ready();
    await user.click(nav().getByRole("button", { name: /new project/ }));
    const input = nav().getByRole("textbox", { name: "New project name" });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.blur(input);
    hasFocus.mockRestore();
    expect(input).toBeInTheDocument();
    await user.click(task("one"));
    expect(nav().queryByRole("textbox")).toBeNull();
  });

  it("goes back to the button after a failure reported in a toast", async () => {
    const { user, storage } = await ready();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "disk full"));
    await user.click(nav().getByRole("button", { name: /new project/ }));
    await user.keyboard("side{Enter}");
    expect(
      await screen.findAllByText("The project could not be created: disk full"),
    ).not.toHaveLength(0);
    await waitFor(() => expect(nav().getByRole("button", { name: /new project/ })).toHaveFocus());
  });
});
