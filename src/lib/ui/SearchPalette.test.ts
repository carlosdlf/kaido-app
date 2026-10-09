import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PALETTE_COMMANDS, TAGS_UNAVAILABLE } from "$lib/core/palette";
import type { SearchResult } from "$lib/core/searchIndex";
import SearchPalette from "./SearchPalette.svelte";

const results: SearchResult[] = [
  {
    kind: "note",
    id: "api/deploy.md",
    path: "api/deploy.md",
    title: "Deploy checklist",
    titleRanges: [{ start: 0, end: 6 }],
  },
  {
    kind: "note",
    id: "inbox/ideas.md",
    path: "inbox/ideas.md",
    title: "Ideas",
    titleRanges: [],
    snippet: { text: "we could deploy on Fridays", ranges: [{ start: 9, end: 15 }] },
    line: 3,
  },
  {
    kind: "task",
    id: "inbox/tasks.md#0",
    path: "inbox/tasks.md",
    title: "deploy the api",
    titleRanges: [{ start: 0, end: 6 }],
    line: 0,
    raw: "- [x] deploy the api",
    done: true,
  },
  {
    kind: "task",
    id: "inbox/tasks.md#1",
    path: "inbox/tasks.md",
    title: "open task",
    titleRanges: [],
    line: 1,
    raw: "- [ ] open task",
    done: false,
  },
  { kind: "project", id: "project:api", path: "api", title: "api", titleRanges: [] },
  {
    kind: "list",
    id: "inbox/tasks.md",
    path: "inbox/tasks.md",
    title: "inbox/tasks.md",
    titleRanges: [],
  },
];

function setup(search: (query: string) => SearchResult[] = () => results) {
  const trigger = document.createElement("button");
  trigger.textContent = "before";
  document.body.append(trigger);
  trigger.focus();
  const props = {
    search: vi.fn(search),
    commands: PALETTE_COMMANDS.slice(0, 3),
    onopen: vi.fn<(result: SearchResult) => void>(),
    onrun: vi.fn<(id: string) => void>(),
    onclose: vi.fn<() => void>(),
  };
  render(SearchPalette, props);
  return { ...props, trigger, user: userEvent.setup() };
}

const input = () => screen.getByRole("combobox");
const options = () => screen.queryAllByRole("option");
const selected = () => options().find((option) => option.getAttribute("aria-selected") === "true");

afterEach(() => {
  document.body.replaceChildren();
});

