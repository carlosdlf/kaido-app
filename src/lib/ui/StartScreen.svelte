<script lang="ts">
  import { tick } from "svelte";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import X from "@lucide/svelte/icons/x";
  import { cloneFolderName, folderName } from "$lib/core/workspaceLocation";
  import type { GitVersion } from "$lib/storage";
  import type { NewWorkspaceOutcome, PickedFolder } from "./appState.svelte";

  interface Props {
    title: string;
    message: string;
    /** Shown as an alert, e.g. when the last workspace could not be opened. */
    error?: boolean;
    /** A folder is being opened: only the title and message are shown. */
    busy?: boolean;
    /** Whether git is installed, or `null` while unknown. */
    git?: GitVersion | null;
    /** Recently opened workspaces, most recent first. */
    recents?: readonly string[];
    /** Recent workspaces that were not found. */
    missing?: ReadonlySet<string>;
    /** The workspace still open behind this screen, to go back to. */
    current?: string | null;
    onpick: () => void;
    onopenrecent?: (path: string) => void;
    onremoverecent?: (path: string) => void;
    onpickfolder?: () => Promise<PickedFolder>;
    oncreate?: (parent: string, name: string) => Promise<NewWorkspaceOutcome>;
    onclone?: (url: string, parent: string, name: string) => Promise<NewWorkspaceOutcome>;
    oncancelclone?: () => void;
    onback?: () => void;
  }

  let {
    title,
    message,
    error = false,
    busy = false,
    git = null,
    recents = [],
    missing = new Set(),
    current = null,
    onpick,
    onopenrecent,
    onremoverecent,
    onpickfolder,
    oncreate,
    onclone,
    oncancelclone,
    onback,
  }: Props = $props();

  const uid = $props.id();
  const DEFAULT_NAME = "notes";

  /** The inline form that is open. */
  let form: "create" | "clone" | null = $state(null);
  let parent = $state("");
  let name = $state(DEFAULT_NAME);
  /** The folder name was typed, so the URL no longer suggests one. */
  let nameEdited = $state(false);
  let url = $state("");
  let formError: string | null = $state(null);
  let working = $state(false);
  let cloning = $state(false);
  let createButton: HTMLButtonElement | undefined = $state();
  let cloneButton: HTMLButtonElement | undefined = $state();

  function openForm(kind: "create" | "clone") {
    if (form !== kind) {
      formError = null;
      nameEdited = false;
      name = kind === "create" ? DEFAULT_NAME : cloneFolderName(url);
    }
    form = kind;
  }

  async function closeForm() {
    const kind = form;
    form = null;
    formError = null;
    await tick();
    (kind === "clone" ? cloneButton : createButton)?.focus();
  }

  async function chooseParent() {
    if (!onpickfolder) return;
    const picked = await onpickfolder();
    if (picked.kind === "picked") {
      parent = picked.path;
      formError = null;
    } else if (picked.kind === "failed") {
      formError = picked.message;
    }
  }

  function handleUrlInput() {
    formError = null;
    if (!nameEdited) name = cloneFolderName(url);
  }

  function handleNameInput() {
    formError = null;
    nameEdited = true;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (working) return;
    const kind = form;
    if (kind === null) return;
    working = true;
    cloning = kind === "clone";
    formError = null;
    let outcome: NewWorkspaceOutcome | undefined;
    try {
      outcome =
        kind === "create" ? await oncreate?.(parent, name) : await onclone?.(url, parent, name);
    } finally {
      working = false;
      cloning = false;
    }
    if (outcome?.kind === "invalid") formError = outcome.message;
    else if (outcome?.kind === "cancelled") formError = "Cloning was cancelled.";
  }

  function handleFormKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.isComposing) return;
    event.preventDefault();
    if (cloning) oncancelclone?.();
    else if (!working) void closeForm();
  }

  function gitLine(info: GitVersion): string {
    if (!info.available)
      return "git not found — Kaido works, but sync is off. Install git to sync.";
    return info.version ? `git ${info.version} found` : "git found";
  }

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }
</script>

