<script lang="ts" module>
  /*
   * Window heights in logical pixels. They match the `--capture-*` tokens,
   * which lay out the same rows.
   */
  /** The input row; the window's height while nothing else is shown. */
  export const CAPTURE_HEIGHT = 52;
  /** One row of the project picker or of an error message. */
  export const CAPTURE_ROW_HEIGHT = 28;
  /** Projects listed at once; more scroll. */
  export const PICKER_ROWS = 6;
  /** How long to wait for the main window's answer, in milliseconds. */
  export const RESULT_TIMEOUT = 5_000;
  export const NO_ANSWER = "Kaido has not answered yet; the capture may still be added";
  export const NO_WORKSPACE = "Open a workspace in Kaido first";
  /** Captures that did not answer in time and are remembered for a late answer. */
  const TIMED_OUT_LIMIT = 100;
</script>

<script lang="ts">
  import { onMount, tick } from "svelte";
  import { INBOX } from "$lib/core/workspace";
  import { toStorageError, type CaptureChannel, type CaptureKind } from "$lib/storage";

  interface Props {
    channel: CaptureChannel;
  }

  let { channel }: Props = $props();

  const uid = $props.id();

  interface Pending {
    text: string;
    timer: ReturnType<typeof setTimeout>;
  }

  /** Text that was not captured, waiting to be put back into the input. */
  interface Held {
    /** The capture it came from; `null` for a draft moved aside by a restore. */
    id: string | null;
    text: string;
  }

  let text = $state("");
  /** Where captures go; remembered while the app runs. */
  let project = $state(INBOX);
  let projects: string[] = $state([INBOX]);
  /** `null` until the main window has answered. */
  let workspaceOpen: boolean | null = $state(null);
  let error: string | null = $state(null);
  /** A capture that was given up on was added after all. */
  let notice: string | null = $state(null);
  /** Failed captures that could not go back into the input because it had text. */
  let held: Held[] = $state([]);
  let picking = $state(false);
  let filter = $state("");
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let filterInput: HTMLInputElement | undefined = $state();
  /** Captures sent and not answered yet, by id. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  const pending = new Map<string, Pending>();
  /** Captures that got no answer in time, by id, with their text. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- private bookkeeping, never rendered
  const timedOut = new Map<string, string>();
  /** The failed capture whose text was put back into the input. */
  let restored: { id: string; text: string } | null = null;
  let sequence = 0;

  const matches = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    return needle === ""
      ? projects
      : projects.filter((name) => name.toLowerCase().includes(needle));
  });
  const message = $derived(error ?? notice);
  const height = $derived(
    CAPTURE_HEIGHT +
      (picking
        ? CAPTURE_ROW_HEIGHT * (Math.min(Math.max(matches.length, 1), PICKER_ROWS) + 1)
        : (message !== null ? CAPTURE_ROW_HEIGHT : 0) + (held.length > 0 ? CAPTURE_ROW_HEIGHT : 0)),
  );

  $effect(() => {
    channel.resize(height).catch(() => undefined);
  });

  onMount(() => {
    const stops: (() => void)[] = [];
    let mounted = true;
    const keep = (subscription: Promise<() => void>) => {
      subscription.then((stop) => (mounted ? stops.push(stop) : stop())).catch(() => undefined);
    };
    keep(channel.onShown(() => void shown()));
    keep(channel.onProjects(receiveProjects));
    keep(channel.onResult(receiveResult));
    channel.requestProjects().catch(() => undefined);
    input?.focus();
    return () => {
      mounted = false;
      for (const stop of stops) stop();
      for (const waiting of pending.values()) clearTimeout(waiting.timer);
      pending.clear();
    };
  });

  async function shown() {
    picking = false;
    channel.requestProjects().catch(() => undefined);
    await tick();
    input?.focus();
  }

  function receiveProjects(update: { projects: string[]; workspaceOpen: boolean }) {
    workspaceOpen = update.workspaceOpen;
    projects = update.projects.length > 0 ? update.projects : [INBOX];
    if (!projects.includes(project)) project = projects[0] ?? INBOX;
  }

  function receiveResult(result: { id: string; ok: boolean; message: string }) {
    const waiting = pending.get(result.id);
    if (waiting) {
      clearTimeout(waiting.timer);
      pending.delete(result.id);
      if (!result.ok) void fail(result.id, waiting.text, result.message);
      return;
    }
    if (!timedOut.has(result.id)) return;
    timedOut.delete(result.id);
    if (result.ok) {
      // Added after all: its text must not be captured a second time.
      forget(result.id);
      notice = result.message;
    } else {
      // Its text is already back; now the reason is known.
      error = result.message;
    }
  }

  /** Drops the text of a capture that was added late, unless it was edited since. */
  function forget(id: string) {
    if (restored?.id === id) {
      if (text === restored.text) text = "";
      restored = null;
    }
    held = held.filter((entry) => entry.id !== id);
    if (restored === null && held.every((entry) => entry.id === null)) error = null;
  }

  /**
   * Shows the window again with the text that was not captured and why.
   * The text goes back into the input when it is empty, and is held for a
   * restore otherwise, so it is never lost.
   */
  async function fail(id: string, lost: string, reason: string) {
    if (text.trim() === "") {
      text = lost;
      restored = { id, text: lost };
    } else {
      held = [...held, { id, text: lost }];
    }
    error = reason;
    notice = null;
    await channel.show().catch(() => undefined);
    await tick();
    input?.focus();
  }

  /** Puts the oldest held text into the input; a draft there is held instead. */
  async function restoreHeld() {
    const [first, ...rest] = held;
    if (!first) return;
    held = text.trim() === "" ? rest : [...rest, { id: null, text }];
    text = first.text;
    restored = first.id === null ? null : { id: first.id, text: first.text };
    if (held.length === 0) error = null;
    await tick();
    input?.focus();
  }

  function hide() {
    picking = false;
    notice = null;
    // Empty text is dropped; anything typed stays for the next time.
    if (text.trim() === "") text = "";
    channel.hide().catch(() => undefined);
  }

  function submit(kind: CaptureKind) {
    const value = text.trim();
    if (value === "" || workspaceOpen === false) return;
    sequence += 1;
    const id = `${Date.now()}-${sequence}`;
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      timedOut.set(id, value);
      if (timedOut.size > TIMED_OUT_LIMIT) {
        for (const oldest of timedOut.keys()) {
          timedOut.delete(oldest);
          break;
        }
      }
      void fail(id, value, NO_ANSWER);
    }, RESULT_TIMEOUT);
    pending.set(id, { text: value, timer });
    text = "";
    restored = null;
    error = null;
    // Hidden right away; the main window writes it and answers.
    hide();
    channel.submit({ id, kind, text: value, project }).catch((reason: unknown) => {
      const waiting = pending.get(id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      pending.delete(id);
      void fail(id, value, toStorageError(reason).message);
    });
  }

  async function openPicker() {
    picking = true;
    filter = "";
    active = Math.max(projects.indexOf(project), 0);
    await tick();
    filterInput?.focus();
  }

  async function closePicker(chosen: string | null) {
    if (chosen !== null) project = chosen;
    picking = false;
    await tick();
    input?.focus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      submit(event.shiftKey ? "note" : "task");
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      void openPicker();
    } else if (event.key === "Escape") {
      event.preventDefault();
      hide();
    } else if (event.key === "ArrowUp" && text === "" && held.length > 0) {
      event.preventDefault();
      void restoreHeld();
    }
  }

  function handlePickerKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    const count = matches.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count > 0) active = (active + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      document.getElementById(`${uid}-project-${active}`)?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = matches[active];
      if (chosen !== undefined) void closePicker(chosen);
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      void closePicker(null);
    }
  }
