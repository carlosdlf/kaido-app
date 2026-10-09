<script lang="ts">
  import { onMount, tick } from "svelte";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import ListChecks from "@lucide/svelte/icons/list-checks";
  import Square from "@lucide/svelte/icons/square";
  import SquareCheck from "@lucide/svelte/icons/square-check";
  import Terminal from "@lucide/svelte/icons/terminal";
  import {
    filterCommands,
    paletteMode,
    TAGS_UNAVAILABLE,
    type PaletteCommand,
    type PaletteCommandId,
  } from "$lib/core/palette";
  import { highlightSegments, type SearchResult } from "$lib/core/searchIndex";
  import { isSearchShortcut } from "$lib/core/shortcuts";
  import { isMac } from "./platform";

  interface Props {
    /** Results for a query; called on every keystroke. */
    search: (query: string) => SearchResult[];
    /** Changes when the searched content changed, so the results are fetched again. */
    revision?: number;
    /** Commands that can run now, listed after `>`. */
    commands: readonly PaletteCommand[];
    onopen: (result: SearchResult) => void;
    onrun: (id: PaletteCommandId) => void;
    /** The palette should go away; focus was already given back. */
    onclose: () => void;
  }

  let { search, revision = 0, commands, onopen, onrun, onclose }: Props = $props();

  /** Rows rendered at most. */
  const MAX_ROWS = 50;
  const mac = isMac();
  const uid = $props.id();

  type Row =
    { kind: "result"; result: SearchResult } | { kind: "command"; command: PaletteCommand };

  let query = $state("");
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let list: HTMLElement | undefined = $state();
  /** Where focus was before the palette opened. */
  let previous: HTMLElement | null = null;

  const mode = $derived(paletteMode(query));
  const rows: Row[] = $derived.by(() => {
    if (mode.kind === "commands") {
      return filterCommands(commands, mode.query).map((command) => ({ kind: "command", command }));
    }
    if (mode.kind === "tags") return [];
    // Read so that the results follow changes to what is searched.
    void revision;
    return search(mode.query)
      .slice(0, MAX_ROWS)
      .map((result) => ({ kind: "result", result }));
  });
  const message = $derived.by(() => {
    if (mode.kind === "tags") return TAGS_UNAVAILABLE;
    if (rows.length > 0) return null;
    if (mode.kind === "commands") return "No matching commands";
    return mode.query === "" ? "Nothing opened yet" : "No results";
  });
  const activeId = $derived(rows.length > 0 ? `${uid}-option-${active}` : undefined);

  // Fewer results after a refresh: keep the active row on one that exists.
  $effect(() => {
    if (active >= rows.length) active = Math.max(rows.length - 1, 0);
  });

  onMount(() => {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input?.focus();
  });

  function optionId(index: number): string {
    return `${uid}-option-${index}`;
  }

  function close(restore: boolean) {
    if (restore && previous?.isConnected) previous.focus();
    onclose();
  }

  function choose(index: number) {
    const row = rows[index];
    if (!row) return;
    // Focus goes back first; opening a result or running a command may move it on.
    close(true);
    if (row.kind === "command") onrun(row.command.id);
    else onopen(row.result);
  }

  async function move(to: number) {
    if (rows.length === 0) return;
    active = (to + rows.length) % rows.length;
    await tick();
    list?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView?.({ block: "nearest" });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const key = event.key;
    if (key === "ArrowDown" || (ctrlOnly && key.toLowerCase() === "n")) {
      event.preventDefault();
      void move(active + 1);
    } else if (key === "ArrowUp" || (ctrlOnly && key.toLowerCase() === "p")) {
      event.preventDefault();
      void move(active - 1);
    } else if (key === "Enter") {
      event.preventDefault();
      choose(active);
    } else if (key === "Escape" || isSearchShortcut(event, mac)) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (key === "Tab") {
      // Focus stays in the palette.
      event.preventDefault();
    }
  }

  function handleInput() {
    active = 0;
  }

  function resultLabel(result: SearchResult): string {
    switch (result.kind) {
      case "task":
        return result.done ? "done task" : "task";
      case "list":
        return "task list";
      default:
        return result.kind;
    }
  }
</script>

