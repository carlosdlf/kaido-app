<script lang="ts">
  import { tick, untrack } from "svelte";
  import ArrowUpRight from "@lucide/svelte/icons/arrow-up-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { nextListIndex } from "$lib/core/listNavigation";
  import { fileStem } from "$lib/core/markdown";
  import type { InsertPosition, TaskRef } from "$lib/core/taskDocument";
  import type { TaskItemRow, TaskRow } from "$lib/core/taskRows";
  import type { TaskFocusRequest } from "./appState.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import { isMac } from "./platform";

  interface Props {
    rows: readonly TaskRow[];
    /** Accessible name of the list. */
    label: string;
    /**
     * The list that receives tasks typed into the empty-state input and the
     * add button; `null` (All tasks) shows `emptyMessage` instead.
     */
    listPath: string | null;
    emptyMessage: string;
    /** A request to focus a task or the new task input; `onfocusdone` is called once applied. */
    focusRequest?: TaskFocusRequest | null;
    onfocusdone?: () => void;
    /** Each new value moves focus to the active row unless focus is in the list already. */
    focusFallback?: number;
    ontoggle: (path: string, ref: TaskRef) => void;
    /** Adds a task; returns a reference to it, or `null` if nothing was added. */
    onadd: (path: string, text: string, position: InsertPosition) => TaskRef | null;
    onedit: (path: string, ref: TaskRef, text: string) => void;
    ondelete: (path: string, ref: TaskRef) => void;
    /** Moves a task; returns its new line, or `null` if it cannot move. */
    onmove: (path: string, ref: TaskRef, direction: -1 | 1) => number | null;
    onsetdetail?: (path: string, ref: TaskRef, detail: string) => void;
    /** Opens the task's linked note (or offers to create a missing one). */
    onopennote?: (path: string, ref: TaskRef) => void;
    oncreatenote?: (path: string, ref: TaskRef) => void;
    oncopytext?: (text: string) => void;
    /** An open field was closed because its task changed on disk. */
    onstale?: () => void;
    /** `Ctrl+Z` / `Cmd+Z` in the list: undoes the most recent delete. */
    onundo?: () => void;
  }

  let {
    rows,
    label,
    listPath,
    emptyMessage,
    focusRequest = null,
    onfocusdone,
    focusFallback = 0,
    ontoggle,
    onadd,
    onedit,
    ondelete,
    onmove,
    onsetdetail,
    onopennote,
    oncreatenote,
    oncopytext,
    onundo,
    onstale,
  }: Props = $props();

  const uid = $props.id();
  const mac = isMac();
  const openShortcut = mac
    ? { aria: "Meta+Enter", hint: "⌘↵" }
    : { aria: "Control+Enter", hint: "^↵" };
  const SHORTCUTS = `Space Enter F2 Delete Alt+ArrowUp Alt+ArrowDown ArrowRight ${openShortcut.aria} Shift+F10`;

  let container: HTMLElement | undefined = $state();
  /** Key of the row that keeps focus (and the only tab stop). */
  let active: string | null = $state(null);

  const tasks = $derived(rows.filter((row): row is TaskItemRow => row.kind === "task"));
  const activeKey = $derived(
    tasks.some((row) => row.key === active) ? active : (tasks[0]?.key ?? null),
  );
  const showEmptyInput = $derived(listPath !== null && tasks.length === 0);

  function refOf(row: TaskItemRow): TaskRef {
    return { line: row.line, raw: row.raw };
  }

  function taskByKey(key: string | null): TaskItemRow | undefined {
    return tasks.find((row) => row.key === key);
  }

  /** Whether the task row `key` is still shown with exactly the line `raw`. */
  function stillShown(key: string, raw: string): boolean {
    return tasks.some((row) => row.key === key && row.raw === raw);
  }

  function rowElement(key: string): HTMLElement | null {
    return (
      container?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"] [data-focus]`) ??
      null
    );
  }

  async function focusKey(key: string) {
    active = key;
    await tick();
    rowElement(key)?.focus();
  }

  /** The top-level row of the block that `rows[index]` belongs to. */
  function blockStart(index: number): number {
    let top = index;
    while (top > 0 && (rows[top] as TaskItemRow).nested && rows[top - 1]?.kind === "task") top -= 1;
    return top;
  }

  /** The last row of the block that starts at `rows[index]`. */
  function blockEnd(index: number): TaskItemRow {
    let end = index;
    while (rows[end + 1]?.kind === "task" && (rows[end + 1] as TaskItemRow).nested) end += 1;
    return rows[end] as TaskItemRow;
  }

  // New tasks
  interface Adding {
    path: string;
    /** The task the new one follows: after its block, or at its end as a subtask. */
    parent: TaskRef;
    nested: boolean;
    /** The input is shown after this row, while it still has this line. */
    anchor: string;
    anchorRaw: string;
  }

  let adding: Adding | null = $state(null);
  let addDraft = $state("");

  function startAdd(row: TaskItemRow) {
    const top = blockStart(rows.indexOf(row));
    const parent = rows[top] as TaskItemRow;
    const anchor = blockEnd(top);
    adding = {
      path: row.path,
      parent: refOf(parent),
      nested: false,
      anchor: anchor.key,
      anchorRaw: anchor.raw,
    };
    addDraft = "";
  }

  /** Opens the new task input after the last open task (else the last task), or the empty-state input. */
  function startAddAtEnd() {
    let last: TaskItemRow | undefined = tasks[tasks.length - 1];
    for (const row of tasks) if (!row.done && !row.nested) last = row;
    if (showEmptyInput || !last) {
      void focusEmptyInput();
      return;
    }
    startAdd(last);
  }

  async function focusEmptyInput() {
    await tick();
    container?.querySelector<HTMLInputElement>("[data-empty-input]")?.focus();
  }

  function positionOf(current: Adding): InsertPosition {
    return current.nested ? { after: current.parent, nested: true } : { after: current.parent };
  }

  function commitAdd(
    path: string,
    position: InsertPosition,
    owner: Adding | null,
    keepOpen: boolean,
  ) {
    if (addDraft.trim() === "") {
      closeAdd(true);
      return;
    }
    const ref = onadd(path, addDraft, position);
    addDraft = "";
    if (ref === null) {
      closeAdd(true);
      return;
    }
    const key = `${path}:${ref.line}`;
    active = key;
    adding = keepOpen
      ? { path, parent: ref, nested: owner?.nested ?? false, anchor: key, anchorRaw: ref.raw }
      : null;
    // Typing on: the input below the new task takes focus when it appears.
  }

  function closeAdd(returnFocus: boolean) {
    const anchor = adding?.anchor ?? null;
    adding = null;
    addDraft = "";
    if (!returnFocus) return;
    const key = taskByKey(active) ? active : anchor;
    if (key !== null && taskByKey(key)) void focusKey(key);
    else if (tasks[0]) void focusKey(tasks[0].key);
  }

  function handleAddKeydown(
    event: KeyboardEvent,
    path: string,
    position: InsertPosition,
    owner: Adding | null,
  ) {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      // A held Enter adds one task; the repeats would close the next field.
      if (!event.repeat) commitAdd(path, position, owner, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (owner === null) addDraft = "";
      else closeAdd(true);
    } else if (event.key === "Tab" && owner !== null && !event.ctrlKey && !event.altKey) {
      // Tab makes the new task a subtask of the task above, Shift+Tab undoes it; one level only.
      if (event.shiftKey ? !owner.nested : owner.nested) {
        if (!event.shiftKey) event.preventDefault();
        return;
      }
      event.preventDefault();
      adding = { ...owner, nested: !event.shiftKey };
    }
  }

  /**
   * Leaving the field adds what was typed; switching windows keeps the field
   * as it is. `owner` is the input's own request (`null` for the empty-state
   * input), so a field being replaced after Enter or Tab does nothing.
   */
  function handleAddBlur(path: string, position: InsertPosition, owner: Adding | null) {
    if (!document.hasFocus() || (owner !== null && owner !== adding)) return;
    if (addDraft.trim() !== "") commitAdd(path, position, owner, false);
    else if (owner !== null) closeAdd(false);
  }

  // Inline edit
  let editing: { key: string; raw: string } | null = $state(null);
  let editDraft = $state("");

  function startEdit(row: TaskItemRow) {
    editing = { key: row.key, raw: row.raw };
    active = row.key;
    editDraft = row.text;
  }

  function selectAll(input: HTMLInputElement) {
    input.focus();
    input.select();
  }

  function finishEdit(row: TaskItemRow, save: boolean) {
    if (editing?.key !== row.key) return;
    editing = null;
    if (save) onedit(row.path, refOf(row), editDraft);
    void focusKey(row.key);
  }

  function handleEditKeydown(event: KeyboardEvent, row: TaskItemRow) {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) finishEdit(row, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishEdit(row, false);
    }
  }

  function handleEditBlur(row: TaskItemRow) {
    if (!document.hasFocus() || editing?.key !== row.key) return;
    editing = null;
    onedit(row.path, refOf(row), editDraft);
  }

  // Detail
  interface OpenDetail {
    key: string;
    path: string;
    /** The task as it was when the detail was opened. */
    ref: TaskRef;
    /** The detail as shown when opened; an unchanged draft is not saved. */
    original: string;
  }

  let detailOpen: OpenDetail | null = $state(null);
  let detailDraft = $state("");

  function openDetail(row: TaskItemRow) {
    if (row.nested || row.detail === null) return;
    detailOpen = { key: row.key, path: row.path, ref: refOf(row), original: row.detail };
    active = row.key;
    detailDraft = row.detail;
  }

  /** Saves a changed draft for the task it was opened for, found by its text. */
  function saveDetail(open: OpenDetail) {
    if (detailDraft !== open.original) onsetdetail?.(open.path, open.ref, detailDraft);
  }

  /** Saves the detail if it changed and collapses it. */
  function closeDetail(row: TaskItemRow, returnFocus: boolean) {
    const open = detailOpen;
    if (open?.key !== row.key) return;
    detailOpen = null;
    saveDetail(open);
    if (returnFocus) void focusKey(row.key);
  }

  function toggleDetail(row: TaskItemRow) {
    if (detailOpen?.key === row.key) closeDetail(row, true);
    else openDetail(row);
  }

  function handleDetailKeydown(event: KeyboardEvent, row: TaskItemRow) {
    if (event.isComposing) return;
    const field = event.currentTarget as HTMLTextAreaElement;
    const commit = event.key === "Enter" && (event.ctrlKey || event.metaKey);
    // ← at the very start, with nothing selected, leaves the detail like it entered.
    const back =
      event.key === "ArrowLeft" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      field.selectionStart === 0 &&
      field.selectionEnd === 0;
    if (commit || back || event.key === "Escape") {
      event.preventDefault();
      closeDetail(row, true);
    }
  }

  function handleDetailBlur(row: TaskItemRow) {
    if (!document.hasFocus()) return;
    closeDetail(row, false);
  }

  function focusField(field: HTMLTextAreaElement) {
    field.focus();
  }

  // Context menu
  let menu: { key: string; x: number; y: number } | null = $state(null);
  const menuRow = $derived.by(() => {
    const current = menu;
    return current ? taskByKey(current.key) : undefined;
  });
  const menuItems = $derived.by((): MenuItem[] => {
    const row = menuRow;
    if (!row) return [];
    return [
      { id: "edit", label: "Edit", shortcut: { aria: "F2", hint: "F2" } },
      row.link
        ? { id: "open", label: "Open note", shortcut: openShortcut }
        : { id: "create", label: "Create note from task" },
      { id: "copy", label: "Copy text" },
      { id: "delete", label: "Delete", shortcut: { aria: "Delete", hint: "Del" } },
    ];
  });

  function openMenu(row: TaskItemRow, x: number, y: number) {
    active = row.key;
    menu = { key: row.key, x, y };
  }

  function openMenuAtRow(row: TaskItemRow, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    openMenu(row, rect.left + rect.width / 4, rect.bottom);
  }

  function closeMenu(returnFocus: boolean) {
    const key = menu?.key;
    menu = null;
    if (returnFocus && key !== undefined && taskByKey(key)) void focusKey(key);
  }

  function chooseMenuItem(action: string) {
    const row = menuRow;
    if (!row) return;
    if (action === "edit") {
      menu = null;
      startEdit(row);
      return;
    }
    closeMenu(true);
    const ref = refOf(row);
    if (action === "open") onopennote?.(row.path, ref);
    else if (action === "create") oncreatenote?.(row.path, ref);
    else if (action === "copy") oncopytext?.(row.text);
    else ondelete(row.path, ref);
  }

  function isUndo(event: KeyboardEvent): boolean {
    return (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "z"
    );
  }

  function handleKeydown(event: KeyboardEvent) {
    const target = event.target;
    // Typing in a field never moves through the list.
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement && target.type === "text") return;
    if (isUndo(event)) {
      event.preventDefault();
      if (!event.repeat) onundo?.();
      return;
    }
    const element =
      target instanceof HTMLElement ? target.closest<HTMLElement>("[data-row-key]") : null;
    const row = taskByKey(element?.dataset["rowKey"] ?? null);
    if (!row || !element) return;

    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (event.altKey && vertical && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      const line = onmove(row.path, refOf(row), event.key === "ArrowUp" ? -1 : 1);
      if (line !== null) void focusKey(`${row.path}:${line}`);
      return;
    }
    const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (event.key === "Enter" && command && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) onopennote?.(row.path, refOf(row));
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      openMenuAtRow(row, element);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;

    const next = nextListIndex(
      event.key,
      tasks.findIndex((candidate) => candidate.key === row.key),
      tasks.length,
    );
    if (next !== null) {
      event.preventDefault();
      const target = tasks[next];
      if (target) void focusKey(target.key);
      return;
    }
    // Holding a key acts once; repeats would reach the next focused row.
    if (event.key === "Enter") {
      event.preventDefault();
      if (!event.repeat) startAdd(row);
    } else if (event.key === "F2") {
      event.preventDefault();
      if (!event.repeat) startEdit(row);
    } else if (event.key === "Delete") {
      event.preventDefault();
      if (!event.repeat) ondelete(row.path, refOf(row));
    } else if (event.key === "ArrowRight" && !row.nested) {
      event.preventDefault();
      openDetail(row);
    }
  }

  function handleFocusin(event: FocusEvent) {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.hasAttribute("data-focus")) return;
    const key = target.closest<HTMLElement>("[data-row-key]")?.dataset["rowKey"];
    if (key !== undefined) active = key;
  }

  // A field whose task changed on disk (or in the text editor) would act on
  // another task; it closes instead, keeping focus in the list.
  $effect(() => {
    void rows;
    untrack(() => {
      const editStale = editing !== null && !stillShown(editing.key, editing.raw);
      const addStale = adding !== null && !stillShown(adding.anchor, adding.anchorRaw);
      const open = detailOpen;
      const detailStale = open !== null && !stillShown(open.key, open.ref.raw);
      if (!editStale && !addStale && !detailStale) return;
      const hadFocus = container?.contains(document.activeElement) ?? false;
      if (open && detailStale) {
        // The draft is kept: it goes to the task found by its old text, if any.
        detailOpen = null;
        saveDetail(open);
      }
      if (editStale) editing = null;
      if (addStale) {
        adding = null;
        addDraft = "";
      }
      if (editStale || addStale) onstale?.();
      if (hadFocus) restoreFocus(0);
    });
  });

  // When the focused row goes away (hidden as done, deleted or moved), focus
  // the row now in its place instead of losing it.
  let focusWasInside = false;
  let activeIndex = 0;
  /** Task rows and the active one as last rendered. */
  let shownKeys: string[] = [];
  let shownActive: string | null = null;
  $effect.pre(() => {
    void rows;
    untrack(() => {
      focusWasInside = container?.contains(document.activeElement) ?? false;
      activeIndex = Math.max(shownKeys.indexOf(shownActive ?? ""), 0);
    });
  });
  $effect(() => {
    void rows;
    if (!focusWasInside || !container || container.contains(document.activeElement)) return;
    // A new task, edit or detail field takes focus itself.
    if (untrack(() => adding !== null || editing !== null || detailOpen !== null)) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    untrack(() => restoreFocus(activeIndex));
  });
  // Declared after the effect above, which needs the previous rows.
  $effect(() => {
    shownKeys = tasks.map((row) => row.key);
    shownActive = activeKey;
  });

  function restoreFocus(index: number) {
    const target = taskByKey(active) ?? tasks[Math.min(index, tasks.length - 1)];
    if (target) void focusKey(target.key);
    else if (showEmptyInput) void focusEmptyInput();
    else container?.focus({ preventScroll: true });
  }

  $effect(() => {
    const request = focusRequest;
    if (!request) return;
    const shown = request.path === listPath || tasks.some((row) => row.path === request.path);
    if (!shown) return;
    untrack(() => {
      onfocusdone?.();
      if (request.line === null) startAddAtEnd();
      else void focusKey(`${request.path}:${request.line}`);
    });
  });

  let handledFallback = untrack(() => focusFallback);
  $effect(() => {
    const request = focusFallback;
    if (request === handledFallback) return;
    handledFallback = request;
    untrack(() => {
      if (container?.contains(document.activeElement)) return;
      restoreFocus(0);
    });
  });

  /** Opens the new task input at the end of the open tasks. */
  export function addAtEnd() {
    startAddAtEnd();
  }
