<script lang="ts">
  import { parseBlocks } from "$lib/core/blocks";
  import { formatAge } from "$lib/core/time";
  import { splitPath } from "$lib/core/views";
  import type { DocumentState } from "./appState.svelte";
  import InlineText from "./InlineText.svelte";

  interface Props {
    doc: DocumentState | null;
    /** Current time, for the relative age. */
    now: number;
  }

  let { doc, now }: Props = $props();

  const location = $derived(doc ? splitPath(doc.path) : null);
  const blocks = $derived(doc?.status === "ready" ? parseBlocks(doc.text) : []);
</script>

<main class="editor-pane" aria-label="Editor">
  {#if doc && location}
    <header class="header">
      <span class="path">{location.folder}<span class="file">{location.file}</span></span>
      {#if doc.status === "ready"}
        <span class="status">read-only · {formatAge(doc.modified, now)}</span>
      {/if}
    </header>

    {#if doc.status === "ready"}
      {#key doc.path}
        <article class="note">
          {#each blocks as block, index (index)}
            {#if block.kind === "heading"}
              {#if block.level === 1}
                <h1><span class="marker" aria-hidden="true">#</span> {block.text}</h1>
              {:else if block.level === 2}
                <h2><span class="marker" aria-hidden="true">##</span> {block.text}</h2>
              {:else}
                <h3>
                  <span class="marker" aria-hidden="true">{"#".repeat(block.level)}</span>
                  {block.text}
                </h3>
              {/if}
            {:else if block.kind === "paragraph"}
              <p>
                <InlineText text={block.text} />
              </p>
            {:else if block.kind === "code"}
              <pre class="code">{block.text}</pre>
            {:else if block.kind === "list"}
              <ul class="bullets">
                {#each block.items as text, itemIndex (itemIndex)}
                  <li>
                    <InlineText {text} />
                  </li>
                {/each}
              </ul>
            {:else}
              <ul class="checklist">
                {#each block.tasks as task, taskIndex (taskIndex)}
                  <li>
                    <label class="task">
                      <!-- Read-only until task editing is wired to storage. -->
                      <input type="checkbox" checked={task.done} disabled />
                      <span class="task-text">
                        <InlineText text={task.text} />
                      </span>
                    </label>
                  </li>
                {/each}
              </ul>
            {/if}
          {:else}
            <p class="empty-note">This note is empty.</p>
          {/each}
        </article>
      {/key}
    {:else if doc.status === "too-large"}
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
    overflow-y: auto;
    background: var(--color-bg);
  }

  .header {
    position: sticky;
    top: 0;
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

  .note {
    width: 100%;
    max-width: var(--note-max-width);
    padding: var(--space-40) var(--space-48) var(--space-80);
    color: var(--color-text-note);
    font-family: var(--font-note);
    font-size: var(--font-size-note);
    line-height: var(--line-height-note);
  }

  h1,
  h2,
  h3 {
    color: var(--color-heading);
    font-weight: var(--font-weight-semibold);
  }

  h1 {
    margin-bottom: var(--space-14);
    font-size: var(--font-size-note-h1);
    line-height: var(--line-height-heading);
  }

  h2 {
    margin-bottom: var(--space-10);
    font-size: var(--font-size-note-h2);
  }

  h3 {
    margin-bottom: var(--space-8);
    font-size: var(--font-size-note);
  }

  .marker {
    color: var(--color-dim);
    font-family: var(--font-ui);
    font-weight: var(--font-weight-regular);
  }

  p {
    margin-bottom: var(--space-12);
  }

  .code {
    margin-bottom: var(--space-28);
    padding: var(--space-14) var(--space-16);
    background: var(--color-surface-raised);
    border: var(--space-1) solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--font-size-ui);
    line-height: var(--line-height-note);
    white-space: pre-wrap;
  }

  .bullets {
    margin-bottom: var(--space-12);
    padding-left: var(--space-20);
    list-style: disc;
  }

  .empty-note {
    color: var(--color-muted);
  }

  .checklist {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    margin-bottom: var(--space-28);
    font-family: var(--font-ui);
    font-size: var(--font-size-ui);
  }

  .task {
    display: flex;
    align-items: center;
    gap: var(--space-10);
  }

  .task:has(input:checked) .task-text {
    color: var(--color-muted);
    text-decoration: line-through;
  }

  /*
   * Drawn by hand so the look is identical across webviews and does not
   * change while the checkbox is disabled.
   */
  input[type="checkbox"] {
    position: relative;
    flex-shrink: 0;
    width: var(--checkbox-size);
    height: var(--checkbox-size);
    margin: 0;
    appearance: none;
    background: var(--color-bg);
    border: var(--space-1) solid var(--color-muted);
    border-radius: var(--radius-sm);
  }

  input[type="checkbox"]:checked {
    background: var(--color-accent);
    border-color: var(--color-accent);
  }

  input[type="checkbox"]:checked::after {
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

  input[type="checkbox"]:focus-visible {
    outline-offset: var(--space-2);
  }

  .empty {
    margin: auto;
    color: var(--color-muted);
  }
</style>
