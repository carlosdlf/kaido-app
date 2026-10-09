<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    ALL_TASKS,
    listItems,
    listSummary,
    listTitle,
    MAX_SUMMARY_BYTES,
    sidebarEntries,
    totalOpen,
  } from "$lib/core/views";
  import { isNewNoteShortcut, newNoteShortcutLabels } from "$lib/core/newNote";
  import { isNewProjectShortcut, newProjectShortcutLabels } from "$lib/core/projectNames";
  import {
    isSyncShortcut,
    isViewModeShortcut,
    syncShortcutLabels,
    viewModeShortcutLabels,
  } from "$lib/core/shortcuts";
  import { describeSync } from "$lib/core/syncStatus";
  import { openTaskCount, type InsertPosition, type TaskRef } from "$lib/core/taskDocument";
  import { allTaskRows, taskRows, type RowOptions } from "$lib/core/taskRows";
  import { taskGroups } from "$lib/core/taskIndex";
  import { isTaskListPath } from "$lib/core/workspace";
  import { oversizedTasksMessage, TASK_CHANGED, type AppState } from "./appState.svelte";
  import EditorPane from "./EditorPane.svelte";
  import ListPane from "./ListPane.svelte";
  import Sidebar from "./Sidebar.svelte";
  import StartScreen from "./StartScreen.svelte";
  import TaskPane from "./TaskPane.svelte";
  import type { ViewMode } from "./ViewModeSwitch.svelte";
  import Toasts from "./Toasts.svelte";
  import { isMac } from "./platform";

  let { app }: { app: AppState } = $props();

  /** Refreshed every minute so relative ages stay current. */
  let now = $state(Date.now());

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  const entries = $derived(sidebarEntries(app.workspace, app.summaries));
  const items = $derived(listItems(app.workspace, app.folder, app.summaries));
  const workspaceName = $derived(
    app.phase.kind === "ready" ? (app.phase.root.split(/[\\/]/).filter(Boolean).pop() ?? "") : "",
  );

  const COPY_FAILED = "The path could not be copied to the clipboard.";

  const mac = isMac();
  const newNoteShortcut = newNoteShortcutLabels(mac);
  const newProjectShortcut = newProjectShortcutLabels(mac);
  const viewModeShortcut = viewModeShortcutLabels(mac);
  const syncShortcut = syncShortcutLabels(mac);
  const syncView = $derived(app.sync ? describeSync(app.sync, now) : null);

  /** The main pane shows the combined task view. */
  const showAll = $derived(app.item === ALL_TASKS);
  /** The main pane shows the selected task list as tasks (not as text). */
  const showList = $derived(isTaskListPath(app.item) && !app.taskTextMode);
  const listDoc = $derived(showList ? app.taskDocs.get(app.item) : undefined);
  const listRows = $derived(listDoc ? taskRows(app.item, listDoc, rowOptions(app.item)) : []);
  const groups = $derived(showAll ? taskGroups(app.workspace, app.taskDocs) : []);
  const allRows = $derived(allTaskRows(groups, rowOptions(ALL_TASKS)));
  /** Task lists too large to keep parsed, so All tasks cannot show them. */
  const oversized = $derived(
    showAll
      ? app.workspace.projects
          .map((project) => project.tasks)
          .filter(
            (file) =>
              file !== null && file.size > MAX_SUMMARY_BYTES && !app.taskDocs.has(file.path),
          )
          .map((file) => file?.path ?? "")
      : [],
  );
  const allOpenCount = $derived(groups.reduce((sum, group) => sum + openTaskCount(group.doc), 0));

  /** Why the selected task list cannot be shown, if it cannot. */
  const listMessage = $derived.by(() => {
    if (listDoc) return null;
    const doc = app.document;
    if (doc?.path !== app.item) return null;
    if (doc.status === "missing") return { text: "This file no longer exists.", alert: false };
    if (doc.status === "too-large")
      return {
        text: "This file is larger than 8 MiB, too large to open in Kaido.",
        alert: false,
      };
    if (doc.status === "error")
      return { text: `Could not read this file: ${doc.message}`, alert: true };
    return { text: "", alert: false };
  });

  /** Bumped to open the new project field in the sidebar. */
  let newProjectRequest = $state(0);
  /** Bumped to give focus back to the task list. */
  let taskFocusFallback = $state(0);
  let shell: HTMLElement | undefined = $state();

  /**
   * Shows the selected task list as a list or as text. From the switch, focus
   * stays on the switch (now in the other pane); from the shortcut it goes
   * into the editor or to the task list, so typing can go on.
   */
  async function setViewMode(mode: ViewMode, from: "switch" | "shortcut") {
    app.setTaskTextMode(mode === "text");
    if (from === "shortcut" && mode === "text") {
      app.editorFocusRequest += 1;
      return;
    }
    await tick();
    const row =
      from === "shortcut"
        ? shell?.querySelector<HTMLElement>("[data-row-key] [data-focus][tabindex='0']")
        : null;
    const option = shell?.querySelector<HTMLElement>("[data-view-switch] [aria-checked='true']");
    (row ?? option)?.focus();
  }

  function pick() {
    void app.pickWorkspace();
  }

  function createNote() {
    void app.createNote();
  }

  /** Bumped to move focus to the selected list row. */
  let listFocus = $state(0);

  const taskActions = $derived({
    focusRequest: app.taskFocus,
    onfocusdone: () => (app.taskFocus = null),
    focusFallback: taskFocusFallback,
    ontoggle: (path: string, ref: TaskRef) => app.toggleTask(path, ref),
    onadd: (path: string, text: string, position: InsertPosition) =>
      app.addTask(path, text, position),
    onedit: (path: string, ref: TaskRef, text: string) => app.editTask(path, ref, text),
    ondelete: (path: string, ref: TaskRef) => void app.deleteTask(path, ref),
    onmove: (path: string, ref: TaskRef, direction: -1 | 1) => app.moveTask(path, ref, direction),
    onsetdetail: (path: string, ref: TaskRef, detail: string) =>
      app.setTaskDetail(path, ref, detail),
    onopennote: (path: string, ref: TaskRef) => app.openTaskNote(path, ref),
    oncreatenote: (path: string, ref: TaskRef) => void app.createNoteFromTask(path, ref),
    oncopytext: (text: string) => copyText(text, "Copied the task text"),
    onundo: undoLatest,
    onstale: () => app.notify(TASK_CHANGED),
  });
  /** Row options for a list (or `ALL_TASKS`): its hide-done state and the notes that exist. */
  function rowOptions(key: string): RowOptions {
    return { hideDone: app.hideDone.has(key), exists: (path) => app.hasNote(path) };
  }

  function copyText(text: string, done: string) {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard) {
      app.notify(COPY_FAILED);
      return;
    }
    clipboard.writeText(text).then(
      () => app.notify(done),
      () => app.notify(COPY_FAILED),
    );
  }

  function copyPath(path: string) {
    copyText(path, `Copied ${path}`);
  }

  async function undo(id: number) {
    // A restored task is focused by its task view, a created note by the editor.
    if ((await app.undoDelete(id)) === "note") listFocus += 1;
  }

  async function runAction(id: number) {
    if ((await app.runToastAction(id)) === "note") listFocus += 1;
  }

  function focusExit() {
    if (showAll || showList) taskFocusFallback += 1;
    else listFocus += 1;
  }

  function undoLatest() {
    const id = app.latestUndo;
    if (id !== null) void undo(id);
  }

  const NOT_TYPED = new Set([
    "checkbox",
    "radio",
    "button",
    "submit",
    "reset",
    "range",
    "color",
    "file",
  ]);

  /** A text field the user types into (the note editor is not one: it handles few such keys). */
  function isTyping(target: EventTarget | null): boolean {
    if (target instanceof HTMLTextAreaElement) return true;
    return target instanceof HTMLInputElement && !NOT_TYPED.has(target.type);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    if (isSyncShortcut(event, mac)) {
      // Works everywhere, the editor included; the browser would offer to save the page.
      event.preventDefault();
      if (!event.repeat) app.syncNow();
      return;
    }
    if (isNewProjectShortcut(event, mac)) {
      event.preventDefault();
      if (!event.repeat && app.phase.kind === "ready") newProjectRequest += 1;
      return;
    }
    if (isViewModeShortcut(event, mac)) {
      // Typing in a field keeps the keys; the note editor is not such a field.
      if (isTyping(event.target)) return;
      if (!isTaskListPath(app.item)) return;
      event.preventDefault();
      if (!event.repeat) void setViewMode(app.taskTextMode ? "list" : "text", "shortcut");
      return;
    }
    if (!isNewNoteShortcut(event, mac)) return;
    // Keep the webview from opening a window; holding the keys creates one note.
    event.preventDefault();
    if (event.repeat || app.phase.kind !== "ready") return;
    createNote();
  }
