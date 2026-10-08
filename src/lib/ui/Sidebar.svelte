<script lang="ts">
  import { nextListIndex } from "$lib/core/listNavigation";
  import { ALL_TASKS, type SidebarEntry } from "$lib/core/views";
  import { INBOX } from "$lib/core/workspace";

  interface Props {
    /** Projects in display order; the first one is the inbox. */
    entries: SidebarEntry[];
    allOpen: number | null;
    /** Name of the workspace folder, shown in the footer. */
    workspaceName: string;
    warnings: string[];
    /** A problem keeping the workspace up to date. */
    notice: string | null;
    onpick: () => void;
    selected: string;
    onselect: (id: string) => void;
  }

  let { entries, allOpen, workspaceName, warnings, notice, onpick, selected, onselect }: Props =
    $props();

  let nav: HTMLElement | undefined = $state();

  const inbox = $derived(entries.find((entry) => entry.name === INBOX));
  const projects = $derived(entries.filter((entry) => entry.name !== INBOX));
  const order = $derived([INBOX, ALL_TASKS, ...projects.map((project) => project.name)]);

  function count(value: number | null | undefined): string {
    return value === null || value === undefined ? "…" : String(value);
  }

  function countLabel(value: number | null | undefined): string {
    return value === null || value === undefined ? "counting open tasks" : `${value} open tasks`;
  }

  function handleKeydown(event: KeyboardEvent) {
    // Only arrow through folder entries, not the other buttons in the nav.
    if (!(event.target instanceof HTMLElement) || !event.target.dataset["navId"]) return;
    const next = nextListIndex(event.key, order.indexOf(selected), order.length);
    if (next === null) return;
    event.preventDefault();
    const id = order[next];
    if (id === undefined) return;
    onselect(id);
    nav?.querySelector<HTMLButtonElement>(`[data-nav-id="${CSS.escape(id)}"]`)?.focus();
  }
</script>

<aside class="sidebar" aria-label="Sidebar">
  <div class="brand"><span class="prompt" aria-hidden="true">❯</span>kaido</div>

  <button type="button" class="search" aria-keyshortcuts="Control+K">
    <span class="slash" aria-hidden="true">/</span>
    <span class="search-label">search or command</span>
    <kbd aria-hidden="true">^K</kbd>
  </button>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <nav class="nav" aria-label="Workspace" bind:this={nav} onkeydown={handleKeydown}>
    <ul class="group">
      <li>
        <button
          type="button"
          class="item"
          data-nav-id={INBOX}
          tabindex={selected === INBOX ? 0 : -1}
          aria-current={selected === INBOX ? "page" : undefined}
          onclick={() => onselect(INBOX)}
        >
          <span class="label">~/inbox</span>
          <span class="count" aria-label={countLabel(inbox?.openCount)}
            >[{count(inbox?.openCount)}]</span
          >
        </button>
      </li>
      <li>
        <button
          type="button"
          class="item"
          data-nav-id={ALL_TASKS}
          tabindex={selected === ALL_TASKS ? 0 : -1}
          aria-current={selected === ALL_TASKS ? "page" : undefined}
          onclick={() => onselect(ALL_TASKS)}
        >
          <span class="label">~/all-tasks</span>
          <span class="count" aria-label={countLabel(allOpen)}>[{count(allOpen)}]</span>
        </button>
      </li>
    </ul>

    <div class="group">
      <h2 class="heading" id="projects-heading"><span aria-hidden="true">#</span> projects</h2>
      {#if projects.length > 0}
        <ul class="group" aria-labelledby="projects-heading">
          {#each projects as project (project.name)}
            <li>
              <button
                type="button"
                class="item"
                data-nav-id={project.name}
                tabindex={selected === project.name ? 0 : -1}
                aria-current={selected === project.name ? "page" : undefined}
                onclick={() => onselect(project.name)}
              >
                <span class="glyph" aria-hidden="true">▸</span>
                <span class="label">{project.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint">No projects yet</p>
      {/if}
      <button type="button" class="item add">
        <span aria-hidden="true">+</span>
        <span>new project</span>
      </button>
    </div>
  </nav>

  <footer class="footer">
    {#if notice}
      <div class="notice" role="alert">
        <p>{notice}</p>
        <button type="button" class="notice-action" onclick={onpick}>Open folder…</button>
      </div>
    {/if}
    {#if warnings.length > 0}
      <details class="warnings">
        <summary>
          <span class="warning-mark" aria-hidden="true">!</span>
          {warnings.length}
          {warnings.length === 1 ? "settings warning" : "settings warnings"}
        </summary>
        <ul>
          {#each warnings as warning, index (index)}
            <li>{warning}</li>
          {/each}
        </ul>
      </details>
    {/if}
    <div class="status">
      <span class="workspace" title={workspaceName}>~/{workspaceName}</span>
      <span>local only</span>
    </div>
  </footer>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
    min-height: 0;
    padding: var(--space-16) var(--space-12);
    overflow-y: auto;
    background: var(--color-panel);
    border-right: var(--space-1) solid var(--color-border);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    padding: 0 var(--space-8);
    font-weight: var(--font-weight-bold);
  }

  .prompt,
  .slash {
    color: var(--color-accent);
  }

  .search {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    padding: var(--space-8) var(--space-10);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-md);
    color: var(--color-muted);
    transition: border-color var(--duration-fast) var(--easing-standard);
  }

  .search:hover {
    border-color: var(--color-dim);
  }

  .search-label {
    flex: 1;
  }

  kbd {
    padding: var(--space-1) var(--space-4);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-meta);
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .heading {
    padding: 0 var(--space-10) var(--space-6);
    color: var(--color-muted);
    font-size: var(--font-size-meta);
    font-weight: var(--font-weight-regular);
  }

  .item {
    display: flex;
    gap: var(--space-8);
    width: 100%;
    padding: var(--space-6) var(--space-10);
    border-radius: var(--radius-sm);
  }

  .item:hover {
    background: var(--color-selected);
  }

  .item[aria-current="page"] {
    background: var(--color-selected);
    box-shadow: inset var(--selection-bar-width) 0 0 var(--color-accent);
  }

  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    color: var(--color-muted);
  }

  .glyph {
    color: var(--color-dim);
  }

  .item[aria-current="page"] .glyph {
    color: var(--color-accent);
  }

  .add {
    color: var(--color-muted);
  }

  .hint {
    padding: var(--space-6) var(--space-10);
    color: var(--color-muted);
  }

  .footer {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    margin-top: auto;
    padding: var(--space-8) var(--space-10) 0;
    border-top: var(--space-1) solid var(--color-border);
    color: var(--color-muted);
    font-size: var(--font-size-meta);
  }

  .status {
    display: flex;
    justify-content: space-between;
    gap: var(--space-8);
  }

  .workspace {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .notice {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    padding: var(--space-8);
    background: var(--color-paused-bg);
    border: var(--space-1) solid var(--color-paused-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
  }

  .notice-action {
    align-self: flex-start;
    color: var(--color-accent);
  }

  .notice-action:hover {
    color: var(--color-accent-hover);
  }

  .warnings summary {
    cursor: pointer;
  }

  .warnings ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-top: var(--space-6);
    overflow-wrap: anywhere;
  }

  .warning-mark {
    color: var(--color-danger);
  }
</style>
