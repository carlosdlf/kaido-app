<script lang="ts">
  import { tick, untrack } from "svelte";
  import Folder from "@lucide/svelte/icons/folder";
  import Inbox from "@lucide/svelte/icons/inbox";
  import ListChecks from "@lucide/svelte/icons/list-checks";
  import Plus from "@lucide/svelte/icons/plus";
  import CircleSlash from "@lucide/svelte/icons/circle-slash";
  import CirclePause from "@lucide/svelte/icons/circle-pause";
  import CloudCheck from "@lucide/svelte/icons/cloud-check";
  import CloudOff from "@lucide/svelte/icons/cloud-off";
  import HardDrive from "@lucide/svelte/icons/hard-drive";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import CloudUpload from "@lucide/svelte/icons/cloud-upload";
  import { syncAnnouncement, type SyncIcon, type SyncView } from "$lib/core/syncStatus";
  import { nextListIndex } from "$lib/core/listNavigation";
  import { ALL_TASKS, type SidebarEntry } from "$lib/core/views";
  import { INBOX } from "$lib/core/workspace";
  import type { ProjectOutcome } from "./appState.svelte";

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
    /** Creates a project with the typed name. */
    oncreateproject?: (name: string) => Promise<ProjectOutcome>;
    /** The new project shortcut, for assistive technology and as a visible hint. */
    createProjectShortcut?: { aria: string; hint: string };
    /** Each new value opens the new project field. */
    newProjectRequest?: number;
    /** Git sync status, or `null` while there is none to show. */
    sync?: SyncView | null;
    /** Sync now. */
    onsync?: () => void;
    /** The sync shortcut, for assistive technology and the tooltip. */
    syncShortcut?: { aria: string; hint: string };
  }

  let {
    entries,
    allOpen,
    workspaceName,
    warnings,
    notice,
    onpick,
    selected,
    onselect,
    oncreateproject,
    createProjectShortcut,
    newProjectRequest = 0,
    sync = null,
    onsync,
    syncShortcut,
  }: Props = $props();

  const SYNC_ICONS = {
    checking: RefreshCw,
    synced: CloudCheck,
    syncing: RefreshCw,
    pending: CloudUpload,
    local: HardDrive,
    offline: CloudOff,
    paused: CirclePause,
    failed: TriangleAlert,
    unavailable: CircleSlash,
  } satisfies Record<SyncIcon, unknown>;

  const SyncGlyph = $derived(sync ? SYNC_ICONS[sync.icon] : null);

  /**
   * Read out politely when the sync state changes. Transient states and the
   * age of the last sync are skipped, so a routine sync stays silent.
   */
  let announced = $state("");
  $effect(() => {
    if (!sync) {
      announced = "";
      return;
    }
    const next = syncAnnouncement(sync);
    if (next !== null) announced = next;
  });
  const syncHint = $derived(
    syncShortcut ? `Click or press ${syncShortcut.hint} to sync now.` : "Click to sync now.",
  );
  const syncTooltip = $derived(sync ? [...sync.details, syncHint].join("\n") : "");

  // New project
  let creating = $state(false);
  let projectDraft = $state("");
  let projectError: string | null = $state(null);
  let submitting = false;
  let addButton: HTMLButtonElement | undefined = $state();

  function startProject() {
    creating = true;
    projectDraft = "";
    projectError = null;
  }

  async function closeProject(returnFocus: boolean) {
    creating = false;
    projectError = null;
    if (!returnFocus) return;
    await tick();
    addButton?.focus();
  }

  async function submitProject() {
    if (submitting || !oncreateproject) return;
    if (projectDraft.trim() === "") {
      void closeProject(true);
      return;
    }
    submitting = true;
    const outcome = await oncreateproject(projectDraft);
    submitting = false;
    if (!creating) return;
    if (outcome.kind === "invalid") projectError = outcome.reason;
    // A created project's task list takes focus; after a failure it goes back to the button.
    else void closeProject(outcome.kind === "failed");
  }

  function handleProjectKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submitProject();
    } else if (event.key === "Escape") {
      event.preventDefault();
      void closeProject(true);
    }
  }

  /** Leaving the field cancels; switching windows keeps it open. */
  function handleProjectBlur() {
    if (!document.hasFocus() || submitting) return;
    void closeProject(false);
  }

  function focusField(input: HTMLInputElement) {
    input.focus();
  }

  let handledRequest = untrack(() => newProjectRequest);
  $effect(() => {
    const request = newProjectRequest;
    if (request === handledRequest) return;
    handledRequest = request;
    untrack(startProject);
  });

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
          <Inbox aria-hidden="true" />
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
          <ListChecks aria-hidden="true" />
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
                <span class="glyph"><Folder aria-hidden="true" /></span>
                <span class="label">{project.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint">No projects yet</p>
      {/if}
      {#if creating}
        <div class="new-project">
          <label class="visually-hidden" for="new-project-input">New project name</label>
          <input
            id="new-project-input"
            class="project-input"
            type="text"
            placeholder="project name"
            spellcheck="false"
            autocomplete="off"
            bind:value={projectDraft}
            aria-invalid={projectError ? "true" : undefined}
            aria-describedby={projectError ? "new-project-error" : undefined}
            oninput={() => (projectError = null)}
            onkeydown={handleProjectKeydown}
            onblur={handleProjectBlur}
            {@attach focusField}
          />
          {#if projectError}
            <span id="new-project-error" class="project-error" role="alert">{projectError}</span>
          {/if}
        </div>
      {:else}
        <button
          type="button"
          class="item add"
          bind:this={addButton}
          aria-keyshortcuts={createProjectShortcut?.aria}
          onclick={startProject}
        >
          <Plus aria-hidden="true" />
          <span class="label">new project</span>
          {#if createProjectShortcut}
            <kbd aria-hidden="true">{createProjectShortcut.hint}</kbd>
          {/if}
        </button>
      {/if}
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
      {#if sync && SyncGlyph}
        <button
          type="button"
          class="sync"
          data-tone={sync.tone}
          data-icon={sync.icon}
          title={syncTooltip}
          aria-keyshortcuts={syncShortcut?.aria}
          aria-describedby="sync-details"
          onclick={() => onsync?.()}
        >
          <SyncGlyph aria-hidden="true" />
          <span class="visually-hidden">Sync now, </span>
          <span class="sync-text">{sync.text}</span>
        </button>
        <span id="sync-details" class="visually-hidden">{sync.details.join("; ")}</span>
      {/if}
      <span class="visually-hidden" role="status" aria-live="polite">{announced}</span>
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
    align-items: center;
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

  .glyph,
  .item :global(.lucide-icon) {
    display: flex;
    color: var(--color-muted);
  }

  .item[aria-current="page"] .glyph,
  .item[aria-current="page"] :global(.lucide-icon) {
    color: var(--color-accent);
  }

  .add {
    color: var(--color-muted);
  }

  .new-project {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-6);
  }

  .project-input {
    width: 100%;
    padding: var(--space-4) var(--space-6);
    background: var(--color-bg);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
  }

  .project-input::placeholder {
    color: var(--color-muted);
  }

  .project-input[aria-invalid="true"] {
    border-color: var(--color-danger);
  }

  .project-error {
    color: var(--color-danger);
    font-size: var(--font-size-small);
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
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sync {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--space-4);
    max-width: 70%;
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
    color: var(--color-muted);
  }

  .sync:hover {
    color: var(--color-text);
  }

  .sync :global(.lucide-icon) {
    flex-shrink: 0;
  }

  .sync-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sync[data-tone="ok"] :global(.lucide-icon) {
    color: var(--color-success);
  }

  .sync[data-tone="warning"] {
    color: var(--color-warning);
  }

  .sync[data-tone="error"] {
    color: var(--color-danger);
  }

  .sync[data-icon="syncing"] :global(.lucide-icon) {
    animation: spin var(--duration-spin) linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .sync[data-icon="syncing"] :global(.lucide-icon) {
      animation: none;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(1turn);
    }
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
