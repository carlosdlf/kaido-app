<script lang="ts">
  import { onMount, tick } from "svelte";
  import Minus from "@lucide/svelte/icons/minus";
  import Plus from "@lucide/svelte/icons/plus";
  import X from "@lucide/svelte/icons/x";
  import { acceleratorKeys, recordShortcut } from "$lib/core/accelerator";
  import { isSettingsShortcut } from "$lib/core/shortcuts";
  import { isMac } from "./platform";

  interface Props {
    /** The open workspace's folder, or `null`. */
    workspace: string | null;
    /** Setup files the workspace lacks lines in, or `null` while unknown. */
    setupMissing: readonly string[] | null;
    fontSize: number;
    fontMin: number;
    fontMax: number;
    autoSync: boolean;
    /** The configured capture shortcut; `null` when turned off. */
    shortcut: string | null;
    /** The shortcut is configured but could not be registered. */
    shortcutUnavailable?: boolean;
    /** Quick capture can be configured in this build. */
    captureAvailable: boolean;
    version: string;
    onswitch: () => void;
    onsetup: () => Promise<void>;
    onfontsize: (size: number) => void;
    onautosync: (on: boolean) => void;
    /** Changes the shortcut; resolves to why it failed, or `null`. */
    onshortcut: (accelerator: string | null) => Promise<string | null>;
    oncopy?: (text: string) => void;
    /** The dialog should go away; focus was already given back. */
    onclose: () => void;
    /** Where focus goes on close; by default what had focus when the dialog opened. */
    returnFocus?: HTMLElement | null;
  }

  let {
    workspace,
    setupMissing,
    fontSize,
    fontMin,
    fontMax,
    autoSync,
    shortcut,
    shortcutUnavailable = false,
    captureAvailable,
    version,
    onswitch,
    onsetup,
    onfontsize,
    onautosync,
    onshortcut,
    oncopy,
    onclose,
    returnFocus,
  }: Props = $props();

  const REPOSITORY_URL = "https://github.com/carlosdlf/kaido-app";

  const uid = $props.id();
  const mac = isMac();

  let dialog: HTMLElement | undefined = $state();
  let recorder: HTMLButtonElement | undefined = $state();
  /** Where focus was before the dialog opened. */
  let previous: HTMLElement | null = null;
  let settingUp = $state(false);
  let recording = $state(false);
  let savingShortcut = $state(false);
  let shortcutError: string | null = $state(null);

  const nothingToSetUp = $derived(setupMissing === null || setupMissing.length === 0);
  // Buttons that cannot act right now use `aria-disabled` and stay focusable:
  // a focused button that became `disabled` would drop focus out of the
  // dialog, and Escape would no longer reach it.
  const setUpUnavailable = $derived(nothingToSetUp || settingUp);
  const smallerUnavailable = $derived(fontSize <= fontMin);
  const largerUnavailable = $derived(fontSize >= fontMax);
  const keys = $derived(shortcut === null ? [] : acceleratorKeys(shortcut, mac));

  onMount(() => {
    previous =
      returnFocus !== undefined
        ? returnFocus
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    focusables()[0]?.focus();
  });

  function focusables(): HTMLElement[] {
    if (!dialog) return [];
    return [...dialog.querySelectorAll<HTMLElement>("button, input, [tabindex='0']")];
  }

  function close() {
    if (previous?.isConnected) previous.focus();
    onclose();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing || recording) return;
    if (event.key === "Escape" || isSettingsShortcut(event, mac)) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    // Focus stays in the dialog.
    const items = focusables();
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function setUp() {
    if (setUpUnavailable) return;
    settingUp = true;
    try {
      await onsetup();
    } finally {
      settingUp = false;
    }
  }

  function step(delta: number) {
    onfontsize(Math.min(fontMax, Math.max(fontMin, fontSize + delta)));
  }

  function handleFontInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const value = Number(input.value);
    if (input.value !== "" && Number.isFinite(value)) onfontsize(value);
  }

  function startRecording() {
    if (savingShortcut) return;
    shortcutError = null;
    recording = true;
  }

  async function stopRecording() {
    recording = false;
    await tick();
    recorder?.focus();
  }

  async function apply(accelerator: string | null) {
    savingShortcut = true;
    recording = false;
    try {
      shortcutError = await onshortcut(accelerator);
    } finally {
      savingShortcut = false;
    }
    await tick();
    recorder?.focus();
  }

  function handleRecorderKeydown(event: KeyboardEvent) {
    if (!recording || event.isComposing) return;
    // Plain Tab still moves focus, which ends recording.
    const plainTab = event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (plainTab) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    const recorded = recordShortcut(event, mac);
    if (recorded.kind === "cancel") void stopRecording();
    else if (recorded.kind === "disable") void apply(null);
    else if (recorded.kind === "shortcut") void apply(recorded.accelerator);
  }
