<script lang="ts">
  import { describeSaveStatus, type SaveStatus } from "$lib/core/saveMachine";
  import type { InsertPosition, TaskRef } from "$lib/core/taskDocument";
  import type { TaskRow } from "$lib/core/taskRows";
  import { splitPath } from "$lib/core/views";
  import type { TaskFocusRequest } from "./appState.svelte";
  import Eye from "@lucide/svelte/icons/eye";
  import EyeOff from "@lucide/svelte/icons/eye-off";
  import TaskList from "./TaskList.svelte";
  import ViewModeSwitch, { type ViewMode } from "./ViewModeSwitch.svelte";

  interface Props {
    /** Accessible name of the pane. */
    label: string;
    /** Shown in the header: a file path, or a view name such as `~/all-tasks`. */
    title: string;
    /** Extra header text, e.g. the number of open tasks. */
    summary?: string;
    rows: readonly TaskRow[];
    /** The task list shown, or `null` for All tasks. */
    listPath: string | null;
    emptyMessage: string;
    /** A remark shown above the list, e.g. lists that could not be included. */
    notice?: string | null;
    /** Replaces the list, e.g. when the file could not be read. */
    message?: { text: string; alert: boolean } | null;
    status?: SaveStatus | null;
    now: number;
    /** Switches between this view and the text editor; shown for a task list only. */
    onviewmode?: (mode: ViewMode) => void;
    viewShortcut?: { aria: string; hint: string };
    focusRequest?: TaskFocusRequest | null;
    onfocusdone?: () => void;
    focusFallback?: number;
    ontoggle: (path: string, ref: TaskRef) => void;
    onadd: (path: string, text: string, position: InsertPosition) => TaskRef | null;
    onedit: (path: string, ref: TaskRef, text: string) => void;
    ondelete: (path: string, ref: TaskRef) => void;
    onmove: (path: string, ref: TaskRef, direction: -1 | 1) => number | null;
    onsetdetail?: (path: string, ref: TaskRef, detail: string) => void;
    onopennote?: (path: string, ref: TaskRef) => void;
    oncreatenote?: (path: string, ref: TaskRef) => void;
    oncopytext?: (text: string) => void;
    onstale?: () => void;
    onundo?: () => void;
    /** Whether done tasks are hidden, and how to switch it. */
    hideDone: boolean;
    ontogglehidedone: () => void;
  }

  let {
    label,
    title,
    summary,
    rows,
    listPath,
    emptyMessage,
    message = null,
    notice = null,
    status = null,
    now,
    onviewmode,
    viewShortcut,
    hideDone,
    ontogglehidedone,
    ...list
  }: Props = $props();

  const location = $derived(splitPath(title));
  const statusLabel = $derived(status ? describeSaveStatus(status, now) : null);

  let taskList: ReturnType<typeof TaskList> | undefined = $state();
</script>

<main class="task-pane" aria-label={label}>
  <header class="header">
    <span class="path">{location.folder}<span class="file">{location.file}</span></span>
    <span class="tools">
      {#if summary}
        <span class="status">{summary}</span>
      {/if}
      {#if status && statusLabel}
        <span
          class="status"
          class:failed={status.kind === "failed"}
          title={status.kind === "failed" ? status.message : undefined}>{statusLabel}</span
        >
      {/if}
      <button
        type="button"
        class="hide-done"
        aria-pressed={hideDone ? "true" : "false"}
        onclick={ontogglehidedone}
      >
        {#if hideDone}<EyeOff aria-hidden="true" />{:else}<Eye aria-hidden="true" />{/if}
        hide done</button
      >
      {#if onviewmode && viewShortcut}
        <ViewModeSwitch mode="list" onchange={onviewmode} shortcut={viewShortcut} />
      {/if}
    </span>
  </header>

  <div class="body">
    {#if message}
      <p class="empty" role={message.alert ? "alert" : "status"}>{message.text}</p>
    {:else}
      {#if notice}
        <p class="notice">{notice}</p>
      {/if}
      <TaskList bind:this={taskList} {rows} {label} {listPath} {emptyMessage} {...list} />
      {#if listPath !== null}
        <button type="button" class="add" onclick={() => taskList?.addAtEnd()}>
          <span aria-hidden="true">+</span>
          <span>new task</span>
        </button>
      {/if}
    {/if}
  </div>
</main>

<style>
  .task-pane {
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

  .tools {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--space-16);
  }

  .status {
    white-space: nowrap;
  }

  .status.failed {
    color: var(--color-danger);
  }

  .hide-done {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-1) var(--space-8);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    color: var(--color-muted);
  }

  .hide-done:hover {
    color: var(--color-text);
  }

  .hide-done[aria-pressed="true"] {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .add {
    display: flex;
    gap: var(--space-8);
    margin: 0 0 var(--space-40) var(--space-24);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    color: var(--color-muted);
  }

  .add:hover {
    color: var(--color-text);
  }

  .notice {
    padding: var(--space-12) var(--space-24) 0;
    color: var(--color-muted);
    font-size: var(--font-size-small);
  }

  .empty {
    margin: var(--space-40) auto;
    color: var(--color-muted);
    text-align: center;
  }
</style>
