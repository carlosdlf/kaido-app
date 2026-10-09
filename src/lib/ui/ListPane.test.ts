import { fireEvent, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ListItem } from "$lib/core/views";
import type { RenameOutcome } from "./appState.svelte";
import ListPane from "./ListPane.svelte";

const ROW = 64;

function notes(count: number): ListItem[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "note" as const,
    id: `p/note-${i}.md`,
    name: `note-${i}.md`,
    title: `Note ${i}`,
    modified: 0,
  }));
}

type RenameHandler = (id: string, name: string) => Promise<RenameOutcome>;

function renderList(
  items: ListItem[],
  selected = "",
  rename: RenameHandler = async (id) => ({ kind: "renamed", path: id }),
) {
  const state = { selected };
  const onselect = vi.fn((id: string) => {
    state.selected = id;
    view.rerender({ selected: id });
  });
  const oncreate = vi.fn();
  const onrename = vi.fn(rename);
  const ondelete = vi.fn();
  const oncopypath = vi.fn();
  const onundo = vi.fn();
  const view = render(ListPane, {
    title: "p/",
    summary: "",
    items,
    emptyMessage: "No notes yet.",
    now: 0,
    selected,
    onselect,
    oncreate,
    createShortcut: { aria: "Control+N", hint: "^N" },
    onrename,
    ondelete,
    oncopypath,
    onundo,
  });
  const list = () => within(screen.getByRole("region"));
  const rendered = () => list().getAllByRole("listitem");
  const viewport = () => screen.getByRole("list").parentElement as HTMLElement;
  return {
    view,
    onselect,
    oncreate,
    onrename,
    ondelete,
    oncopypath,
    onundo,
    list,
    rendered,
    viewport,
    state,
  };
}