</script>

<!-- Clicking outside the dialog closes it; the keyboard uses Escape. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="backdrop"
  onmousedown={(event) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    close();
  }}
>
  <div
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="{uid}-title"
    tabindex="-1"
    bind:this={dialog}
    onkeydown={handleKeydown}
  >
    <header class="header">
      <h1 id="{uid}-title">Settings</h1>
      <button type="button" class="icon-button" aria-label="Close settings" onclick={close}>
        <X aria-hidden="true" />
      </button>
    </header>

    <div class="body">
      <section aria-labelledby="{uid}-workspace">
        <h2 id="{uid}-workspace">Workspace</h2>
        {#if workspace}
          <p class="value path" title={workspace}>{workspace}</p>
          <div class="row">
            <button type="button" class="secondary" onclick={onswitch}>Switch…</button>
            <button
              type="button"
              class="secondary"
              aria-disabled={setUpUnavailable}
              aria-describedby="{uid}-setup-hint"
              onclick={() => void setUp()}>Set up git files</button
            >
          </div>
          <p class="hint" id="{uid}-setup-hint">
            {#if setupMissing === null}
              Checking the git setup files…
            {:else if setupMissing.length === 0}
              .gitattributes and .gitignore are set up.
            {:else}
              Adds lines to {setupMissing.join(" and ")} so task lists merge cleanly.
            {/if}
          </p>
        {:else}
          <p class="hint">No workspace is open.</p>
        {/if}
      </section>

      <section aria-labelledby="{uid}-editor">
        <h2 id="{uid}-editor">Editor</h2>
        <div class="row">
          <label for="{uid}-font">Font size</label>
          <div class="stepper">
            <button
              type="button"
              class="icon-button"
              aria-label="Smaller text"
              aria-disabled={smallerUnavailable}
              onclick={() => {
                if (!smallerUnavailable) step(-1);
              }}
            >
              <Minus aria-hidden="true" />
            </button>
            <input
              id="{uid}-font"
              type="number"
              min={fontMin}
              max={fontMax}
              step="1"
              value={fontSize}
              aria-describedby="{uid}-font-hint"
              onchange={handleFontInput}
            />
            <button
              type="button"
              class="icon-button"
              aria-label="Larger text"
              aria-disabled={largerUnavailable}
              onclick={() => {
                if (!largerUnavailable) step(1);
              }}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
        </div>
        <p class="hint" id="{uid}-font-hint">
          Notes and task lists, {fontMin}–{fontMax} px.
        </p>
      </section>

      <section aria-labelledby="{uid}-sync">
        <h2 id="{uid}-sync">Sync</h2>
        <label class="row toggle">
          <input
            type="checkbox"
            role="switch"
            checked={autoSync}
            aria-describedby="{uid}-sync-hint"
            onchange={(event) => onautosync(event.currentTarget.checked)}
          />
          <span>Auto-sync</span>
        </label>
        <p class="hint" id="{uid}-sync-hint">
          Commits and syncs with git in the background. When off, Sync now commits and syncs once.
        </p>
      </section>

      <section aria-labelledby="{uid}-capture">
        <h2 id="{uid}-capture">Quick capture</h2>
        {#if captureAvailable}
          <div class="row">
            <span class="keys" id="{uid}-keys">
              {#if recording}
                <span class="recording">Press a shortcut…</span>
              {:else if keys.length === 0}
                <span class="muted">Off</span>
              {:else}
                {#each keys as key, index (index)}<kbd>{key}</kbd>{/each}
              {/if}
            </span>
            <button
              type="button"
              class="secondary"
              bind:this={recorder}
              aria-pressed={recording}
              aria-describedby="{uid}-keys {uid}-capture-hint"
              aria-disabled={savingShortcut}
              onclick={() => (recording ? void stopRecording() : startRecording())}
              onkeydown={handleRecorderKeydown}
              onblur={() => (recording = false)}
            >
              {recording ? "Recording" : "Change"}
            </button>
          </div>
          <p class="hint" id="{uid}-capture-hint">
            {#if recording}
              Hold a modifier and press a key. Esc cancels, Backspace turns the shortcut off.
            {:else}
              Opens quick capture from any app.
            {/if}
          </p>
          {#if shortcutError}
            <p class="error" role="alert">{shortcutError}</p>
          {:else if shortcutUnavailable && !recording}
            <p class="error">That shortcut is in use by another app</p>
          {/if}
        {:else}
          <p class="hint">Quick capture is only available in the desktop app.</p>
        {/if}
      </section>

      <section aria-labelledby="{uid}-about">
        <h2 id="{uid}-about">About</h2>
        <p class="value">Kaido {version}</p>
        <div class="row">
          <span class="muted">{REPOSITORY_URL.replace("https://", "")}</span>
          {#if oncopy}
            <button type="button" class="link" onclick={() => oncopy(REPOSITORY_URL)}
              >Copy link</button
            >
          {/if}
        </div>
        <p class="muted">MIT OR Apache-2.0</p>
      </section>
    </div>
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

  .dialog {
    display: flex;
    flex-direction: column;
    width: min(var(--dialog-width), calc(100% - var(--space-48)));
    max-height: var(--dialog-max-height);
    overflow: hidden;
    background: var(--color-surface-raised);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-lg);
  }

  .dialog:focus {
    outline: none;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-10) var(--space-14);
    border-bottom: var(--space-1) solid var(--color-border);
  }

  h1 {
    color: var(--color-heading);
    font-size: var(--font-size-ui);
    font-weight: var(--font-weight-semibold);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-20);
    padding: var(--space-16) var(--space-14) var(--space-20);
    overflow-y: auto;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
  }

  h2 {
    color: var(--color-muted);
    font-size: var(--font-size-meta);
    font-weight: var(--font-weight-regular);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-8) var(--space-12);
  }

  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint,
  .muted {
    color: var(--color-muted);
  }

  .hint {
    font-size: var(--font-size-small);
  }

  .error {
    color: var(--color-danger);
    font-size: var(--font-size-small);
  }

  .secondary {
    padding: var(--space-4) var(--space-10);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-md);
  }

  .secondary:hover:not([aria-disabled="true"]) {
    border-color: var(--color-dim);
  }

  .secondary[aria-pressed="true"] {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }

  button[aria-disabled="true"] {
    cursor: default;
    opacity: 0.6;
  }

  .icon-button {
    display: flex;
    padding: var(--space-4);
    border-radius: var(--radius-sm);
    color: var(--color-muted);
  }

  .icon-button:hover:not([aria-disabled="true"]) {
    color: var(--color-text);
  }

  .stepper {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .stepper input {
    width: calc(var(--space-48) + var(--space-8));
    padding: var(--space-4) var(--space-6);
    background: var(--color-bg);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    text-align: center;
  }

  .toggle {
    cursor: pointer;
  }

  .toggle input {
    width: var(--checkbox-size);
    height: var(--checkbox-size);
    margin: 0;
    accent-color: var(--color-accent);
  }

  .keys {
    display: flex;
    gap: var(--space-4);
    min-width: calc(var(--space-80) + var(--space-40));
  }

  kbd {
    padding: var(--space-1) var(--space-6);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
  }

  .recording {
    color: var(--color-accent);
  }

  .link {
    color: var(--color-accent);
  }

  .link:hover {
    color: var(--color-accent-hover);
  }
</style>