describe("SearchPalette", () => {
  it("searches again when the revision changes, keeping the active row in range", async () => {
    const search = vi.fn((): SearchResult[] => results);
    const props = {
      search,
      revision: 1,
      commands: [],
      onopen: vi.fn(),
      onrun: vi.fn(),
      onclose: vi.fn(),
    };
    const { rerender } = render(SearchPalette, props);
    const user = userEvent.setup();
    await user.keyboard("{ArrowUp}");
    expect(selected()).toBe(options().at(-1));
    const calls = search.mock.calls.length;
    search.mockImplementation(() => results.slice(0, 1));
    await rerender({ ...props, revision: 2 });
    expect(search.mock.calls.length).toBeGreaterThan(calls);
    expect(options()).toHaveLength(1);
    expect(selected()).toBe(options()[0]);
  });

  it("is a modal dialog with a combobox that controls a listbox", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Search and commands" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(input()).toHaveFocus();
    const listbox = screen.getByRole("listbox");
    expect(input()).toHaveAttribute("aria-controls", listbox.id);
    expect(input()).toHaveAttribute("aria-expanded", "true");
    expect(input()).toHaveAttribute("aria-autocomplete", "list");
    expect(options()).toHaveLength(results.length);
    expect(input()).toHaveAttribute("aria-activedescendant", options()[0]?.id);
    expect(selected()).toBe(options()[0]);
  });

  it("shows matches, snippets, paths and kinds", () => {
    setup();
    const [first, second, done, open, project, list] = options();
    expect(first).toHaveTextContent("note: Deploy checklist api/deploy.md");
    expect(first?.querySelector("mark")).toHaveTextContent("Deploy");
    expect(second).toHaveTextContent("we could deploy on Fridays");
    expect(second?.querySelectorAll("mark")).toHaveLength(1);
    expect(done).toHaveTextContent("done task: deploy the api");
    expect(open).toHaveTextContent("task: open task");
    expect(project).toHaveTextContent("project: api");
    expect(list).toHaveTextContent("task list: inbox/tasks.md");
  });

  it("searches on every keystroke and resets the active row", async () => {
    const { search, user } = setup();
    await user.keyboard("{ArrowDown}");
    expect(selected()).toBe(options()[1]);
    await user.type(input(), "dep");
    expect(search).toHaveBeenLastCalledWith("dep");
    expect(search).toHaveBeenCalledWith("de");
    expect(selected()).toBe(options()[0]);
  });

  it("moves with arrows and Ctrl+N / Ctrl+P, wrapping around", async () => {
    const { user } = setup();
    await user.keyboard("{ArrowUp}");
    expect(selected()).toBe(options()[results.length - 1]);
    await user.keyboard("{ArrowDown}");
    expect(selected()).toBe(options()[0]);
    await user.keyboard("{Control>}n{/Control}{Control>}n{/Control}");
    expect(selected()).toBe(options()[2]);
    await user.keyboard("{Control>}p{/Control}");
    expect(selected()).toBe(options()[1]);
    expect(input()).toHaveAttribute("aria-activedescendant", options()[1]?.id);
  });

  it("opens the active result with Enter and gives focus back first", async () => {
    const { onopen, onclose, trigger, user } = setup();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onclose).toHaveBeenCalledOnce();
    expect(onopen).toHaveBeenCalledWith(results[2]);
    expect(trigger).toHaveFocus();
  });

  it("opens a clicked result", async () => {
    const { onopen, user } = setup();
    const target = options()[4];
    if (!target) throw new Error("no option");
    await user.hover(target);
    expect(selected()).toBe(target);
    await user.click(target);
    expect(onopen).toHaveBeenCalledWith(results[4]);
  });

  it("closes with Escape and restores focus", async () => {
    const { onclose, onopen, trigger, user } = setup();
    await user.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalledOnce();
    expect(onopen).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it("closes with the search shortcut", async () => {
    const { onclose, trigger, user } = setup();
    await user.keyboard("{Control>}k{/Control}");
    expect(onclose).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it("closes on a click outside and restores focus", async () => {
    const { onclose, trigger, user } = setup();
    const backdrop = screen.getByRole("dialog").parentElement;
    if (!backdrop) throw new Error("no backdrop");
    await user.pointer({ keys: "[MouseLeft]", target: backdrop });
    expect(onclose).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it("keeps focus in the palette on Tab and on clicks inside", async () => {
    const { user } = setup();
    await user.keyboard("{Tab}");
    expect(input()).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(input()).toHaveFocus();
    await user.pointer({ keys: "[MouseLeft]", target: screen.getByRole("dialog") });
  });

  it("lists commands after > and runs them", async () => {
    const { onrun, search, user } = setup();
    await user.type(input(), ">");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    expect(options().map((option) => option.textContent?.trim())).toEqual([
      "New note",
      "New project",
      "Sync now",
    ]);
    await user.type(input(), "sync");
    expect(options().map((option) => option.textContent?.trim())).toEqual(["Sync now"]);
    await user.keyboard("{Enter}");
    expect(onrun).toHaveBeenCalledWith("sync-now");
    expect(search).not.toHaveBeenCalledWith(">");
  });

  it("says when no command matches", async () => {
    const { user } = setup();
    await user.type(input(), ">zzz");
    expect(options()).toHaveLength(0);
    expect(input()).toHaveAttribute("aria-expanded", "false");
    expect(input()).not.toHaveAttribute("aria-activedescendant");
    expect(screen.getByRole("status")).toHaveTextContent("No matching commands");
    await user.keyboard("{ArrowDown}{Enter}");
  });

  it("says that tags are not available yet", async () => {
    const { user } = setup();
    await user.type(input(), "#work");
    expect(options()).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(TAGS_UNAVAILABLE);
  });

  it("says when nothing matches or nothing was opened yet", async () => {
    const { user } = setup(() => []);
    expect(screen.getByRole("status")).toHaveTextContent("Nothing opened yet");
    await user.type(input(), "zzz");
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent("No results");
  });

  it("renders at most 50 rows", () => {
    const many = Array.from({ length: 80 }, (_, index): SearchResult => ({
      kind: "note",
      id: `n${index}.md`,
      path: `n${index}.md`,
      title: `n${index}`,
      titleRanges: [],
    }));
    setup(() => many);
    expect(options()).toHaveLength(50);
  });
});