</script>

<!-- Save pending edits as soon as the user leaves the window. -->
<svelte:window
  onblur={() => void app.flush()}
  onfocus={() => app.windowFocused()}
  onkeydown={handleKeydown}
/>

<Toasts
  toasts={app.toasts}
  ondismiss={(id) => app.dismissToast(id)}
  onaction={(id) => void runAction(id)}
  onfocusexit={focusExit}
/>

{#if app.phase.kind === "ready"}
  <div class="shell" bind:this={shell}>
    <Sidebar
      {entries}
      allOpen={totalOpen(entries)}
      {workspaceName}
      warnings={app.warnings.map((warning) => warning.message)}
      notice={app.notice}
      onpick={pick}
      selected={app.folder}
      onselect={(id) => app.selectFolder(id)}
      oncreateproject={(name) => app.createProject(name)}
      createProjectShortcut={newProjectShortcut}
      {newProjectRequest}
      sync={syncView}
      onsync={() => app.syncNow()}
      {syncShortcut}
    />
    <ListPane
      title={listTitle(app.folder)}
      summary={listSummary(app.workspace, app.folder, app.summaries)}
      {items}
      emptyMessage={app.folder === ALL_TASKS ? "No open tasks." : "No notes yet."}
      {now}
      selected={app.item}
      onselect={(id) => app.selectItem(id)}
      oncreate={createNote}
      createShortcut={newNoteShortcut}
      onrename={(id, name) => app.renameNote(id, name)}
      ondelete={(id) => void app.deleteNote(id)}
      oncopypath={copyPath}
      onundo={undoLatest}
      focusRequest={listFocus}
    />
    {#if showAll}
      <TaskPane
        label="All tasks"
        title="~/all-tasks"
        summary="{allOpenCount} open"
        rows={allRows}
        listPath={null}
        emptyMessage="No open tasks."
        notice={oversized.length > 0 ? oversizedTasksMessage(oversized) : null}
        {now}
        hideDone={app.hideDone.has(ALL_TASKS)}
        ontogglehidedone={() => app.toggleHideDone(ALL_TASKS)}
        {...taskActions}
      />
    {:else if showList}
      <TaskPane
        label="Tasks"
        title={app.item}
        rows={listRows}
        listPath={listDoc ? app.item : null}
        emptyMessage=""
        message={listMessage}
        status={app.saveStatus}
        {now}
        onviewmode={(mode) => void setViewMode(mode, "switch")}
        viewShortcut={viewModeShortcut}
        hideDone={app.hideDone.has(app.item)}
        ontogglehidedone={() => app.toggleHideDone(app.item)}
        {...taskActions}
      />
    {/if}
    <!-- Kept while a task view is shown, so notes keep their editor state. -->
    <EditorPane
      doc={showAll || showList ? null : app.document}
      hidden={showAll || showList}
      status={app.saveStatus}
      {now}
      focusRequest={app.editorFocusRequest}
      onedit={(path, read) => app.edit(path, read)}
      pathChanges={app.editorChanges}
      onviewmode={isTaskListPath(app.item)
        ? (mode: ViewMode) => void setViewMode(mode, "switch")
        : undefined}
      viewShortcut={viewModeShortcut}
    />
  </div>
{:else if app.phase.kind === "no-workspace"}
  <StartScreen
    title="Open a workspace"
    message="Choose a folder for your notes and tasks. It can be an existing git repository or an empty folder."
    onpick={pick}
  />
{:else if app.phase.kind === "loading"}
  <StartScreen title="Opening workspace" message={app.phase.path} busy onpick={pick} />
{:else if app.phase.kind === "error"}
  <StartScreen
    title="Could not open the workspace"
    message={app.phase.message}
    error
    onpick={pick}
  />
{/if}

<style>
  .shell {
    display: grid;
    grid-template-columns:
      minmax(200px, var(--sidebar-width))
      minmax(220px, var(--list-width))
      minmax(0, 1fr);
    height: 100%;
    overflow: hidden;
  }
</style>