</script>

{#snippet addInput(path: string, position: InsertPosition, owner: Adding | null)}
  {@const empty = owner === null}
  <li class="add-row" class:nested={owner?.nested === true}>
    <span class="box" aria-hidden="true">[ ]</span>
    <label class="visually-hidden" for="{uid}-add{empty ? '-empty' : ''}"
      >{owner?.nested ? "New subtask" : "New task"}</label
    >
    <input
      id="{uid}-add{empty ? '-empty' : ''}"
      class="field"
      type="text"
      placeholder={owner?.nested ? "Add a subtask…" : "Add a task…"}
      spellcheck="false"
      autocomplete="off"
      aria-keyshortcuts={empty ? undefined : "Tab Shift+Tab"}
      data-empty-input={empty ? "" : undefined}
      bind:value={addDraft}
      onkeydown={(event) => handleAddKeydown(event, path, position, owner)}
      onblur={() => handleAddBlur(path, position, owner)}
      {@attach (input) => {
        if (!empty) input.focus();
      }}
    />
  </li>
{/snippet}

<!-- Keys bubble here from the rows; the list itself takes focus only if every row is gone. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="task-list"
  bind:this={container}
  tabindex="-1"
  onkeydown={handleKeydown}
  onfocusin={handleFocusin}
>
  {#if rows.length === 0 && !showEmptyInput}
    <p class="empty">{emptyMessage}</p>
  {/if}
  <ul aria-label={label}>
    {#if showEmptyInput && listPath !== null}
      {@render addInput(listPath, "end", null)}
    {/if}
    {#each rows as row, index (row.key)}
      {#if row.kind === "heading"}
        <li class="heading" class:first={index === 0}>
          <h3>
            <span class="marker" aria-hidden="true">{"#".repeat(row.level)}</span>
            {row.title}
          </h3>
        </li>
      {:else if row.kind === "project"}
        <li class="heading project" class:first={index === 0}>
          <h3>
            <span class="project-name">{row.project}/</span>
            <span class="count" aria-label="{row.count} open">[{row.count}]</span>
          </h3>
        </li>
      {:else}
        {@const expanded = detailOpen?.key === row.key}
        <li
          class="task"
          class:nested={row.nested}
          class:done={row.done}
          class:active={row.key === activeKey}
          data-row-key={row.key}
          oncontextmenu={(event) => {
            event.preventDefault();
            openMenu(row, event.clientX, event.clientY);
          }}
        >
          {#if !row.nested}
            {#if row.detail || expanded}
              <button
                type="button"
                class="chevron"
                tabindex="-1"
                aria-expanded={expanded}
                aria-label={expanded ? "Hide detail" : "Show detail"}
                onmousedown={(event) => {
                  // The open detail keeps focus, so the click collapses it instead of a blur.
                  if (expanded) event.preventDefault();
                }}
                onclick={() => toggleDetail(row)}
              >
                {#if expanded}<ChevronDown aria-hidden="true" />{:else}<ChevronRight
                    aria-hidden="true"
                  />{/if}
              </button>
            {:else}
              <span class="chevron" aria-hidden="true"></span>
            {/if}
          {/if}
          <input
            type="checkbox"
            class="check"
            data-focus
            checked={row.done}
            tabindex={row.key === activeKey ? 0 : -1}
            aria-labelledby="{uid}-text-{index}"
            aria-describedby={row.progress || row.link ? `${uid}-meta-${index}` : undefined}
            aria-keyshortcuts={SHORTCUTS}
            onclick={(event) => {
              // The state follows the file, not the click.
              event.preventDefault();
              ontoggle(row.path, refOf(row));
            }}
          />
          {#if editing?.key === row.key}
            <label class="visually-hidden" for="{uid}-edit">Edit task</label>
            <span id="{uid}-text-{index}" class="visually-hidden">{row.display}</span>
            <input
              id="{uid}-edit"
              class="field"
              type="text"
              spellcheck="false"
              autocomplete="off"
              bind:value={editDraft}
              onkeydown={(event) => handleEditKeydown(event, row)}
              onblur={() => handleEditBlur(row)}
              {@attach selectAll}
            />
          {:else}
            <!-- Mouse shortcuts only; the checkbox offers the same with the keyboard (F2). -->
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <span
              id="{uid}-text-{index}"
              class="text"
              class:untitled={row.display === ""}
              onclick={() => {
                // Synchronous, so a double-click's edit field keeps the focus it takes.
                active = row.key;
                rowElement(row.key)?.focus();
              }}
              ondblclick={() => startEdit(row)}
              >{row.display === "" ? "untitled task" : row.display}</span
            >
            <span id="{uid}-meta-{index}" class="meta">
              {#if row.link}
                <button
                  type="button"
                  class="chip"
                  class:missing={!row.link.exists}
                  tabindex="-1"
                  title={row.link.exists ? undefined : "missing"}
                  onclick={() => onopennote?.(row.path, refOf(row))}
                >
                  <ArrowUpRight aria-hidden="true" />
                  <span class="visually-hidden">Linked note</span>
                  <span class="chip-name">{fileStem(row.link.path)}</span>
                  {#if !row.link.exists}<span class="visually-hidden">, missing</span>{/if}
                </button>
              {/if}
              {#if row.progress}
                <span class="progress">
                  <span aria-hidden="true">{row.progress.done}/{row.progress.total}</span>
                  <span class="visually-hidden"
                    >{row.progress.done} of {row.progress.total} subtasks done</span
                  >
                </span>
              {/if}
            </span>
          {/if}
        </li>
        {#if expanded}
          <li class="detail-row">
            <label class="visually-hidden" for="{uid}-detail">Detail of {row.display}</label>
            <textarea
              id="{uid}-detail"
              class="detail"
              rows="4"
              spellcheck="false"
              aria-keyshortcuts="{openShortcut.aria} Escape ArrowLeft"
              bind:value={detailDraft}
              onkeydown={(event) => handleDetailKeydown(event, row)}
              onblur={() => handleDetailBlur(row)}
              {@attach focusField}></textarea>
          </li>
        {/if}
      {/if}
      {#if adding && adding.anchor === row.key}
        {@render addInput(adding.path, positionOf(adding), adding)}
      {/if}
    {/each}
  </ul>
</div>

{#if menu && menuRow}
  <ContextMenu
    label="Task actions"
    x={menu.x}
    y={menu.y}
    items={menuItems}
    onselect={chooseMenuItem}
    onclose={closeMenu}
  />
{/if}

<style>
  .task-list {
    display: flex;
    flex-direction: column;
    max-width: var(--note-max-width);
    padding: var(--space-16) 0 var(--space-8);
  }

  .task-list:focus-visible {
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  .empty {
    padding: var(--space-8) var(--space-24);
    color: var(--color-muted);
  }

  .heading h3 {
    padding: var(--space-20) var(--space-24) var(--space-6);
    color: var(--color-heading);
    font-size: var(--font-size-ui);
    font-weight: var(--font-weight-semibold);
  }

  .heading.first h3 {
    padding-top: var(--space-4);
  }

  .marker {
    color: var(--color-dim);
    font-weight: var(--font-weight-regular);
  }

  .count {
    color: var(--color-muted);
    font-weight: var(--font-weight-regular);
  }

  .task,
  .add-row {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    min-height: var(--space-28);
    padding: var(--space-2) var(--space-24) var(--space-2) var(--space-8);
  }

  .add-row {
    padding-left: calc(var(--space-8) + var(--icon-size) + var(--space-8));
  }

  .task.nested,
  .add-row.nested {
    padding-left: calc(var(--space-8) + var(--icon-size) + var(--space-8) + var(--space-24));
  }

  .task:hover {
    background: var(--color-panel);
  }

  .task.active:focus-within {
    background: var(--color-selected);
    box-shadow: inset var(--selection-bar-width) 0 0 var(--color-accent);
  }

  .chevron {
    display: flex;
    flex-shrink: 0;
    width: var(--icon-size);
    color: var(--color-muted);
  }

  .task.active:focus-within .chevron {
    color: var(--color-accent);
  }

  .text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    cursor: default;
  }

  .text.untitled {
    color: var(--color-muted);
    font-style: italic;
  }

  .task.done .text {
    color: var(--color-muted);
    text-decoration: line-through;
  }

  .meta {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--space-8);
    color: var(--color-muted);
    font-size: var(--font-size-meta);
  }

  .chip {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: calc(2 * var(--space-80));
    padding: 0 var(--space-4);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    color: var(--color-muted);
  }

  .chip:hover {
    color: var(--color-text);
  }

  .task.active:focus-within .chip:not(.missing) {
    color: var(--color-accent);
  }

  .chip.missing {
    border-style: dashed;
    font-style: italic;
  }

  .chip-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .box {
    color: var(--color-dim);
  }

  .field,
  .detail {
    flex: 1;
    min-width: 0;
    padding: 0 var(--space-4);
    margin-left: calc(-1 * var(--space-4));
    background: var(--color-bg);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
  }

  .field::placeholder {
    color: var(--color-muted);
  }

  .detail-row {
    display: flex;
    padding: var(--space-2) var(--space-24) var(--space-6)
      calc(
        var(--space-8) + var(--icon-size) + var(--space-8) + var(--checkbox-size) + var(--space-8)
      );
  }

  .detail {
    padding: var(--space-6) var(--space-8);
    resize: vertical;
    font-family: var(--font-note);
    font-size: var(--font-size-note);
    line-height: var(--line-height-note);
  }

  /*
   * Drawn by hand so the look is identical across webviews.
   */
  .check {
    position: relative;
    flex-shrink: 0;
    width: var(--checkbox-size);
    height: var(--checkbox-size);
    margin: 0;
    appearance: none;
    background: var(--color-bg);
    border: var(--space-1) solid var(--color-muted);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }

  .check:checked {
    background: var(--color-accent);
    border-color: var(--color-accent);
  }

  .check:checked::after {
    content: "";
    position: absolute;
    top: var(--space-1);
    left: var(--space-4);
    width: var(--space-4);
    height: var(--space-8);
    border: solid var(--color-on-accent);
    border-width: 0 var(--space-2) var(--space-2) 0;
    transform: rotate(45deg);
  }

  .check:focus-visible {
    outline-offset: var(--space-2);
  }
</style>
