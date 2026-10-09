<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { nextListIndex } from "$lib/core/listNavigation";
  import { formatAge } from "$lib/core/time";
  import type { ListItem } from "$lib/core/views";
  import { scrollTopFor, visibleRange } from "$lib/core/virtualList";

  interface Props {
    title: string;
    summary: string;
    items: ListItem[];
    /** Shown when there are no items. */
    emptyMessage: string;
    /** Current time, for relative ages. */
    now: number;
    selected: string;
    onselect: (id: string) => void;
    /** Creates a new note. */
    oncreate: () => void;
    /** The new note shortcut, for assistive technology and as a visible hint. */
    createShortcut: { aria: string; hint: string };
  }

  let {
    title,
    summary,
    items,
    emptyMessage,
    now,
    selected,
    onselect,
    oncreate,
    createShortcut,
  }: Props = $props();

  /** Rows rendered above and below the visible ones. */
  const OVERSCAN = 8;
  /** Used until the real sizes are known (and in environments without layout). */
  const FALLBACK_ROW_HEIGHT = 64;
  const FALLBACK_VIEWPORT_HEIGHT = 800;

  let viewport: HTMLElement | undefined = $state();
  let scrollTop = $state(0);
  let measuredViewport = $state(0);
  let rowHeight = $state(FALLBACK_ROW_HEIGHT);

  const viewportHeight = $derived(
    measuredViewport > 0 ? measuredViewport : FALLBACK_VIEWPORT_HEIGHT,
  );
  const selectedIndex = $derived(items.findIndex((item) => item.id === selected));
  const range = $derived(
    visibleRange(items.length, rowHeight, scrollTop, viewportHeight, OVERSCAN),
  );
  const rows = $derived(items.slice(range.start, range.end));
  const selectedRendered = $derived(selectedIndex >= range.start && selectedIndex < range.end);

  // The viewport is always rendered, even for an empty list, so it is
  // measured once and kept up to date when the window resizes.
  onMount(() => {
    if (!viewport) return;
    const target = viewport;
    const height = Number.parseFloat(
      getComputedStyle(target).getPropertyValue("--list-row-height"),
    );
    if (height > 0) rowHeight = height;
    const measure = () => (measuredViewport = target.clientHeight);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  });

  /** Scrolls just enough to show row `index`; the top of the list when nothing is selected. */
  function reveal(index: number) {
    const next = index < 0 ? 0 : scrollTopFor(index, rowHeight, scrollTop, viewportHeight);
    if (next === scrollTop) return;
    scrollTop = next;
    if (viewport) viewport.scrollTop = next;
  }

  // Keep the selection in view when it changes from anywhere.
  $effect(() => {
    const index = selectedIndex;
    untrack(() => reveal(index));
  });

  async function handleKeydown(event: KeyboardEvent) {
    const next = nextListIndex(event.key, selectedIndex, items.length);
    if (next === null) return;
    event.preventDefault();
    const item = items[next];
    if (!item) return;
    onselect(item.id);
    reveal(next);
    await tick();
    viewport?.querySelector<HTMLButtonElement>(`[data-item-id="${CSS.escape(item.id)}"]`)?.focus();
  }

  /**
   * Scrolling can unmount the focused row. Focus then moves to the viewport,
   * which handles the same keys, instead of being lost to the page.
   */
  async function handleScroll(event: Event & { currentTarget: HTMLElement }) {
    const target = event.currentTarget;
    const hadFocus = target.contains(document.activeElement);
    scrollTop = target.scrollTop;
    if (!hadFocus) return;
    await tick();
    if (!target.contains(document.activeElement)) target.focus({ preventScroll: true });
  }

  /** One rendered row is always focusable, so the list stays reachable with Tab. */
  function tabIndexFor(index: number, id: string): number {
    if (id === selected) return 0;
    return !selectedRendered && index === range.start ? 0 : -1;
  }
</script>

<section class="list-pane" aria-labelledby="list-title">
  <header class="header">
    <h2 id="list-title">{title}</h2>
    <span class="summary">{summary}</span>
  </header>

  <!-- Keys bubble here from the rows; the viewport keeps focus when a focused row scrolls away. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="viewport"
    bind:this={viewport}
    tabindex="-1"
    onscroll={handleScroll}
    onkeydown={handleKeydown}
  >
    {#if items.length === 0}
      <p class="empty">{emptyMessage}</p>
    {:else}
      <ul
        class="items"
        style:padding-top="{range.start * rowHeight}px"
        style:padding-bottom="{(items.length - range.end) * rowHeight}px"
      >
        {#each rows as item, offset (item.id)}
          {@const index = range.start + offset}
          <li aria-setsize={items.length} aria-posinset={index + 1}>
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
                <span class="meta">{item.openCount ?? "…"} open</span>
              {:else}
                <span class="line">
                  <span class="name">{item.name}</span>
                  <span class="age">{formatAge(item.modified, now)}</span>
                </span>
                <!-- Reserve the line while the title loads so rows do not jump. -->
                <span class="excerpt">{item.title ?? "\u00a0"}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <button
    type="button"
    class="row add"
    aria-label="New note"
    aria-keyshortcuts={createShortcut.aria}
    onclick={oncreate}
  >
    <span aria-hidden="true">+</span>
    <span class="name">new note</span>
    <kbd aria-hidden="true">{createShortcut.hint}</kbd>
  </button>
</section>

<style>
  .list-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: var(--space-1) solid var(--color-border);
  }

  .viewport {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .viewport:focus-visible {
    outline-offset: calc(-1 * var(--focus-ring-width));
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
    justify-content: center;
    gap: var(--space-4);
    width: 100%;
    height: var(--list-row-height);
    padding: var(--space-10) var(--space-16);
    overflow: hidden;
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
    align-items: center;
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

  .empty {
    padding: var(--space-16);
    color: var(--color-muted);
  }

  .add {
    flex-shrink: 0;
    height: auto;
    gap: var(--space-8);
    border-bottom: 0;
    color: var(--color-muted);
  }

  kbd {
    font-family: inherit;
    font-size: var(--font-size-meta);
  }
</style>
