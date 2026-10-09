<script lang="ts">
  import { untrack } from "svelte";
  import { describeSaveStatus, type SaveStatus } from "$lib/core/saveMachine";
  import { splitPath } from "$lib/core/views";
  import type { DocumentState, EditorPathChange } from "./appState.svelte";
  import { NoteEditor } from "./editor/noteEditor";

  interface Props {
    doc: DocumentState | null;
    /** Save state of the open note. */
    status: SaveStatus | null;
    /** Current time, for the relative age. */
    now: number;
    /** Each new value moves focus into the editor once it shows a note. */
    focusRequest: number;
    /** Called on every edit with a reader for the new text. */
    onedit: (path: string, read: () => string) => void;
    /** Renamed and deleted notes, in order; only new entries are applied. */
    pathChanges?: readonly EditorPathChange[];
  }

  let { doc, status, now, focusRequest, onedit, pathChanges = [] }: Props = $props();

  const location = $derived(doc ? splitPath(doc.path) : null);
  const label = $derived(status ? describeSaveStatus(status, now) : null);
  const ready = $derived(doc?.status === "ready");

  let host: HTMLDivElement | undefined = $state();
  let editor: NoteEditor | null = $state.raw(null);
  /** The document last given to the editor; a new object means new text from disk. */
  let shown: DocumentState | null = null;
  /** How many path changes the editor has applied. */
  let applied = 0;

  $effect(() => {
    if (!host) return;
    const created = new NoteEditor(host, (path, read) => onedit(path, read));
    // A new editor has no state to move.
    applied = untrack(() => pathChanges.length);
    editor = created;
    return () => {
      created.destroy();
      editor = null;
      shown = null;
    };
  });

  // Runs before the DOM update, so typing never continues into a hidden editor.
  $effect.pre(() => {
    if (!ready) editor?.blur();
  });

  // A deleted note starts fresh if it comes back.
  $effect(() => {
    if (doc?.status === "missing") editor?.forget(doc.path);
  });

  $effect(() => {
    const current = doc;
    const changes = pathChanges;
    if (!editor) return;
    // Moved first, so a renamed note is shown with its own state and history.
    for (; applied < changes.length; applied += 1) {
      const change = changes[applied];
      if (change?.kind === "rename") editor.rename(change.from, change.to);
      else if (change) editor.forget(change.path);
    }
    if (current?.status !== "ready" || current === shown) return;
    shown = current;
    editor.show(current.path, current.text);
  });

  /** The focus request already handled; the initial value never steals focus. */
  let focused = untrack(() => focusRequest);

  // Declared after the effect above, so the note is shown before it gets focus.
  $effect(() => {
    const request = focusRequest;
    if (!editor || !ready || request === focused) return;
    focused = request;
    editor.focus();
  });
</script>

<main class="editor-pane" aria-label="Editor">
  {#if doc && location}
    <header class="header">
      <span class="path">{location.folder}<span class="file">{location.file}</span></span>
      {#if ready && status && label}
        <span
          class="status"
          class:failed={status.kind === "failed"}
          title={status.kind === "failed" ? status.message : undefined}>{label}</span
        >
      {/if}
    </header>
  {/if}

  <!-- One editor for every note; hidden while no note text is shown. -->
  <div class="editor" bind:this={host} hidden={!ready}></div>

  {#if doc}
    {#if doc.status === "too-large"}
      <p class="empty" role="status">This file is larger than 8 MiB, too large to open in Kaido.</p>
    {:else if doc.status === "missing"}
      <p class="empty" role="status">This file no longer exists.</p>
    {:else if doc.status === "error"}
      <p class="empty" role="alert">Could not read this file: {doc.message}</p>
    {/if}
  {:else}
    <p class="empty">No note selected.</p>
  {/if}
</main>

<style>
  .editor-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--color-bg);
  }

  .header {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-16);
    height: var(--pane-header-height);
    padding: 0 var(--space-24);
    background: var(--color-bg);
    border-bottom: var(--space-1) solid var(--color-border);
    color: var(--color-muted);
    font-size: var(--font-size-small);
  }

  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file {
    color: var(--color-text);
  }

  .status {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .status.failed {
    color: var(--color-danger);
  }

  .editor {
    flex: 1;
    min-height: 0;
  }

  .editor[hidden] {
    display: none;
  }

  .empty {
    margin: auto;
    color: var(--color-muted);
  }
</style>
