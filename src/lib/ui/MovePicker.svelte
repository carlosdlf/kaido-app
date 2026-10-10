<script lang="ts">
  import { onMount, tick } from "svelte";
  import { filterTargets, type MoveTarget } from "$lib/core/moveTargets";

  interface Props {
    /** The dialog title, e.g. `Move deploy.md to…`. */
    title: string;
    targets: readonly MoveTarget[];
    /** Moves the item into `folder`; resolves to why it cannot, or `null` once done. */
    onchoose: (folder: string) => Promise<string | null>;
    /** The picker should go away; focus was already given back. */
    onclose: () => void;
    /** Where focus goes on close; by default what had focus when the picker opened. */
    returnFocus?: HTMLElement | null;
  }

  let { title, targets, onchoose, onclose, returnFocus }: Props = $props();

  const uid = $props.id();
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  let query = $state("");
  let active = $state(0);
  let error: string | null = $state(null);
  let busy = $state(false);
  let previous: HTMLElement | null = null;

  const matches = $derived(filterTargets(targets, query));

  onMount(() => {
    previous =
      returnFocus !== undefined
        ? returnFocus
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    input?.focus();
  });

  function close() {
    if (previous?.isConnected) previous.focus();
    onclose();
  }

  async function choose(index: number) {
    const target = matches[index];
    if (!target || busy) return;
    busy = true;
    error = null;
    const problem = await onchoose(target.folder);
    busy = false;
    if (problem === null) close();
    else error = problem;
  }

  async function moveTo(index: number) {
    active = index;
    await tick();
    list
      ?.querySelector<HTMLElement>(`#${CSS.escape(`${uid}-option-${index}`)}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const last = matches.length - 1;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case "Enter":
        event.preventDefault();
        if (!event.repeat) void choose(active);
        return;
      case "ArrowDown":
        event.preventDefault();
        if (last >= 0) void moveTo(active >= last ? 0 : active + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        if (last >= 0) void moveTo(active <= 0 ? last : active - 1);
        return;
      case "Home":
      case "End":
        if (!event.ctrlKey) return;
        event.preventDefault();
        if (last >= 0) void moveTo(event.key === "Home" ? 0 : last);
        return;
      case "Tab":
        // The input is the only stop; focus stays in the dialog.
        event.preventDefault();
        return;
    }
  }
</script>

<!-- Clicking outside the picker closes it; the keyboard uses Escape. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="backdrop"
  onmousedown={(event) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    close();
  }}
>
  <div class="picker" role="dialog" aria-modal="true" aria-labelledby="{uid}-title">
    <h1 id="{uid}-title" class="title">{title}</h1>
    <input
      bind:this={input}
      bind:value={query}
      class="filter"
      type="text"
      role="combobox"
      aria-label="Filter folders"
      aria-expanded={matches.length > 0}
      aria-controls="{uid}-options"
      aria-activedescendant={matches.length > 0 ? `${uid}-option-${active}` : undefined}
      aria-autocomplete="list"
      aria-describedby={error ? `${uid}-error` : undefined}
      aria-invalid={error ? "true" : undefined}
      placeholder="type to filter"
      spellcheck="false"
      autocomplete="off"
      oninput={() => {
        active = 0;
        error = null;
      }}
      onkeydown={handleKeydown}
    />
    {#if error}
      <p class="error" id="{uid}-error" role="alert">{error}</p>
    {/if}
    <ul class="options" id="{uid}-options" role="listbox" aria-label="Folders" bind:this={list}>
      {#each matches as target, index (target.folder)}
        <!-- Chosen with the keyboard from the filter; the mouse can click. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id="{uid}-option-{index}"
          class="option"
          role="option"
          aria-selected={index === active}
          style:--depth={target.depth}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => void choose(index)}
        >
          {target.label}
        </li>
      {:else}
        <li class="empty" role="presentation">No matching folder</li>
      {/each}
    </ul>
    <p class="hint" aria-hidden="true">↑↓ choose · ↵ move · esc cancel</p>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: var(--palette-offset);
    background: var(--color-overlay);
  }

  .picker {
    display: flex;
    flex-direction: column;
    width: min(var(--picker-width), calc(100% - var(--space-48)));
    max-height: var(--picker-max-height);
    overflow: hidden;
    background: var(--color-surface-raised);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-lg);
  }

  .title {
    padding: var(--space-10) var(--space-14) var(--space-6);
    color: var(--color-muted);
    font-size: var(--font-size-meta);
    font-weight: var(--font-weight-regular);
  }

  .filter {
    flex: none;
    height: var(--capture-row-height);
    margin: 0 var(--space-10);
    padding: 0 var(--space-6);
    background: var(--color-bg);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
  }

  .filter::placeholder {
    color: var(--color-muted);
  }

  .filter[aria-invalid="true"] {
    border-color: var(--color-danger);
  }

  .error {
    padding: var(--space-6) var(--space-14) 0;
    color: var(--color-danger);
    font-size: var(--font-size-small);
  }

  .options {
    margin-top: var(--space-6);
    overflow-y: auto;
  }

  .option,
  .empty {
    height: var(--capture-row-height);
    padding: 0 var(--space-14);
    overflow: hidden;
    line-height: var(--capture-row-height);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .option {
    padding-left: calc(var(--space-14) + var(--space-12) * var(--depth, 0));
    cursor: pointer;
  }

  .option[aria-selected="true"] {
    background: var(--color-selected);
    box-shadow: inset var(--selection-bar-width) 0 0 var(--color-accent);
  }

  .empty {
    color: var(--color-muted);
  }

  .hint {
    padding: var(--space-6) var(--space-14) var(--space-8);
    border-top: var(--space-1) solid var(--color-border);
    color: var(--color-muted);
    font-size: var(--font-size-meta);
  }
</style>
