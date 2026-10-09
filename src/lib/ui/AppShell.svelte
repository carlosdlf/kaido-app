<script lang="ts">
  import { onMount } from "svelte";
  import {
    ALL_TASKS,
    listItems,
    listSummary,
    listTitle,
    sidebarEntries,
    totalOpen,
  } from "$lib/core/views";
  import { isNewNoteShortcut, newNoteShortcutLabels } from "$lib/core/newNote";
  import type { AppState } from "./appState.svelte";
  import EditorPane from "./EditorPane.svelte";
  import ListPane from "./ListPane.svelte";
  import Sidebar from "./Sidebar.svelte";
  import StartScreen from "./StartScreen.svelte";
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

  const mac = isMac();
  const newNoteShortcut = newNoteShortcutLabels(mac);

  function pick() {
    void app.pickWorkspace();
  }

  function createNote() {
    void app.createNote();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || !isNewNoteShortcut(event, mac)) return;
    // Keep the webview from opening a window; holding the keys creates one note.
    event.preventDefault();
    if (event.repeat || app.phase.kind !== "ready") return;
    createNote();
  }
</script>

<!-- Save pending edits as soon as the user leaves the window. -->
<svelte:window onblur={() => void app.flush()} onkeydown={handleKeydown} />

<Toasts toasts={app.toasts} ondismiss={(id) => app.dismissToast(id)} />

{#if app.phase.kind === "ready"}
  <div class="shell">
    <Sidebar
      {entries}
      allOpen={totalOpen(entries)}
      {workspaceName}
      warnings={app.warnings.map((warning) => warning.message)}
      notice={app.notice}
      onpick={pick}
      selected={app.folder}
      onselect={(id) => app.selectFolder(id)}
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
    />
    <EditorPane
      doc={app.document}
      status={app.saveStatus}
      {now}
      focusRequest={app.editorFocusRequest}
      onedit={(path, read) => app.edit(path, read)}
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