<main class="start" aria-labelledby="{uid}-title" aria-busy={busy}>
  <div class="panel">
    <div class="brand"><span class="prompt" aria-hidden="true">❯</span>kaido</div>
    <h1 id="{uid}-title">{title}</h1>
    {#if message}
      <p class="message" class:error role={error ? "alert" : undefined}>{message}</p>
    {/if}
    {#if git}
      <p class="git" class:missing={!git.available}>
        <GitBranch aria-hidden="true" />
        {gitLine(git)}
      </p>
    {/if}

    {#if !busy}
      <div class="actions">
        <button type="button" class="primary" onclick={onpick} {@attach focusOnMount}>
          <FolderOpen aria-hidden="true" />Open folder…
        </button>
        <button
          type="button"
          class="secondary"
          bind:this={createButton}
          aria-expanded={form === "create"}
          aria-controls="{uid}-form"
          onclick={() => openForm("create")}
        >
          <FolderPlus aria-hidden="true" />Create new…
        </button>
        <button
          type="button"
          class="secondary"
          bind:this={cloneButton}
          aria-expanded={form === "clone"}
          aria-controls="{uid}-form"
          onclick={() => openForm("clone")}
        >
          <GitBranch aria-hidden="true" />Clone from URL…
        </button>
      </div>

      {#if form}
        <!-- Escape closes the form, or cancels a clone that is running. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <form
          id="{uid}-form"
          class="form"
          aria-label={form === "create" ? "Create a new workspace" : "Clone a repository"}
          onsubmit={submit}
          onkeydown={handleFormKeydown}
        >
          {#if form === "clone"}
            <label class="field">
              <span class="label">Repository URL</span>
              <input
                type="text"
                bind:value={url}
                placeholder="git@github.com:you/notes.git"
                spellcheck="false"
                autocomplete="off"
                disabled={working}
                oninput={handleUrlInput}
                {@attach focusOnMount}
              />
            </label>
          {/if}
          <div class="field">
            <span class="label" id="{uid}-parent-label">Location</span>
            <div class="location">
              <span class="path" id="{uid}-parent" class:empty={parent === ""}>
                {parent === "" ? "no folder chosen" : parent}
              </span>
              <button
                type="button"
                class="secondary small"
                aria-describedby="{uid}-parent-label {uid}-parent"
                disabled={working}
                onclick={() => void chooseParent()}
                {@attach (node: HTMLButtonElement) => {
                  if (form === "create") node.focus();
                }}
              >
                Choose…
              </button>
            </div>
          </div>
          <label class="field">
            <span class="label">Folder name</span>
            <input
              type="text"
              bind:value={name}
              spellcheck="false"
              autocomplete="off"
              disabled={working}
              oninput={handleNameInput}
            />
          </label>
          {#if form === "create"}
            <p class="hint">A new or empty folder. Kaido adds an inbox and git setup files.</p>
          {/if}
          {#if formError}
            <p class="form-error" role="alert">{formError}</p>
          {/if}
          <div class="form-actions">
            {#if cloning}
              <span class="progress" role="status">
                <LoaderCircle aria-hidden="true" />Cloning…
              </span>
              <button type="button" class="secondary small" onclick={() => oncancelclone?.()}>
                Cancel
              </button>
            {:else}
              <button type="submit" class="primary small" disabled={working}>
                {form === "create" ? "Create" : "Clone"}
              </button>
              <button
                type="button"
                class="secondary small"
                disabled={working}
                onclick={() => void closeForm()}
              >
                Cancel
              </button>
            {/if}
          </div>
        </form>
      {/if}

      {#if recents.length > 0}
        <section class="recents" aria-labelledby="{uid}-recents">
          <h2 id="{uid}-recents">Recent workspaces</h2>
          <ul>
            {#each recents as path (path)}
              {@const gone = missing.has(path)}
              <li class:gone>
                <button
                  type="button"
                  class="recent"
                  aria-describedby={gone ? `${uid}-gone` : undefined}
                  onclick={() => onopenrecent?.(path)}
                >
                  <span class="recent-name">{folderName(path)}</span>
                  <span class="recent-path">{path}</span>
                  {#if gone}
                    <span class="not-found">not found</span>
                  {/if}
                </button>
                <button
                  type="button"
                  class="remove"
                  aria-label="Remove {folderName(path)} from recent workspaces"
                  title="Remove from recent workspaces"
                  onclick={() => onremoverecent?.(path)}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            {/each}
          </ul>
          <span id="{uid}-gone" class="visually-hidden">The folder was not found.</span>
        </section>
      {/if}

      {#if current && onback}
        <button type="button" class="back" onclick={onback}>
          ← back to {folderName(current)}
        </button>
      {/if}
    {/if}
  </div>
</main>

<style>
  .start {
    display: grid;
    place-items: center;
    height: 100%;
    padding: var(--space-24);
    overflow-y: auto;
    background: var(--color-bg);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
    width: min(var(--start-width), 100%);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    font-weight: var(--font-weight-bold);
  }

  .prompt {
    color: var(--color-accent);
  }

  h1 {
    color: var(--color-heading);
    font-size: var(--font-size-title);
    font-weight: var(--font-weight-semibold);
  }

  .message {
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }

  .message.error {
    color: var(--color-danger);
  }

  .git {
    display: flex;
    align-items: center;
    gap: var(--space-6);
    color: var(--color-muted);
    font-size: var(--font-size-small);
  }

  .git.missing {
    color: var(--color-warning);
  }

  .actions,
  .form-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8);
  }

  .primary,
  .secondary {
    display: inline-flex;
    align-items: center;
    gap: var(--space-6);
    padding: var(--space-8) var(--space-14);
    border-radius: var(--radius-md);
  }

  .primary {
    background: var(--color-accent);
    color: var(--color-on-accent);
    font-weight: var(--font-weight-bold);
  }

  .primary:hover:not(:disabled) {
    background: var(--color-accent-hover);
  }

  .secondary {
    border: var(--space-1) solid var(--color-border-strong);
  }

  .secondary:hover:not(:disabled) {
    border-color: var(--color-dim);
  }

  .small {
    padding: var(--space-4) var(--space-10);
  }

  button:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .primary:focus-visible,
  .secondary:focus-visible {
    outline-offset: var(--space-2);
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-12);
    padding: var(--space-16);
    background: var(--color-panel);
    border: var(--space-1) solid var(--color-border);
    border-radius: var(--radius-lg);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .label {
    color: var(--color-muted);
    font-size: var(--font-size-small);
  }

  input {
    padding: var(--space-6) var(--space-8);
    background: var(--color-bg);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
  }

  input::placeholder {
    color: var(--color-muted);
  }

  .location {
    display: flex;
    align-items: center;
    gap: var(--space-8);
  }

  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path.empty,
  .hint {
    color: var(--color-muted);
  }

  .hint {
    font-size: var(--font-size-small);
  }

  .form-error {
    color: var(--color-danger);
    overflow-wrap: anywhere;
  }

  .progress {
    display: inline-flex;
    align-items: center;
    gap: var(--space-6);
    color: var(--color-muted);
  }

  .progress :global(.lucide-icon) {
    animation: spin var(--duration-spin) linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .progress :global(.lucide-icon) {
      animation: none;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(1turn);
    }
  }

  .recents {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  h2 {
    color: var(--color-muted);
    font-size: var(--font-size-meta);
    font-weight: var(--font-weight-regular);
  }

  .recents li {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    border-radius: var(--radius-sm);
  }

  .recents li:hover {
    background: var(--color-selected);
  }

  .recent {
    display: flex;
    flex: 1;
    align-items: baseline;
    gap: var(--space-10);
    min-width: 0;
    padding: var(--space-6) var(--space-10);
    border-radius: var(--radius-sm);
  }

  .recent-name {
    flex-shrink: 0;
  }

  .recent-path {
    min-width: 0;
    overflow: hidden;
    color: var(--color-muted);
    font-size: var(--font-size-small);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gone .recent-name {
    color: var(--color-muted);
  }

  .not-found {
    flex-shrink: 0;
    margin-left: auto;
    color: var(--color-warning);
    font-size: var(--font-size-meta);
  }

  .remove {
    display: flex;
    padding: var(--space-6);
    border-radius: var(--radius-sm);
    color: var(--color-muted);
  }

  .remove:hover {
    color: var(--color-text);
  }

  .back {
    align-self: flex-start;
    color: var(--color-muted);
  }

  .back:hover {
    color: var(--color-text);
  }
</style>