</script>

<svelte:window
  onblur={hide}
  onkeydown={(event) => {
    // Without a workspace there is no input; Escape still puts the window away.
    if (workspaceOpen === false && event.key === "Escape") hide();
  }}
/>

<main class="capture" aria-label="Quick capture">
  {#if workspaceOpen === false}
    <div class="row">
      <span class="prompt" aria-hidden="true">❯</span>
      <p class="notice" role="status">{NO_WORKSPACE}</p>
      <kbd class="hint" aria-hidden="true">esc</kbd>
    </div>
  {:else}
    <div class="row">
      <span class="prompt" aria-hidden="true">❯</span>
      <input
        bind:this={input}
        bind:value={text}
        class="text"
        type="text"
        aria-label="Capture a task or note"
        aria-describedby="{uid}-keys{error ? ` ${uid}-error` : ''}"
        aria-invalid={error ? "true" : undefined}
        placeholder="add a task…"
        spellcheck="false"
        autocomplete="off"
        oninput={() => {
          error = null;
          notice = null;
        }}
        onkeydown={handleKeydown}
      />
      <button
        type="button"
        class="chip"
        aria-haspopup="listbox"
        aria-expanded={picking}
        onclick={() => (picking ? void closePicker(null) : void openPicker())}
      >
        <span class="visually-hidden">Project:</span>
        {project}
      </button>
      <span class="visually-hidden" id="{uid}-keys"
        >Enter adds a task, Shift+Enter creates a note, Tab chooses the project, Escape closes.</span
      >
    </div>
    {#if picking}
      <div class="picker">
        <input
          bind:this={filterInput}
          bind:value={filter}
          class="filter"
          type="text"
          role="combobox"
          aria-label="Choose a project"
          aria-expanded={matches.length > 0}
          aria-controls="{uid}-projects"
          aria-activedescendant={matches.length > 0 ? `${uid}-project-${active}` : undefined}
          aria-autocomplete="list"
          placeholder="project"
          spellcheck="false"
          autocomplete="off"
          oninput={() => (active = 0)}
          onkeydown={handlePickerKeydown}
        />
        <ul class="projects" id="{uid}-projects" role="listbox" aria-label="Projects">
          {#each matches as name, index (name)}
            <!-- Chosen with the keyboard from the filter; the mouse can click. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              id="{uid}-project-{index}"
              class="project"
              role="option"
              aria-selected={index === active}
              onmousedown={(event) => event.preventDefault()}
              onclick={() => void closePicker(name)}
            >
              {name}
            </li>
          {:else}
            <li class="empty" role="presentation">No matching project</li>
          {/each}
        </ul>
      </div>
    {:else}
      {#if error}
        <p class="message error" id="{uid}-error" role="alert">{error}</p>
      {:else if notice}
        <p class="message" role="status">{notice}</p>
      {/if}
      {#if held.length > 0}
        <div class="held">
          <span class="held-text">
            <span class="visually-hidden">Not added:</span>
            {held[0]?.text}
          </span>
          {#if held.length > 1}
            <span class="held-more">+{held.length - 1}</span>
          {/if}
          <button type="button" class="restore" onclick={() => void restoreHeld()}>
            <kbd aria-hidden="true">↑</kbd> restore
          </button>
        </div>
      {/if}
    {/if}
  {/if}
</main>

<style>
  .capture {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--color-bg);
    border: var(--space-1) solid var(--color-border-strong);
  }

  .row {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--space-10);
    height: calc(var(--capture-height) - 2 * var(--space-1));
    padding: 0 var(--space-14);
  }

  .prompt {
    color: var(--color-accent);
  }

  .text,
  .filter {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    outline: none;
  }

  .text::placeholder,
  .filter::placeholder {
    color: var(--color-muted);
  }

  .chip {
    flex-shrink: 0;
    max-width: 40%;
    padding: var(--space-2) var(--space-8);
    overflow: hidden;
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    color: var(--color-muted);
    font-size: var(--font-size-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip:hover,
  .chip[aria-expanded="true"] {
    color: var(--color-text);
  }

  .notice {
    flex: 1;
    color: var(--color-muted);
  }

  .hint {
    color: var(--color-muted);
    font-size: var(--font-size-meta);
  }

  .picker {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-top: var(--space-1) solid var(--color-border);
  }

  .filter {
    flex: none;
    height: var(--capture-row-height);
    padding: 0 var(--space-14);
  }

  .projects {
    overflow-y: auto;
  }

  .project,
  .empty {
    height: var(--capture-row-height);
    padding: 0 var(--space-14);
    overflow: hidden;
    line-height: var(--capture-row-height);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project {
    cursor: pointer;
  }

  .project[aria-selected="true"] {
    background: var(--color-selected);
    box-shadow: inset var(--selection-bar-width) 0 0 var(--color-accent);
  }

  .empty {
    color: var(--color-muted);
  }

  .message {
    flex-shrink: 0;
    height: var(--capture-row-height);
    padding: 0 var(--space-14);
    overflow: hidden;
    color: var(--color-muted);
    font-size: var(--font-size-small);
    line-height: var(--capture-row-height);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .error {
    color: var(--color-danger);
  }

  .held {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--space-8);
    height: var(--capture-row-height);
    padding: 0 var(--space-14);
    border-top: var(--space-1) solid var(--color-border-subtle);
    font-size: var(--font-size-small);
  }

  .held-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--color-text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .held-more {
    color: var(--color-muted);
  }

  .restore {
    flex-shrink: 0;
    padding: 0 var(--space-6);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    color: var(--color-muted);
    font-size: var(--font-size-meta);
  }

  .restore:hover {
    color: var(--color-text);
  }
</style>
