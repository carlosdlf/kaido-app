<script lang="ts">
  import { splitTags } from "$lib/core/tags";
  import { parseTaskLine, type ParsedTask } from "$lib/core/tasks";
  import type { OpenDocument } from "./workspace";

  interface Props {
    doc: OpenDocument | undefined;
  }

  let { doc }: Props = $props();

  const NEWLINE = "\n";

  function tasks(lines: string[]): ParsedTask[] {
    return lines.map(parseTaskLine).filter((task): task is ParsedTask => task !== null);
  }
</script>

<main class="editor-pane" aria-label="Editor">
  {#if doc}
    <header class="header">
      <span class="path">{doc.folder}/<span class="file">{doc.file}</span></span>
      <span class="status">saved · {doc.age}</span>
    </header>

    {#key `${doc.folder}/${doc.file}`}
      <article class="note">
        {#each doc.body as block, index (index)}
          {#if block.kind === "heading" && block.level === 1}
            <h1><span class="marker" aria-hidden="true">#</span> {block.text}</h1>
          {:else if block.kind === "heading"}
            <h2><span class="marker" aria-hidden="true">##</span> {block.text}</h2>
          {:else if block.kind === "paragraph"}
            <p>
              {#each block.inlines as inline, inlineIndex (inlineIndex)}
                {#if inline.kind === "code"}<code>{inline.text}</code>{:else}{inline.text}{/if}
              {/each}
            </p>
          {:else if block.kind === "tags"}
            <ul class="tags" aria-label="Tags">
              {#each block.tags as tag (tag)}
                <li class="tag">#{tag}</li>
              {/each}
            </ul>
          {:else if block.kind === "shell"}
            <pre class="code">{#each block.commands as command, i (i)}{#if i > 0}{NEWLINE}{/if}<span
                  class="prompt"
                  aria-hidden="true">$</span
                > {command}{/each}</pre>
          {:else if block.kind === "tasks"}
            <ul class="checklist">
              {#each tasks(block.lines) as task, taskIndex (taskIndex)}
                <li>
                  <label class="task">
                    <!-- Read-only until task editing is wired to storage. -->
                    <input type="checkbox" checked={task.done} disabled />
                    <span class="task-text">
                      {#each splitTags(task.text) as segment, segmentIndex (segmentIndex)}
                        {#if segment.kind === "tag"}<span class="tag">{segment.text}</span
                          >{:else}{segment.text}{/if}
                      {/each}
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        {/each}
      </article>
    {/key}
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
  h2 {
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

  .marker {
    color: var(--color-dim);
    font-family: var(--font-ui);
    font-weight: var(--font-weight-regular);
  }

  p {
    margin-bottom: var(--space-12);
  }

  code {
    color: var(--color-accent);
    font-size: var(--font-size-ui);
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-8);
    margin-bottom: var(--space-28);
    font-family: var(--font-ui);
    font-size: var(--font-size-small);
  }

  .tag {
    color: var(--color-accent);
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

  .prompt {
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
