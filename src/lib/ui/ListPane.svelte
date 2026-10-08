<script lang="ts">
  import { nextListIndex } from "$lib/core/listNavigation";
  import type { ListItem } from "./workspace";

  interface Props {
    title: string;
    summary: string;
    items: ListItem[];
    selected: string;
    onselect: (id: string) => void;
  }

  let { title, summary, items, selected, onselect }: Props = $props();

  let list: HTMLElement | undefined = $state();

  const selectedIndex = $derived(items.findIndex((item) => item.id === selected));

  function handleKeydown(event: KeyboardEvent) {
    const next = nextListIndex(event.key, selectedIndex, items.length);
    if (next === null) return;
    event.preventDefault();
    const item = items[next];
    if (!item) return;
    onselect(item.id);
    list?.querySelector<HTMLButtonElement>(`[data-item-id="${CSS.escape(item.id)}"]`)?.focus();
  }

  /** The first item is focusable when nothing is selected, so the list stays reachable. */
  function tabIndexFor(index: number, id: string): number {
    return id === selected || (selectedIndex === -1 && index === 0) ? 0 : -1;
  }
</script>

<section class="list-pane" aria-labelledby="list-title">
  <header class="header">
    <h2 id="list-title">{title}</h2>
    <span class="summary">{summary}</span>
  </header>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <ul class="items" bind:this={list} onkeydown={handleKeydown}>
    {#each items as item, index (item.id)}
      <li>
        <button
          type="button"
          class="row"
          class:tasks={item.kind === "tasks"}
          data-item-id={item.id}
          tabindex={tabIndexFor(index, item.id)}
          aria-current={item.id === selected ? "true" : undefined}
          onclick={() => onselect(item.id)}
        >
          {#if item.kind === "tasks"}
            <span class="box" aria-hidden="true">[ ]</span>
            <span class="name">{item.label}</span>
            <span class="meta">{item.openCount} open</span>
          {:else}
            <span class="line">
              <span class="name">{item.note.file}</span>
              <span class="age">{item.note.age}</span>
            </span>
            <span class="excerpt">{item.note.summary}</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>

  <button type="button" class="row add" aria-keyshortcuts="Control+N">
    <span aria-hidden="true">+</span>
    <span class="name">new note</span>
    <kbd aria-hidden="true">^N</kbd>
  </button>
</section>

<style>
  .list-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    border-right: var(--space-1) solid var(--color-border);
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-8);
    padding: var(--space-16) var(--space-16) var(--space-10);
    border-bottom: var(--space-1) solid var(--color-border);
  }

  h2 {
    font-size: var(--font-size-ui);
    font-weight: var(--font-weight-bold);
  }

  .summary {
    color: var(--color-muted);
    font-size: var(--font-size-meta);
    white-space: nowrap;
  }

  .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    width: 100%;
    padding: var(--space-10) var(--space-16);
    border-bottom: var(--space-1) solid var(--color-border-subtle);
  }

  .row:hover {
    background: var(--color-panel);
  }

  .row[aria-current="true"] {
    background: var(--color-selected);
    box-shadow: inset var(--selection-bar-width) 0 0 var(--color-accent);
  }

  .row[aria-current="true"] .name {
    font-weight: var(--font-weight-bold);
  }

  .tasks,
  .add {
    flex-direction: row;
    gap: var(--space-10);
  }

  .box {
    color: var(--color-accent);
  }

  .tasks .name,
  .add .name {
    flex: 1;
  }

  .line {
    display: flex;
    justify-content: space-between;
    gap: var(--space-8);
  }

  .name,
  .excerpt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta,
  .age,
  .excerpt {
    color: var(--color-muted);
  }

  .age {
    font-size: var(--font-size-meta);
  }

  .excerpt {
    font-size: var(--font-size-small);
  }

  .add {
    gap: var(--space-8);
    border-bottom: 0;
    color: var(--color-muted);
  }

  kbd {
    font-family: inherit;
    font-size: var(--font-size-meta);
  }
</style>
