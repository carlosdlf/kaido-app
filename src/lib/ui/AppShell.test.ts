import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { MemoryStorage, StorageError } from "$lib/storage";
import { AppState } from "./appState.svelte";
import AppShell from "./AppShell.svelte";

const ROOT = "/home/me/notes";

const files: Record<string, string> = {
  "inbox/tasks.md": "- [ ] try pino\n- [ ] renew TLS #ops\n- [x] done\n",
  "inbox/reading-list.md": "# Reading list\n\nArticles to read.",
  "api-payments/tasks.md": "- [ ] check timeouts\n- [x] configure CI\n",
  "api-payments/deploy.md": [
    "# Deploy",
    "",
    "Ship from a clean `main` branch. #devops",
    "",
    "## Release",
    "",
    "```sh",
    "pnpm build",
    "```",
    "",
    "### Notes",
    "",
    "- first",
    "- second",
    "",
    "- [x] configure CI",
    "- [ ] rotate keys #security",
  ].join("\n"),
  "api-payments/architecture.md": "# Architecture",
  "dotfiles/bootstrap.md": "",
  "_archive/old/a.md": "# Old",
};

function setup(
  options: { settings?: string | null; pick?: string | null; files?: Record<string, string> } = {},
) {
  const storage = new MemoryStorage({
    folders: { [ROOT]: { ...(options.files ?? files) } },
    settings:
      options.settings === undefined
        ? JSON.stringify({ version: 1, workspace: ROOT })
        : options.settings,
    pick: options.pick ?? null,
  });
  const app = new AppState(storage, { defer: (task) => task(), saveDelay: 10 });
  render(AppShell, { app });
  return { storage, app };
}

async function ready(options: Parameters<typeof setup>[0] = {}) {
  const context = setup(options);
  await context.app.start();
  await context.app.settled();
  await screen.findByRole("navigation", { name: "Workspace" });
  return context;
}

const nav = () => within(screen.getByRole("navigation", { name: "Workspace" }));
const list = () => within(screen.getByRole("region"));
const editor = () => within(screen.getByRole("main", { name: "Editor" }));
const textbox = () => editor().getByRole("textbox", { name: "Note text", hidden: true });
const editorText = () => {
  const view = EditorView.findFromDOM(textbox());
  if (!view) throw new Error("No editor view");
  return view;
};
/** Types at the end of the note, like a user would. */
const typeAtEnd = (text: string) => {
  const view = editorText();
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: "input" });
};
const fileText = async (storage: MemoryStorage, path: string) =>
  (await storage.readFile(path)).contents;