describe("ListPane virtualization", () => {
  it("renders only the rows near the viewport", () => {
    const { rendered } = renderList(notes(1000));
    const count = rendered().length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(40);
    expect(rendered()[0]).toHaveAttribute("aria-setsize", "1000");
    expect(rendered()[0]).toHaveAttribute("aria-posinset", "1");
  });

  it("pads the list so the scroll height matches every row", () => {
    const { list } = renderList(notes(1000));
    const ul = list().getByRole("list");
    expect(ul.style.paddingTop).toBe("0px");
    expect(Number.parseFloat(ul.style.paddingBottom)).toBeGreaterThan(900 * ROW);
  });

  it("renders other rows after scrolling", async () => {
    const { rendered, viewport } = renderList(notes(1000));
    viewport().scrollTop = 500 * ROW;
    await fireEvent.scroll(viewport());
    const positions = rendered().map((row) => Number(row.getAttribute("aria-posinset")));
    expect(positions).toContain(501);
    expect(positions).not.toContain(1);
  });

  it("moves to the end with the keyboard, scrolling and focusing the last row", async () => {
    const user = userEvent.setup();
    const { list, viewport, onselect } = renderList(notes(1000), "p/note-0.md");
    list()
      .getByRole("button", { name: /note-0\.md/ })
      .focus();
    await user.keyboard("{End}");
    expect(onselect).toHaveBeenLastCalledWith("p/note-999.md");
    expect(viewport().scrollTop).toBeGreaterThan(990 * ROW - 800);
    expect(list().getByRole("button", { name: /note-999\.md/ })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(list().getByRole("button", { name: /note-998\.md/ })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(viewport().scrollTop).toBe(0);
    expect(list().getByRole("button", { name: /note-0\.md/ })).toHaveFocus();
  });

  it("reveals a selection made elsewhere", async () => {
    const { view, viewport, list } = renderList(notes(1000));
    await view.rerender({ selected: "p/note-700.md" });
    expect(viewport().scrollTop).toBeGreaterThan(0);
    expect(list().getByRole("button", { name: /note-700\.md/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("keeps a rendered row focusable when the selection is scrolled away", async () => {
    const { list, viewport } = renderList(notes(1000), "p/note-0.md");
    viewport().scrollTop = 600 * ROW;
    await fireEvent.scroll(viewport());
    const focusable = list()
      .getAllByRole("button")
      .filter((button) => button.dataset["itemId"] !== undefined && button.tabIndex === 0);
    expect(focusable).toHaveLength(1);
  });

  it("makes the first row focusable without a selection", () => {
    const { list } = renderList(notes(3));
    expect(list().getByRole("button", { name: /note-0\.md/ })).toHaveAttribute("tabindex", "0");
    expect(list().getByRole("button", { name: /note-1\.md/ })).toHaveAttribute("tabindex", "-1");
  });

  it("ignores keys that do not move", async () => {
    const user = userEvent.setup();
    const { list, onselect } = renderList(notes(3), "p/note-1.md");
    list()
      .getByRole("button", { name: /note-1\.md/ })
      .focus();
    await user.keyboard("a");
    expect(onselect).not.toHaveBeenCalled();
  });

  it("measures the viewport even when the list starts empty", async () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    let resize: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    try {
      const { view, rendered, list } = renderList([]);
      expect(list().getByText("No notes yet.")).toBeInTheDocument();
      await view.rerender({ items: notes(1000) });
      // 200px shows 4 rows; with overscan that is far fewer than the fallback.
      expect(rendered().length).toBe(13);

      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(640);
      resize();
      await view.rerender({ now: 1 });
      expect(rendered().length).toBe(19);
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("keeps keyboard focus in the list when the focused row scrolls away", async () => {
    const user = userEvent.setup();
    const { list, viewport, onselect } = renderList(notes(1000), "p/note-0.md");
    list()
      .getByRole("button", { name: /note-0\.md/ })
      .focus();
    viewport().scrollTop = 600 * ROW;
    await fireEvent.scroll(viewport());
    await vi.waitFor(() => expect(viewport()).toHaveFocus());
    expect(list().queryByRole("button", { name: /note-0\.md/ })).toBeNull();

    await user.keyboard("{ArrowDown}");
    expect(onselect).toHaveBeenLastCalledWith("p/note-1.md");
    expect(list().getByRole("button", { name: /note-1\.md/ })).toHaveFocus();
  });

  it("leaves focus alone when scrolling without focus in the list", async () => {
    const { viewport } = renderList(notes(1000));
    viewport().scrollTop = 600 * ROW;
    await fireEvent.scroll(viewport());
    expect(viewport()).not.toHaveFocus();
  });

  it("keeps a focused row that is still rendered after scrolling", async () => {
    const { list, viewport } = renderList(notes(1000), "p/note-0.md");
    const row = list().getByRole("button", { name: /note-0\.md/ });
    row.focus();
    viewport().scrollTop = 2 * ROW;
    await fireEvent.scroll(viewport());
    expect(row).toHaveFocus();
  });
});

describe("ListPane new note button", () => {
  it("is a labelled button that announces its shortcut", async () => {
    const { oncreate } = renderList(notes(2));
    const button = screen.getByRole("button", { name: "New note" });
    expect(button).toHaveAttribute("aria-keyshortcuts", "Control+N");
    expect(button).toHaveTextContent("^N");
    await userEvent.click(button);
    expect(oncreate).toHaveBeenCalledOnce();
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(oncreate).toHaveBeenCalledTimes(2);
  });
});

const withTasks = (): ListItem[] => [
  { kind: "tasks", id: "p/tasks.md", label: "tasks.md", openCount: 1 },
  ...notes(5),
];

const row = (name: string | RegExp) =>
  within(screen.getByRole("region")).getByRole("button", {
    name: typeof name === "string" ? new RegExp(name.replace(".", "\\.")) : name,
  });

describe("ListPane context menu", () => {
  it("opens on right-click with keyboard-navigable items", async () => {
    const user = userEvent.setup();
    renderList(withTasks(), "p/note-1.md");
    await user.pointer({ keys: "[MouseRight]", target: row("note-1.md") });
    const menu = screen.getByRole("menu", { name: "Note actions" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Rename F2",
      "Copy path",
      "Delete Del",
    ]);
    expect(items[0]).toHaveAttribute("aria-keyshortcuts", "F2");
    expect(items[2]).toHaveAttribute("aria-keyshortcuts", "Delete");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(items[2]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(items[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();
    await user.keyboard("x");
    expect(items[0]).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await vi.waitFor(() => expect(row("note-1.md")).toHaveFocus());
  });

  it("opens with Shift+F10 and the ContextMenu key on the focused row", async () => {
    const user = userEvent.setup();
    renderList(withTasks(), "p/note-2.md");
    row("note-2.md").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    await vi.waitFor(() => expect(row("note-2.md")).toHaveFocus());

    await user.keyboard("{ContextMenu}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("copies the path and deletes from the menu, returning focus to the row", async () => {
    const user = userEvent.setup();
    const { oncopypath, ondelete } = renderList(withTasks(), "p/note-0.md");
    await user.pointer({ keys: "[MouseRight]", target: row("note-3.md") });
    await user.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(oncopypath).toHaveBeenCalledWith("p/note-3.md");
    expect(screen.queryByRole("menu")).toBeNull();
    await vi.waitFor(() => expect(row("note-3.md")).toHaveFocus());

    await user.keyboard("{Shift>}{F10}{/Shift}");
    await user.keyboard("{End}{Enter}");
    expect(ondelete).toHaveBeenCalledWith("p/note-3.md");
  });

  it("closes on a click outside without moving focus back", async () => {
    const user = userEvent.setup();
    renderList(withTasks(), "p/note-0.md");
    await user.pointer({ keys: "[MouseRight]", target: row("note-1.md") });
    const create = screen.getByRole("button", { name: "New note" });
    await user.click(create);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(create).toHaveFocus();
  });

  it("closes when the window loses focus or scrolls", async () => {
    const user = userEvent.setup();
    const { viewport } = renderList(withTasks(), "p/note-0.md");
    await user.pointer({ keys: "[MouseRight]", target: row("note-1.md") });
    await fireEvent.blur(window);
    expect(screen.queryByRole("menu")).toBeNull();

    await user.pointer({ keys: "[MouseRight]", target: row("note-1.md") });
    await fireEvent.scroll(viewport());
    expect(screen.queryByRole("menu")).toBeNull();
    await vi.waitFor(() => expect(row("note-1.md")).toHaveFocus());
  });

  it("is not offered for task lists", async () => {
    const user = userEvent.setup();
    const { onrename, ondelete } = renderList(withTasks(), "p/tasks.md");
    await user.pointer({ keys: "[MouseRight]", target: row("tasks.md") });
    expect(screen.queryByRole("menu")).toBeNull();
    row("tasks.md").focus();
    await user.keyboard("{Shift>}{F10}{/Shift}{F2}{Delete}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onrename).not.toHaveBeenCalled();
    expect(ondelete).not.toHaveBeenCalled();
  });
});

describe("ListPane note actions", () => {
  it("deletes the focused note with Delete, but not with modifiers", async () => {
    const user = userEvent.setup();
    const { ondelete } = renderList(withTasks(), "p/note-1.md");
    row("note-1.md").focus();
    await user.keyboard("{Control>}{Delete}{/Control}{Shift>}{Delete}{/Shift}");
    expect(ondelete).not.toHaveBeenCalled();
    await user.keyboard("{Delete}");
    expect(ondelete).toHaveBeenCalledWith("p/note-1.md");
  });

  it("deletes once while Delete or F2 is held", async () => {
    const { ondelete, view } = renderList(withTasks(), "p/note-1.md");
    row("note-1.md").focus();
    await fireEvent.keyDown(row("note-1.md"), { key: "Delete" });
    expect(ondelete).toHaveBeenCalledTimes(1);
    // The next row gets focus while the key is still down.
    const remaining = withTasks().filter((item) => item.id !== "p/note-1.md");
    await view.rerender({ items: remaining, selected: "p/note-2.md" });
    await vi.waitFor(() => expect(row("note-2.md")).toHaveFocus());
    const repeat = await fireEvent.keyDown(row("note-2.md"), { key: "Delete", repeat: true });
    expect(repeat).toBe(false);
    expect(ondelete).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(row("note-2.md"), { key: "F2", repeat: true });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("asks to undo with Ctrl+Z or Cmd+Z in the list, once per press", async () => {
    const user = userEvent.setup();
    const { onundo, viewport } = renderList(withTasks(), "p/note-1.md");
    row("note-1.md").focus();
    await user.keyboard("{Control>}z{/Control}");
    expect(onundo).toHaveBeenCalledTimes(1);
    viewport().focus();
    await user.keyboard("{Meta>}z{/Meta}");
    expect(onundo).toHaveBeenCalledTimes(2);
    row("note-1.md").focus();
    await user.keyboard("z{Control>}{Shift>}z{/Shift}{/Control}{Control>}{Alt>}z{/Alt}{/Control}");
    await fireEvent.keyDown(row("note-1.md"), { key: "z", ctrlKey: true, repeat: true });
    expect(onundo).toHaveBeenCalledTimes(2);
  });

  it("leaves Ctrl+Z to the rename field", async () => {
    const user = userEvent.setup();
    const { onundo } = renderList(withTasks(), "p/note-1.md");
    row("note-1.md").focus();
    await user.keyboard("{F2}x{Control>}z{/Control}");
    expect(onundo).not.toHaveBeenCalled();
  });

  it("moves focus to the selected row when the focused row goes away", async () => {
    const { view } = renderList(withTasks(), "p/note-1.md");
    row("note-1.md").focus();
    const remaining = withTasks().filter((item) => item.id !== "p/note-1.md");
    await view.rerender({ items: remaining, selected: "p/note-2.md" });
    await vi.waitFor(() => expect(row("note-2.md")).toHaveFocus());
  });

  it("leaves focus alone when it was not in the list", async () => {
    const { view } = renderList(withTasks(), "p/note-1.md");
    const create = screen.getByRole("button", { name: "New note" });
    create.focus();
    await view.rerender({ items: notes(2), selected: "p/note-0.md" });
    expect(create).toHaveFocus();
  });

  it("focuses the selected row on request", async () => {
    const { view } = renderList(withTasks(), "p/note-4.md");
    await view.rerender({ focusRequest: 1 });
    await vi.waitFor(() => expect(row("note-4.md")).toHaveFocus());
  });

  it("focuses the list itself when nothing is selected on request", async () => {
    const { view, viewport } = renderList(withTasks(), "");
    await view.rerender({ focusRequest: 1 });
    await vi.waitFor(() => expect(viewport()).toHaveFocus());
  });
});

describe("ListPane inline rename", () => {
  const input = () => screen.getByRole<HTMLInputElement>("textbox", { name: /^Rename / });

  it("edits the file name with F2, preselecting the stem, and confirms with Enter", async () => {
    const user = userEvent.setup();
    let release: (outcome: RenameOutcome) => void = () => undefined;
    const { onrename, onselect } = renderList(
      withTasks(),
      "p/note-1.md",
      () => new Promise((resolve) => (release = resolve)),
    );
    row("note-1.md").focus();
    await user.keyboard("{F2}");
    const field = input();
    expect(field).toHaveFocus();
    expect(field).toHaveValue("note-1.md");
    expect(field).toHaveAccessibleName("Rename note-1.md");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 6]);

    // Keys in the field never act on the list.
    await user.keyboard("{ArrowDown}{Delete}{F2}{Home}");
    expect(onselect).not.toHaveBeenCalled();

    await user.keyboard("{Control>}a{/Control}renamed{Enter}");
    expect(onrename).toHaveBeenCalledWith("p/note-1.md", "renamed");
    // A blur while the rename runs does not send it twice.
    field.blur();
    expect(onrename).toHaveBeenCalledTimes(1);
    release({ kind: "renamed", path: "p/note-1.md" });
    await vi.waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("starts from the menu and focuses the renamed row afterwards", async () => {
    const user = userEvent.setup();
    const items = withTasks();
    const { view } = renderList(items, "p/note-1.md", async () => {
      await view.rerender({
        items: items.map((item) =>
          item.id === "p/note-1.md" && item.kind === "note"
            ? { ...item, id: "p/zz.md", name: "zz.md" }
            : item,
        ),
        selected: "p/zz.md",
      });
      return { kind: "renamed", path: "p/zz.md" };
    });
    await user.pointer({ keys: "[MouseRight]", target: row("note-1.md") });
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
    expect(input()).toHaveFocus();
    await user.keyboard("{Control>}a{/Control}zz{Enter}");
    await vi.waitFor(() => expect(row("zz.md")).toHaveFocus());
  });

  it("shows why a name is refused and stays editing", async () => {
    const user = userEvent.setup();
    const { onrename } = renderList(withTasks(), "p/note-1.md", async () => ({
      kind: "invalid",
      reason: "Names cannot contain / or \\.",
    }));
    row("note-1.md").focus();
    await user.keyboard("{F2}{Control>}a{/Control}a/b{Enter}");
    const field = input();
    await vi.waitFor(() => expect(field).toHaveAttribute("aria-invalid", "true"));
    expect(field).toHaveAccessibleDescription("Names cannot contain / or \\.");
    // Announced right away, without leaving the field.
    expect(screen.getByRole("alert")).toHaveTextContent("Names cannot contain / or \\.");
    expect(field).toHaveFocus();
    expect(onrename).toHaveBeenCalledWith("p/note-1.md", "a/b");
    await user.keyboard("c");
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(field).toHaveValue("a/bc");
  });

  it("cancels with Escape and returns focus to the row", async () => {
    const user = userEvent.setup();
    const { onrename } = renderList(withTasks(), "p/note-1.md");
    row("note-1.md").focus();
    await user.keyboard("{F2}changed{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onrename).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(row("note-1.md")).toHaveFocus());
  });

  it("confirms on blur without taking focus back", async () => {
    const user = userEvent.setup();
    const { onrename } = renderList(withTasks(), "p/note-1.md");
    row("note-1.md").focus();
    await user.keyboard("{F2}{Control>}a{/Control}other");
    const create = screen.getByRole("button", { name: "New note" });
    await user.click(create);
    expect(onrename).toHaveBeenCalledWith("p/note-1.md", "other");
    await vi.waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(create).toHaveFocus();
  });

  it("keeps editing when the window loses focus, and confirms on the next blur", async () => {
    const user = userEvent.setup();
    const { onrename } = renderList(withTasks(), "p/note-1.md");
    row("note-1.md").focus();
    await user.keyboard("{F2}{Control>}a{/Control}half");
    const field = input();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    try {
      await fireEvent.blur(field);
      expect(onrename).not.toHaveBeenCalled();
      expect(input()).toHaveValue("half");
    } finally {
      hasFocus.mockRestore();
    }
    // Back in the window, the user finishes typing and leaves the field.
    field.focus();
    await user.keyboard("-typed");
    await user.click(screen.getByRole("button", { name: "New note" }));
    expect(onrename).toHaveBeenCalledTimes(1);
    expect(onrename).toHaveBeenCalledWith("p/note-1.md", "half-typed");
  });

  it("ends editing when the rename failed for another reason", async () => {
    const user = userEvent.setup();
    renderList(withTasks(), "p/note-1.md", async () => ({ kind: "failed" }));
    row("note-1.md").focus();
    await user.keyboard("{F2}x{Enter}");
    await vi.waitFor(() => expect(row("note-1.md")).toHaveFocus());
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("confirms when the row scrolls out of the rendered range", async () => {
    const user = userEvent.setup();
    const { onrename, viewport } = renderList(notes(1000), "p/note-0.md");
    row("note-0.md").focus();
    await user.keyboard("{F2}{Control>}a{/Control}far");
    viewport().scrollTop = 600 * ROW;
    await fireEvent.scroll(viewport());
    await vi.waitFor(() => expect(onrename).toHaveBeenCalledWith("p/note-0.md", "far"));
  });

  it("edits only the file name of a note in a subfolder", async () => {
    const user = userEvent.setup();
    renderList(
      [{ kind: "note", id: "p/sub/deep.md", name: "sub/deep.md", title: null, modified: 0 }],
      "p/sub/deep.md",
    );
    row("deep.md").focus();
    await user.keyboard("{F2}");
    expect(input()).toHaveValue("deep.md");
  });
});
