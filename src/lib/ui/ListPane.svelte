<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { nextListIndex } from "$lib/core/listNavigation";
  import { stemLength } from "$lib/core/noteNames";
  import { baseName } from "$lib/core/saveMachine";
  import { formatAge } from "$lib/core/time";
  import type { ListItem } from "$lib/core/views";
  import { scrollTopFor, visibleRange } from "$lib/core/virtualList";
  import type { RenameOutcome } from "./appState.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";

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
    /** Renames a note to the name the user typed. */
    onrename: (id: string, name: string) => Promise<RenameOutcome>;
    ondelete: (id: string) => void;
    oncopypath: (id: string) => void;
    /** `Ctrl+Z` / `Cmd+Z` in the list: undoes the most recent delete, if it can still be undone. */
    onundo?: () => void;
    /** Each new value moves focus to the selected row. */
    focusRequest?: number;
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
    onrename,
    ondelete,
    oncopypath,
    onundo,
    focusRequest = 0,
  }: Props = $props();

  const MENU_ITEMS: readonly MenuItem[] = [
    { id: "rename", label: "Rename", shortcut: { aria: "F2", hint: "F2" } },
    { id: "copy-path", label: "Copy path" },
    { id: "delete", label: "Delete", shortcut: { aria: "Delete", hint: "Del" } },
  ];

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

  /** The row button for `id`, if it is rendered. */
  function rowButton(id: string): HTMLButtonElement | null {
    return viewport?.querySelector<HTMLButtonElement>(`[data-item-id="${CSS.escape(id)}"]`) ?? null;
  }

  /** Scrolls row `id` into view and focuses it; the viewport if it is gone. */
  async function focusRow(id: string) {
    const index = items.findIndex((item) => item.id === id);
    if (index !== -1) reveal(index);
    await tick();
    const button = index === -1 ? null : rowButton(id);
    if (button) button.focus();
    else viewport?.focus({ preventScroll: true });
  }

  function isNote(id: string): boolean {
    return items.some((item) => item.id === id && item.kind === "note");
  }

  // Context menu
  let menu: { id: string; x: number; y: number } | null = $state(null);

  function openMenu(id: string, x: number, y: number) {
    if (!isNote(id)) return;
    menu = { id, x, y };
  }

  function openMenuAtRow(id: string, row: HTMLElement) {
    const rect = row.getBoundingClientRect();
    openMenu(id, rect.left + rect.width / 4, rect.bottom);
  }

  function closeMenu(returnFocus: boolean) {
    const target = menu?.id;
    menu = null;
    if (returnFocus && target !== undefined) void focusRow(target);
  }

  function chooseMenuItem(action: string) {
    const target = menu?.id;
    if (target === undefined) return;
    if (action === "rename") {
      menu = null;
      startRename(target);
      return;
    }
    closeMenu(true);
    if (action === "delete") ondelete(target);
    else oncopypath(target);
  }

  // Inline rename
  let renaming: string | null = $state(null);
  let draft = $state("");
  let renameError: string | null = $state(null);
  let committing = false;
  /**
   * The row being renamed, outside reactivity: teardown functions read the
   * value state had before the change that removed them.
   */
  let activeRename: string | null = null;

  function startRename(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (item?.kind !== "note") return;
    renaming = id;
    activeRename = id;
    // Only the file name is edited; subfolders stay.
    draft = baseName(item.name);
    renameError = null;
  }

  /** Focuses the input with the name selected up to the extension. */
  function focusRenameInput(input: HTMLInputElement) {
    input.focus();
    input.setSelectionRange(0, stemLength(input.value));
    const id = activeRename;
    // Scrolling the row away unmounts the input without a blur; that confirms too.
    return () => {
      if (activeRename === id) void commitRename();
    };
  }

  async function commitRename() {
    const id = activeRename;
    if (id === null || committing) return;
    committing = true;
    const outcome = await onrename(id, draft);
    committing = false;
    if (activeRename !== id) return;
    if (outcome.kind === "invalid") {
      renameError = outcome.reason;
      return;
    }
    finishRename(outcome.kind === "renamed" ? outcome.path : id);
  }

  function cancelRename() {
    const id = activeRename;
    if (id === null) return;
    finishRename(id);
  }

  function finishRename(id: string) {
    renaming = null;
    activeRename = null;
    renameError = null;
    // Only take focus back when it would otherwise be lost.
    const active = document.activeElement;
    if (!active || active === document.body || viewport?.contains(active)) void focusRow(id);
  }

  /**
   * Leaving the window blurs the field too; the rename then waits, and the
   * field gets focus back with the window.
   */
  function handleRenameBlur() {
    if (!document.hasFocus()) return;
    void commitRename();
  }

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  }

  /** Keys on a focused note row: rename, delete and the context menu. */
  function handleRowAction(event: KeyboardEvent, row: HTMLElement): boolean {
    const id = row.dataset["itemId"];
    if (id === undefined || !isNote(id) || event.ctrlKey || event.metaKey || event.altKey)
      return false;
    // Holding the key acts once; repeats would reach the next focused row.
    const once = !event.repeat;
    if (event.key === "F2" && !event.shiftKey) {
      if (once) startRename(id);
    } else if (event.key === "Delete" && !event.shiftKey) {
      if (once) ondelete(id);
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))
      openMenuAtRow(id, row);
    else return false;
    event.preventDefault();
    return true;
  }

  function isUndo(event: KeyboardEvent): boolean {
    return (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "z"
    );
  }

  async function handleKeydown(event: KeyboardEvent) {
    const target = event.target;
    // Typing in the rename field never moves the selection.
    if (target instanceof HTMLInputElement) return;
    if (isUndo(event)) {
      event.preventDefault();
      if (!event.repeat) onundo?.();
      return;
    }
    const row =
      target instanceof HTMLElement ? target.closest<HTMLElement>("[data-item-id]") : null;
    if (row && handleRowAction(event, row)) return;
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

  // When the focused row goes away (deleted, renamed or filtered), focus the
  // selected row instead of losing focus to the page.
  let focusWasInside = false;
  $effect.pre(() => {
    void items;
    focusWasInside = viewport?.contains(document.activeElement) ?? false;
  });
  $effect(() => {
    void items;
    if (!focusWasInside || !viewport || viewport.contains(document.activeElement)) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    untrack(() => void focusRow(selected));
  });

  /** The focus request already handled; the initial value never steals focus. */
  let handledFocus = untrack(() => focusRequest);
  $effect(() => {
    const request = focusRequest;
    if (request === handledFocus) return;
    handledFocus = request;
    untrack(() => void focusRow(selected));
  });

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
            {#if item.kind === "note" && item.id === renaming}
              <div class="row rename">
                <label class="visually-hidden" for="rename-input">Rename {item.name}</label>
                <input
                  id="rename-input"
                  class="rename-input"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  bind:value={draft}
                  aria-invalid={renameError ? "true" : undefined}
                  aria-describedby={renameError ? "rename-error" : undefined}
                  onkeydown={handleRenameKeydown}
                  oninput={() => (renameError = null)}
                  onblur={handleRenameBlur}
                  {@attach focusRenameInput}
                />
                {#if renameError}
                  <span id="rename-error" class="rename-error" role="alert">{renameError}</span>
                {:else}
                  <span class="excerpt">{item.title ?? "\u00a0"}</span>
                {/if}
              </div>
            {:else}
              <button
                type="button"
                class="row"
                class:tasks={item.kind === "tasks"}
                data-item-id={item.id}
                tabindex={tabIndexFor(index, item.id)}
                aria-current={item.id === selected ? "true" : undefined}
                aria-keyshortcuts={item.kind === "note" ? "F2 Delete Shift+F10" : undefined}
                onclick={() => onselect(item.id)}
                oncontextmenu={(event) => {
                  if (item.kind !== "note") return;
                  event.preventDefault();
                  openMenu(item.id, event.clientX, event.clientY);
                }}
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
            {/if}
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

  {#if menu}
    <ContextMenu
      label="Note actions"
      x={menu.x}
      y={menu.y}
      items={MENU_ITEMS}
      onselect={chooseMenuItem}
      onclose={closeMenu}
    />
  {/if}
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

  .rename {
    cursor: default;
  }

  .rename-input {
    width: 100%;
    padding: 0 var(--space-4);
    margin-left: calc(-1 * var(--space-4));
    background: var(--color-bg);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
  }

  .rename-input[aria-invalid="true"] {
    border-color: var(--color-danger);
  }

  .rename-error {
    overflow: hidden;
    color: var(--color-danger);
    font-size: var(--font-size-small);
    text-overflow: ellipsis;
    white-space: nowrap;
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
