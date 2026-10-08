import { fireEvent, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ListItem } from "$lib/core/views";
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

function renderList(items: ListItem[], selected = "") {
  const state = { selected };
  const onselect = vi.fn((id: string) => {
    state.selected = id;
    view.rerender({ selected: id });
  });
  const view = render(ListPane, {
    title: "p/",
    summary: "",
    items,
    emptyMessage: "No notes yet.",
    now: 0,
    selected,
    onselect,
  });
  const list = () => within(screen.getByRole("region"));
  const rendered = () => list().getAllByRole("listitem");
  const viewport = () => screen.getByRole("list").parentElement as HTMLElement;
  return { view, onselect, list, rendered, viewport, state };
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
