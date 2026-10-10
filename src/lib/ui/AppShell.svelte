<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import {
    ALL_TASKS,
    archivedEntries,
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
    isSearchShortcut,
    isSettingsShortcut,
    isSyncShortcut,
    isViewModeShortcut,
    searchShortcutLabels,
    settingsShortcutLabels,
    syncShortcutLabels,
    viewModeShortcutLabels,
  } from "$lib/core/shortcuts";
  import { PALETTE_COMMANDS, type PaletteCommandId } from "$lib/core/palette";
  import { describeSync } from "$lib/core/syncStatus";
  import { openTaskCount, type InsertPosition, type TaskRef } from "$lib/core/taskDocument";
  import { allTaskRows, taskRows, type RowOptions } from "$lib/core/taskRows";
  import { taskGroups } from "$lib/core/taskIndex";
  import {
    findProjectByKey,
    isTaskListPath,
    projectKeyOf,
    projectNameOf,
  } from "$lib/core/workspace";
  import { noteMoveTargets, taskMoveTargets } from "$lib/core/moveTargets";
  import { folderOf } from "$lib/core/pathMoves";
  import { baseName } from "$lib/core/saveMachine";
  import { EDITOR_FONT_SIZE_MAX, EDITOR_FONT_SIZE_MIN } from "$lib/config/settings";
  import { sameAccelerator } from "$lib/core/accelerator";
  import { folderName } from "$lib/core/workspaceLocation";
  import { oversizedTasksMessage, TASK_CHANGED, type AppState } from "./appState.svelte";
  import SettingsDialog from "./SettingsDialog.svelte";
  import MovePicker from "./MovePicker.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import SetupBanner from "./SetupBanner.svelte";
  import { APP_VERSION } from "./version";
  import EditorPane from "./EditorPane.svelte";
  import ListPane from "./ListPane.svelte";
  import Sidebar from "./Sidebar.svelte";
  import StartScreen from "./StartScreen.svelte";
  import TaskPane from "./TaskPane.svelte";
  import type { ViewMode } from "./ViewModeSwitch.svelte";
  import Toasts from "./Toasts.svelte";
  import SearchPalette from "./SearchPalette.svelte";
  import { isMac } from "./platform";

  interface Props {
    app: AppState;
    /** Quick capture can be configured (the desktop app). */
    captureAvailable?: boolean;
  }

  let { app, captureAvailable = false }: Props = $props();

  /** Refreshed every minute so relative ages stay current. */
  let now = $state(Date.now());

  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });

  const entries = $derived(sidebarEntries(app.workspace, app.summaries));
  const archived = $derived(archivedEntries(app.workspace));
  const items = $derived(listItems(app.workspace, app.folder, app.summaries));
  const workspaceName = $derived(app.phase.kind === "ready" ? folderName(app.phase.root) : "");

  const COPY_FAILED = "The path could not be copied to the clipboard.";

  const mac = isMac();
  const newNoteShortcut = newNoteShortcutLabels(mac);
  const newProjectShortcut = newProjectShortcutLabels(mac);
  const viewModeShortcut = viewModeShortcutLabels(mac);
  const syncShortcut = syncShortcutLabels(mac);
  const searchShortcut = searchShortcutLabels(mac);
  const settingsShortcut = settingsShortcutLabels(mac);

  // The editor and task views follow the font size setting; the chrome keeps its size.
  $effect(() => {
    document.documentElement.style.setProperty(
      "--font-size-editor",
      `${app.settings.editorFontSize}px`,
    );
  });

  /** The settings dialog is shown. */
  let settingsOpen = $state(false);
  /** Where focus goes when the settings dialog closes. */
  let settingsReturn: HTMLElement | null = $state.raw(null);
  /** The start screen is shown over an open workspace, to switch to another one. */
  let switching = $state(false);
  const showStart = $derived(
    app.phase.kind === "ready" ? switching : app.phase.kind !== "starting",
  );

  // Opening a workspace ends switching; the start screen checks for git each time it shows.
  $effect(() => {
    if (app.phase.kind === "loading") switching = false;
  });
  $effect(() => {
    if (showStart) untrack(() => void app.checkGit());
  });

  const startView = $derived.by(() => {
    switch (app.phase.kind) {
      case "loading":
        return { title: "Opening workspace", message: app.phase.path, error: false, busy: true };
      case "error":
        return {
          title: "Could not open the workspace",
          message: app.phase.message,
          error: true,
          busy: false,
        };
      case "ready":
        return { title: "Switch workspace", message: "", error: false, busy: false };
      default:
        return {
          title: "Open a workspace",
          message:
            "Choose a folder for your notes and tasks. It can be an existing git repository or an empty folder.",
          error: false,
          busy: false,
        };
    }
  });

  const shortcutUnavailable = $derived(
    app.settings.captureShortcut !== null &&
      app.captureShortcut !== null &&
      !(
        app.captureShortcut.registered &&
        sameAccelerator(app.captureShortcut.shortcut, app.settings.captureShortcut)
      ),
  );

  /** The focused element, if any besides the page itself. */
  function focusedElement(): HTMLElement | null {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  }

  /** Opens settings; focus returns to `returnTo` when they close. */
  function openSettings(returnTo = focusedElement()) {
    if (app.phase.kind === "loading") return;
    settingsReturn = returnTo;
    settingsOpen = true;
  }
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

  /** Where a note or task is being moved, while the picker is shown. */
  type MoveRequest = { kind: "note"; path: string } | { kind: "task"; path: string; ref: TaskRef };
  let moveRequest: MoveRequest | null = $state.raw(null);
  const moveTargets = $derived.by(() => {
    const request = moveRequest;
    if (!request) return [];
    return request.kind === "note"
      ? noteMoveTargets(app.workspace, folderOf(request.path))
      : taskMoveTargets(app.workspace, projectKeyOf(request.path));
  });

  async function chooseMoveTarget(folder: string): Promise<string | null> {
    const request = moveRequest;
    if (!request) return null;
    const outcome =
      request.kind === "note"
        ? await app.moveNote(request.path, folder)
        : await app.moveTaskToProject(request.path, request.ref, folder);
    return outcome.kind === "invalid" ? outcome.reason : null;
  }

  function closeMovePicker() {
    const request = moveRequest;
    moveRequest = null;
    // The row the item had may be gone; focus goes to what is selected now.
    if (request?.kind === "note") listFocus += 1;
    else taskFocusFallback += 1;
  }

  /** The project waiting for the delete confirmation. */
  let deleteRequest: { key: string; name: string; notes: number; tasks: number } | null =
    $state.raw(null);

  function requestDelete(key: string) {
    if (!findProjectByKey(app.workspace, key)) return;
    deleteRequest = { key, name: projectNameOf(key), ...app.projectContents(key) };
  }

  async function confirmDelete() {
    const request = deleteRequest;
    deleteRequest = null;
    if (!request) return;
    await app.deleteProject(request.key);
    await tick();
    shell?.querySelector<HTMLElement>("[data-nav-id][aria-current='page']")?.focus();
  }

  function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
  }

  /** A modal dialog of the shell is shown; global shortcuts wait. */
  const modalOpen = $derived(moveRequest !== null || deleteRequest !== null);

  /** The search palette is shown. */
  let paletteOpen = $state(false);
  /** What had focus before the palette opened, for commands that replace it. */
  let paletteReturn: HTMLElement | null = null;

  function openPalette() {
    if (app.phase.kind !== "ready") return;
    paletteReturn = focusedElement();
    paletteOpen = true;
  }

  // The palette belongs to the open workspace; it never comes back by itself.
  $effect(() => {
    if (app.phase.kind !== "ready") paletteOpen = false;
  });

  /** Commands the palette offers for what is shown now. */
  const paletteCommands = $derived(
    PALETTE_COMMANDS.filter((command) => {
      switch (command.id) {
        case "sync-now":
          return app.sync !== null;
        case "toggle-hide-done":
          return showAll || showList;
        case "switch-view":
          return isTaskListPath(app.item);
        default:
          return true;
      }
    }),
  );

  function runCommand(id: PaletteCommandId) {
    switch (id) {
      case "new-note":
        createNote();
        return;
      case "new-project":
        newProjectRequest += 1;
        return;
      case "sync-now":
        app.syncNow();
        return;
      case "toggle-hide-done":
        app.toggleHideDone(showAll ? ALL_TASKS : app.item);
        return;
      case "switch-view":
        void setViewMode(app.taskTextMode ? "list" : "text", "shortcut");
        return;
      case "settings":
        // Focus goes back to where it was before the palette, not to the palette.
        openSettings(paletteReturn);
        return;
    }
  }

  /**
   * Opens the palette with `Ctrl+K` / `Cmd+K` from anywhere, the note editor
   * included, so it runs before the focused element sees the key. While the
   * palette is open, the palette handles the key itself.
   */
  function handleKeydownCapture(event: KeyboardEvent) {
    // The settings dialog handles its own keys, such as a shortcut being recorded.
    if (event.isComposing || settingsOpen || modalOpen) return;
    if (isSettingsShortcut(event, mac)) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        const returnTo = paletteOpen ? paletteReturn : focusedElement();
        paletteOpen = false;
        openSettings(returnTo);
      }
      return;
    }
    if (!isSearchShortcut(event, mac) || paletteOpen) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) openPalette();
  }

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
    onmovetoproject: (path: string, ref: TaskRef) => {
      moveRequest = { kind: "task", path, ref };
    },
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

  function undoProject() {
    const id = app.latestProjectUndo;
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
    if (event.defaultPrevented || event.isComposing || modalOpen) return;
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
  onkeydowncapture={handleKeydownCapture}
/>

<Toasts
  toasts={app.toasts}
  ondismiss={(id) => app.dismissToast(id)}
  onaction={(id) => void runAction(id)}
  onfocusexit={focusExit}
/>

{#if !showStart && app.phase.kind === "ready"}
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
      onsearch={openPalette}
      {searchShortcut}
      {archived}
      onrenameproject={(key, name) => app.renameProject(key, name)}
      onarchive={(name) => void app.archiveProject(name)}
      onunarchive={(name) => void app.unarchiveProject(name)}
      ondeleteproject={requestDelete}
      oncopypath={copyPath}
      onundo={undoProject}
      onsettings={() => openSettings()}
      {settingsShortcut}
    />
    {#if app.setupBanner}
      <div class="banner">
        <SetupBanner
          onsetup={() => app.setUpWorkspace()}
          ondismiss={() => app.dismissSetup()}
          onfocusexit={() => (listFocus += 1)}
        />
      </div>
    {/if}
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
      onmove={(id) => (moveRequest = { kind: "note", path: id })}
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
      reveal={app.editorReveal}
      onedit={(path, read) => app.edit(path, read)}
      pathChanges={app.editorChanges}
      onviewmode={isTaskListPath(app.item)
        ? (mode: ViewMode) => void setViewMode(mode, "switch")
        : undefined}
      viewShortcut={viewModeShortcut}
    />
  </div>
  {#if paletteOpen}
    <SearchPalette
      search={(query) => app.search(query)}
      revision={app.searchRevision}
      commands={paletteCommands}
      onopen={(result) => app.openSearchResult(result)}
      onrun={runCommand}
      onclose={() => (paletteOpen = false)}
    />
  {/if}
{:else if showStart}
  <StartScreen
    title={startView.title}
    message={startView.message}
    error={startView.error}
    busy={startView.busy}
    git={app.gitInfo}
    recents={app.settings.recentWorkspaces}
    missing={app.missingWorkspaces}
    current={app.phase.kind === "ready" ? app.phase.root : null}
    onpick={pick}
    onopenrecent={(path) => void app.openWorkspace(path)}
    onremoverecent={(path) => app.removeRecentWorkspace(path)}
    onpickfolder={() => app.pickFolder()}
    oncreate={(parent, name) => app.createWorkspace(parent, name)}
    onclone={(url, parent, name) => app.cloneWorkspace(url, parent, name)}
    oncancelclone={() => void app.cancelClone()}
    onback={() => (switching = false)}
  />
{/if}

{#if moveRequest && app.phase.kind === "ready"}
  <MovePicker
    title={moveRequest.kind === "note"
      ? `Move ${baseName(moveRequest.path)} to…`
      : "Move task to project…"}
    targets={moveTargets}
    returnFocus={null}
    onchoose={chooseMoveTarget}
    onclose={closeMovePicker}
  />
{/if}

{#if deleteRequest}
  <ConfirmDialog
    title="Delete project"
    confirmLabel="Delete"
    danger
    onconfirm={() => void confirmDelete()}
    oncancel={() => (deleteRequest = null)}
  >
    Delete project <strong>{deleteRequest.name}</strong>? Its folder ({plural(
      deleteRequest.notes,
      "note",
    )}, {plural(deleteRequest.tasks, "task")}) moves to the system trash.
  </ConfirmDialog>
{/if}

{#if settingsOpen}
  <SettingsDialog
    returnFocus={settingsReturn}
    workspace={app.phase.kind === "ready" ? app.phase.root : null}
    setupMissing={app.setupMissing}
    fontSize={app.settings.editorFontSize}
    fontMin={EDITOR_FONT_SIZE_MIN}
    fontMax={EDITOR_FONT_SIZE_MAX}
    autoSync={app.settings.autoSync}
    shortcut={app.settings.captureShortcut}
    {shortcutUnavailable}
    {captureAvailable}
    version={APP_VERSION}
    onswitch={() => {
      settingsOpen = false;
      switching = true;
    }}
    onsetup={() => app.setUpWorkspace()}
    onfontsize={(size) => app.setEditorFontSize(size)}
    onautosync={(on) => app.setAutoSync(on)}
    onshortcut={(accelerator) => app.setCaptureShortcut(accelerator)}
    oncopy={(text) => copyText(text, "Copied the link")}
    onclose={() => (settingsOpen = false)}
  />
{/if}

<style>
  .shell {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-columns:
      minmax(200px, var(--sidebar-width))
      minmax(220px, var(--list-width))
      minmax(0, 1fr);
    height: 100%;
    overflow: hidden;
  }

  /* The setup banner sits above the list and the main pane; the sidebar spans both rows. */
  .shell > :global(*) {
    grid-row: 2;
  }

  .shell > :global(:first-child) {
    grid-row: 1 / -1;
  }

  .shell > .banner {
    grid-row: 1;
    grid-column: 2 / -1;
  }
</style>