<!-- Clicking outside the palette closes it; the keyboard uses Escape. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="backdrop"
  onmousedown={(event) => {
    if (event.target !== event.currentTarget) return;
    // Focus goes back to where it was, not to the page.
    event.preventDefault();
    close(true);
  }}
>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Search and commands">
    <div class="field">
      <span class="prompt" aria-hidden="true">{mode.kind === "commands" ? ">" : "/"}</span>
      <input
        bind:this={input}
        bind:value={query}
        type="text"
        role="combobox"
        aria-label="Search notes, tasks and projects, or type > for commands"
        aria-expanded={rows.length > 0}
        aria-controls="{uid}-listbox"
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        placeholder="search, > commands"
        spellcheck="false"
        autocomplete="off"
        oninput={handleInput}
        onkeydown={handleKeydown}
      />
    </div>
    <ul
      class="rows"
      id="{uid}-listbox"
      role="listbox"
      aria-label={mode.kind === "commands" ? "Commands" : "Results"}
      bind:this={list}
    >
      {#each rows as row, index (row.kind === "command" ? row.command.id : row.result.id)}
        <!-- Options are chosen with the keyboard from the input; the mouse can click them. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(index)}
          class="row"
          role="option"
          aria-selected={index === active}
          onmousedown={(event) => event.preventDefault()}
          onmousemove={() => (active = index)}
          onclick={() => choose(index)}
        >
          {#if row.kind === "command"}
            <span class="icon"><Terminal aria-hidden="true" /></span>
            <span class="text"><span class="title">{row.command.label}</span></span>
          {:else}
            {@const result = row.result}
            <span class="icon">
              {#if result.kind === "note"}
                <FileText aria-hidden="true" />
              {:else if result.kind === "task"}
                {#if result.done}
                  <SquareCheck aria-hidden="true" />
                {:else}
                  <Square aria-hidden="true" />
                {/if}
              {:else if result.kind === "list"}
                <ListChecks aria-hidden="true" />
              {:else}
                <Folder aria-hidden="true" />
              {/if}
            </span>
            <span class="text">
              <span class="line">
                <span class="visually-hidden">{resultLabel(result)}:</span>
                <span class="title" class:done={result.done === true}>
                  {#each highlightSegments(result.title, result.titleRanges) as segment, part (part)}
                    {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                  {/each}
                </span>
                {#if result.kind !== "project" && result.kind !== "list"}
                  <span class="path">{result.path}</span>
                {/if}
              </span>
              {#if result.snippet}
                <span class="snippet">
                  {#each highlightSegments(result.snippet.text, result.snippet.ranges) as segment, part (part)}
                    {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                  {/each}
                </span>
              {/if}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if message}
      <p class="message" role="status">{message}</p>
    {/if}
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

  .palette {
    display: flex;
    flex-direction: column;
    width: min(var(--palette-width), calc(100% - var(--space-48)));
    max-height: var(--palette-max-height);
    overflow: hidden;
    background: var(--color-surface-raised);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-lg);
  }

  .field {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    padding: var(--space-10) var(--space-14);
    border-bottom: var(--space-1) solid var(--color-border);
  }

  .prompt {
    color: var(--color-accent);
  }

  input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: none;
  }

  input::placeholder {
    color: var(--color-muted);
  }

  .rows {
    overflow-y: auto;
    padding: var(--space-4) 0;
  }

  .rows:empty {
    display: none;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-10);
    padding: var(--space-6) var(--space-14);
    cursor: pointer;
  }

  .row[aria-selected="true"] {
    background: var(--color-selected);
    box-shadow: inset var(--selection-bar-width) 0 0 var(--color-accent);
  }

  .icon {
    display: flex;
    padding-top: var(--space-2);
    color: var(--color-muted);
  }

  .row[aria-selected="true"] .icon {
    color: var(--color-accent);
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: var(--space-10);
    min-width: 0;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title.done {
    color: var(--color-muted);
    text-decoration: line-through;
  }

  .path {
    flex-shrink: 1;
    min-width: 0;
    margin-left: auto;
    overflow: hidden;
    color: var(--color-muted);
    font-size: var(--font-size-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .snippet {
    overflow: hidden;
    color: var(--color-muted);
    font-size: var(--font-size-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  mark {
    background: none;
    color: var(--color-accent);
  }

  .message {
    padding: var(--space-10) var(--space-14);
    color: var(--color-muted);
  }
</style>
