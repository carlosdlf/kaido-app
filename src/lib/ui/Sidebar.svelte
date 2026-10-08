<script lang="ts">
  import { nextListIndex } from "$lib/core/listNavigation";
  import type { FolderFixture, SyncFixture } from "./fixtures";
  import { ALL_TASKS, openTaskCount } from "./workspace";

  interface Props {
    inbox: FolderFixture;
    projects: FolderFixture[];
    sync: SyncFixture;
    selected: string;
    onselect: (id: string) => void;
  }

  let { inbox, projects, sync, selected, onselect }: Props = $props();

  let nav: HTMLElement | undefined = $state();

  const inboxOpen = $derived(openTaskCount(inbox));
  const allOpen = $derived(
    projects.reduce((sum, project) => sum + openTaskCount(project), inboxOpen),
  );

  const order = $derived([inbox.name, ALL_TASKS, ...projects.map((project) => project.name)]);

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
          data-nav-id={inbox.name}
          tabindex={selected === inbox.name ? 0 : -1}
          aria-current={selected === inbox.name ? "page" : undefined}
          onclick={() => onselect(inbox.name)}
        >
          <span class="label">~/inbox</span>
          <span class="count" aria-label="{inboxOpen} open tasks">[{inboxOpen}]</span>
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
          <span class="count" aria-label="{allOpen} open tasks">[{allOpen}]</span>
        </button>
      </li>
    </ul>

    <div class="group">
      <h2 class="heading" id="projects-heading"><span aria-hidden="true">#</span> projects</h2>
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
      <button type="button" class="item add">
        <span aria-hidden="true">+</span>
        <span>new project</span>
      </button>
    </div>
  </nav>

  <footer class="sync">
    <span class="visually-hidden">Sync status:</span>
    <span>
      {#if sync.state === "synced"}
        <span class="sync-ok" aria-hidden="true">✓</span>
      {:else}
        <span class="sync-paused" aria-hidden="true">!</span>
      {/if}
      {sync.branch}
    </span>
    <span>{sync.label}</span>
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

  .sync {
    display: flex;
    justify-content: space-between;
    gap: var(--space-8);
    margin-top: auto;
    padding: var(--space-8) var(--space-10) 0;
    border-top: var(--space-1) solid var(--color-border);
    color: var(--color-muted);
    font-size: var(--font-size-meta);
  }

  .sync-ok {
    color: var(--color-success);
  }

  .sync-paused {
    color: var(--color-danger);
  }
</style>