describe("AppShell without a workspace", () => {
  it("offers to open a folder and remembers the choice", async () => {
    const user = userEvent.setup();
    const { storage, app } = setup({ settings: null, pick: ROOT });
    await app.start();

    expect(await screen.findByRole("heading", { name: "Open a workspace" })).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Open folder…" });
    expect(button).toHaveFocus();
    await user.click(button);
    await app.settled();

    expect(await nav().findByRole("button", { name: /inbox/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(JSON.parse(storage.settings ?? "")).toMatchObject({ workspace: ROOT });
  });

  it("shows a loading screen while the folder opens", async () => {
    const { storage, app } = setup();
    let release: () => void = () => undefined;
    const open = storage.openWorkspace.bind(storage);
    vi.spyOn(storage, "openWorkspace").mockImplementationOnce(
      (path) => new Promise((resolve) => (release = () => resolve(open(path)))),
    );
    const started = app.start();
    expect(await screen.findByRole("heading", { name: "Opening workspace" })).toBeInTheDocument();
    expect(screen.getByText(ROOT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open folder…" })).toBeNull();
    release();
    await started;
    expect(await screen.findByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
  });

  it("explains a missing workspace and lets the user pick another", async () => {
    const user = userEvent.setup();
    const { app } = setup({
      settings: JSON.stringify({ version: 1, workspace: "/gone" }),
      pick: ROOT,
    });
    await app.start();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The folder /gone could not be found.",
    );
    await user.click(screen.getByRole("button", { name: "Open folder…" }));
    expect(await screen.findByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
  });

  it("renders nothing while settings are read", () => {
    const { container } = render(AppShell, { app: new AppState(new MemoryStorage()) });
    expect(container.textContent?.trim()).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("AppShell with a workspace", () => {
  it("shows projects, counts and the inbox task list", async () => {
    await ready();
    expect(nav().getByRole("button", { name: /inbox/ })).toHaveTextContent("[2]");
    expect(nav().getByRole("button", { name: /all-tasks/ })).toHaveTextContent("[3]");
    const projects = within(nav().getByRole("list", { name: "projects" }));
    expect(projects.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "▸ api-payments",
      "▸ dotfiles",
    ]);
    expect(screen.getByText("~/notes")).toBeInTheDocument();
    expect(list().getByRole("heading", { name: "~/inbox" })).toBeInTheDocument();
    expect(list().getByText("1 note · 2 tasks")).toBeInTheDocument();
    expect(editorText().state.doc.toString()).toBe(files["inbox/tasks.md"]);
    expect(textbox()).toHaveTextContent("- [ ] renew TLS #ops");
  });

  it("shows note names, titles and the note in the editor", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(nav().getByRole("button", { name: /api-payments/ }));
    expect(
      list().getByRole("button", { name: /architecture\.md.*Architecture/ }),
    ).toBeInTheDocument();

    await user.click(list().getByRole("button", { name: /deploy\.md/ }));
    await vi.waitFor(() => expect(textbox()).toHaveTextContent("# Deploy"));
    const content = textbox();
    // Markers stay visible, dimmed, inside sized headings.
    const text = (selector: string) =>
      [...content.querySelectorAll(selector)].map((element) => element.textContent).join("");
    expect(text(".cm-md-h1")).toBe("# Deploy");
    expect(text(".cm-md-h1.cm-md-mark")).toBe("#");
    expect(text(".cm-md-h2")).toBe("## Release");
    expect(content.querySelector(".cm-md-code")).toHaveTextContent("main");
    expect(content.querySelector(".cm-md-codeblock")).toHaveTextContent("```sh");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(editor().getByText(/^saved · /)).toBeInTheDocument();
    expect(editor().getByText("deploy.md")).toBeInTheDocument();
  });

  it("shows an empty note", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(nav().getByRole("button", { name: /dotfiles/ }));
    await vi.waitFor(() => expect(editor().getByText("bootstrap.md")).toBeInTheDocument());
    expect(textbox()).toBeVisible();
    expect(editorText().state.doc.length).toBe(0);
  });

  it("shows an empty workspace", async () => {
    await ready({ files: {} });
    expect(list().getByText("No notes yet.")).toBeInTheDocument();
    expect(nav().getByText("No projects yet")).toBeInTheDocument();
    expect(editor().getByText("No note selected.")).toBeInTheDocument();
  });

  it("lists task lists in all tasks", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(nav().getByRole("button", { name: /all-tasks/ }));
    expect(list().getAllByRole("button", { name: /\/tasks\.md/ })).toHaveLength(2);
    expect(list().getByText("3 open · 2 lists")).toBeInTheDocument();
  });

  it("says when there are no open tasks", async () => {
    const user = userEvent.setup();
    await ready({ files: { "inbox/tasks.md": "- [x] done" } });
    await user.click(nav().getByRole("button", { name: /all-tasks/ }));
    expect(list().getByText("No open tasks.")).toBeInTheDocument();
  });

  it("moves through folders and items with the keyboard", async () => {
    const user = userEvent.setup();
    await ready();

    nav().getByRole("button", { name: /inbox/ }).focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const api = nav().getByRole("button", { name: /api-payments/ });
    expect(api).toHaveFocus();
    expect(api).toHaveAttribute("aria-current", "page");

    await user.keyboard("{End}");
    expect(nav().getByRole("button", { name: /dotfiles/ })).toHaveAttribute("aria-current", "page");
    await user.keyboard("{Home}");
    expect(nav().getByRole("button", { name: /inbox/ })).toHaveAttribute("aria-current", "page");

    await user.click(list().getByRole("button", { name: /reading-list\.md/ }));
    await user.keyboard("{ArrowUp}");
    const tasks = list().getByRole("button", { name: /tasks\.md/ });
    expect(tasks).toHaveFocus();
    expect(tasks).toHaveAttribute("aria-current", "true");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(textbox()).toHaveTextContent("try pino"));
  });

  it("ignores arrow keys on buttons that are not folders", async () => {
    const user = userEvent.setup();
    await ready();
    nav()
      .getByRole("button", { name: /new project/ })
      .focus();
    await user.keyboard("{ArrowDown}");
    expect(nav().getByRole("button", { name: /inbox/ })).toHaveAttribute("aria-current", "page");
  });

  it("follows external edits", async () => {
    const { storage, app } = await ready();
    storage.setExternal("inbox/tasks.md", "- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n");
    await app.settled();
    await vi.waitFor(() => expect(textbox()).toHaveTextContent("- [ ] d"));
    expect(nav().getByRole("button", { name: /inbox/ })).toHaveTextContent("[4]");
  });

  it("tells when the open file was deleted", async () => {
    const { storage, app } = await ready();
    storage.setExternal("inbox/tasks.md", null);
    await app.settled();
    expect(await editor().findByRole("status")).toHaveTextContent("This file no longer exists.");
  });

  it("shows read errors", async () => {
    const user = userEvent.setup();
    const { storage } = await ready();
    vi.spyOn(storage, "readFile").mockRejectedValueOnce(
      new StorageError("InvalidUtf8", "not UTF-8"),
    );
    await user.click(list().getByRole("button", { name: /reading-list\.md/ }));
    expect(await editor().findByRole("alert")).toHaveTextContent(
      "Could not read this file: not UTF-8",
    );
  });

  it("lists settings warnings", async () => {
    const user = userEvent.setup();
    await ready({ files: { ...files, ".kaido/config.json": "[]" } });
    await user.click(screen.getByText(/1 settings warning/));
    expect(screen.getByText(/config\.json: expected a JSON object/)).toBeVisible();
  });

  it("shows placeholders while counts load", async () => {
    const user = userEvent.setup();
    const storage = new MemoryStorage({
      folders: { [ROOT]: files },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
    });
    const app = new AppState(storage, { defer: () => undefined });
    render(AppShell, { app });
    await app.start();
    const allTasks = await nav().findByRole("button", { name: /counting open tasks/ });
    expect(allTasks).toHaveTextContent("[…]");
    await user.click(allTasks);
    expect(list().getByText("… open · 2 lists")).toBeInTheDocument();
    expect(list().getByRole("button", { name: /api-payments\/tasks\.md/ })).toHaveTextContent(
      "… open",
    );
  });

  it("refreshes a row's age after an external edit", async () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    let time = twoDaysAgo;
    const storage = new MemoryStorage({
      folders: { [ROOT]: { ...files } },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
      now: () => time,
    });
    const app = new AppState(storage, { defer: (task) => task() });
    render(AppShell, { app });
    await app.start();
    await app.settled();
    const row = () => list().getByRole("button", { name: /reading-list\.md/ });
    expect(row()).toHaveTextContent("2d");
    time = Date.now();
    storage.setExternal("inbox/reading-list.md", "# Reading list v2");
    await app.settled();
    await vi.waitFor(() => expect(row()).toHaveTextContent(/now\s*Reading list v2/));
  });

  it("explains notes that are too large to open", async () => {
    const user = userEvent.setup();
    const { storage } = await ready();
    vi.spyOn(storage, "readFile").mockRejectedValueOnce(new StorageError("TooLarge", "big"));
    await user.click(list().getByRole("button", { name: /reading-list\.md/ }));
    expect(await editor().findByRole("status")).toHaveTextContent(
      "This file is larger than 8 MiB, too large to open in Kaido.",
    );
  });

  it("shows when the workspace can no longer be refreshed and offers another folder", async () => {
    const user = userEvent.setup();
    const { storage, app } = await ready();
    storage.pick = ROOT;
    vi.spyOn(storage, "listFiles").mockRejectedValueOnce(new StorageError("NotFound", "gone"));
    storage.emitChange({ paths: [], rescan: true });
    await app.settled();
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("The workspace folder is no longer available.");
    await user.click(within(notice).getByRole("button", { name: "Open folder…" }));
    await app.settled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AppShell editing", () => {
  it("saves typed text and shows the save state", async () => {
    const { storage } = await ready();
    typeAtEnd("- [ ] new task\n");
    expect(await editor().findByText("unsaved")).toBeInTheDocument();
    await vi.waitFor(async () =>
      expect(await fileText(storage, "inbox/tasks.md")).toContain("- [ ] new task"),
    );
    await vi.waitFor(() => expect(editor().getByText("saved · just now")).toBeInTheDocument());
    await vi.waitFor(() =>
      expect(nav().getByRole("button", { name: /inbox/ })).toHaveTextContent("[3]"),
    );
  });

  it("keeps the line breaks of a CRLF note", async () => {
    const crlf = "- [ ] one\r\n- [ ] two\r\n";
    const { storage } = await ready({ files: { "inbox/tasks.md": crlf } });
    await vi.waitFor(() => expect(textbox()).toHaveTextContent("- [ ] two"));
    expect(editor().getByText(/^saved · /)).toBeInTheDocument();
    expect(undo(editorText())).toBe(false);
    typeAtEnd("x");
    await vi.waitFor(async () =>
      expect(await fileText(storage, "inbox/tasks.md")).toBe(`${crlf}x`),
    );
  });

  it("keeps undo history when switching notes", async () => {
    const user = userEvent.setup();
    const { storage } = await ready();
    typeAtEnd("extra");
    await user.click(list().getByRole("button", { name: /reading-list\.md/ }));
    await vi.waitFor(() => expect(textbox()).toHaveTextContent("# Reading list"));
    // Switching saved the first note right away.
    expect(await fileText(storage, "inbox/tasks.md")).toContain("extra");

    await user.click(list().getByRole("button", { name: /tasks\.md/ }));
    await vi.waitFor(() => expect(textbox()).toHaveTextContent("extra"));
    expect(undo(editorText())).toBe(true);
    expect(editorText().state.doc.toString()).toBe(files["inbox/tasks.md"]);
    await vi.waitFor(async () =>
      expect(await fileText(storage, "inbox/tasks.md")).toBe(files["inbox/tasks.md"]),
    );
  });

  it("saves when the window loses focus", async () => {
    const storage = new MemoryStorage({
      folders: { [ROOT]: { ...files } },
      settings: JSON.stringify({ version: 1, workspace: ROOT }),
    });
    const app = new AppState(storage, { defer: (task) => task(), saveDelay: 60_000 });
    render(AppShell, { app });
    await app.start();
    await app.settled();
    await vi.waitFor(() => expect(textbox()).toBeInTheDocument());
    typeAtEnd("on blur");
    window.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(async () =>
      expect(await fileText(storage, "inbox/tasks.md")).toContain("on blur"),
    );
  });

  it("keeps both versions on a conflict and says so", async () => {
    const user = userEvent.setup();
    const { storage, app } = await ready();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new StorageError("Io", "disk busy"));
    typeAtEnd("mine");
    expect(
      await editor().findByText("save failed — retrying", {}, { timeout: 2_000 }),
    ).toHaveAttribute("title", "disk busy");
    storage.setExternal("inbox/tasks.md", "theirs\n");
    await app.settled();
    const toast = await screen.findByText(
      /^Changed outside Kaido — the other version was saved as tasks \(conflict \d{4}-\d\d-\d\d \d{4}\)\.md$/,
    );
    expect(toast.closest("[role=status]")).not.toBeNull();
    expect(await fileText(storage, "inbox/tasks.md")).toContain("mine");
    expect(editorText().state.doc.toString()).toContain("mine");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Changed outside Kaido/)).toBeNull();
  });

  it("hides the editor for a missing note", async () => {
    const { storage, app } = await ready();
    storage.setExternal("inbox/tasks.md", null);
    await app.settled();
    expect(await editor().findByRole("status")).toHaveTextContent("This file no longer exists.");
    expect(textbox()).not.toBeVisible();
  });
});

describe("AppShell new note", () => {
  it("creates a note with Ctrl+N and focuses the editor", async () => {
    const user = userEvent.setup();
    const { storage, app } = await ready();
    await user.click(nav().getByRole("button", { name: /api-payments/ }));
    await app.settled();

    await user.keyboard("{Control>}n{/Control}");
    await app.settled();

    expect(await fileText(storage, "api-payments/untitled.md")).toBe("");
    expect(list().getByRole("button", { name: /untitled\.md/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(editor().getByText("untitled.md")).toBeInTheDocument();
    await waitFor(() => expect(textbox()).toHaveFocus());

    // Typing goes straight into the new note and is saved.
    typeAtEnd("# Plan");
    await waitFor(async () =>
      expect(await fileText(storage, "api-payments/untitled.md")).toBe("# Plan"),
    );
  });

  it("works while typing in the editor and ignores held keys", async () => {
    const { app } = await ready();
    const create = vi.spyOn(app, "createNote");
    textbox().focus();
    fireEvent.keyDown(textbox(), { key: "n", ctrlKey: true, repeat: true });
    expect(create).not.toHaveBeenCalled();
    const event = createEvent.keyDown(textbox(), { key: "n", ctrlKey: true });
    fireEvent(textbox(), event);
    expect(event.defaultPrevented).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    await app.settled();
    // Other modifiers are left alone.
    fireEvent.keyDown(window, { key: "n", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(create).toHaveBeenCalledOnce();
  });

  it("creates a note in the inbox from the button", async () => {
    const user = userEvent.setup();
    const { storage, app } = await ready();
    await user.click(nav().getByRole("button", { name: /all-tasks/ }));
    const button = list().getByRole("button", { name: "New note" });
    expect(button).toHaveAttribute("aria-keyshortcuts", "Control+N");
    await user.click(button);
    await app.settled();
    expect(await fileText(storage, "inbox/untitled.md")).toBe("");
    expect(app.folder).toBe("inbox");
    await waitFor(() => expect(textbox()).toHaveFocus());
  });

  it("shows a toast when the note cannot be created", async () => {
    const user = userEvent.setup();
    const { storage, app } = await ready();
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(
      new StorageError("PermissionDenied", "inbox is read-only."),
    );
    await user.click(list().getByRole("button", { name: "New note" }));
    await app.settled();
    expect(
      await screen.findByText("The note could not be created: inbox is read-only."),
    ).toBeInTheDocument();
    expect(app.item).toBe("inbox/tasks.md");
  });
});
