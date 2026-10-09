<script lang="ts">
  import { untrack } from "svelte";
  import type { Toast } from "./appState.svelte";

  interface Props {
    toasts: readonly Toast[];
    ondismiss: (id: number) => void;
    /** Runs a toast's action, e.g. undo. `Ctrl+Z` / `Cmd+Z` in a focused toast does the same. */
    onaction?: (id: number) => void;
    /** Focus was inside a toast that went away; the caller decides where it goes. */
    onfocusexit?: () => void;
    /** How long a toast stays, in milliseconds. */
    duration?: number;
  }

  let { toasts, ondismiss, onaction, onfocusexit, duration = 8_000 }: Props = $props();

  let container: HTMLElement | undefined = $state();

  /**
   * Dismisses a toast after `duration`. The time starts over while the
   * pointer or focus is on the toast, so it never disappears while in use.
   */
  function dismissLater(id: number) {
    return (node: HTMLElement) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let hovered = false;
      let focused = false;
      const stop = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      };
      const update = () => {
        stop();
        if (!hovered && !focused) timer = setTimeout(() => ondismiss(id), duration);
      };
      const enter = () => {
        hovered = true;
        update();
      };
      const leave = () => {
        hovered = false;
        update();
      };
      const focusin = () => {
        focused = true;
        update();
      };
      const focusout = (event: FocusEvent) => {
        if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
        focused = false;
        update();
      };
      node.addEventListener("pointerenter", enter);
      node.addEventListener("pointerleave", leave);
      node.addEventListener("focusin", focusin);
      node.addEventListener("focusout", focusout);
      update();
      return () => {
        stop();
        node.removeEventListener("pointerenter", enter);
        node.removeEventListener("pointerleave", leave);
        node.removeEventListener("focusin", focusin);
        node.removeEventListener("focusout", focusout);
      };
    };
  }

  function handleKeydown(event: KeyboardEvent, toast: Toast) {
    const undo = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
    if (!undo || event.key.toLowerCase() !== "z" || toast.action === undefined) return;
    event.preventDefault();
    onaction?.(toast.id);
  }

  // When the focused toast goes away, move focus to another toast or hand it back.
  let focusWasInside = false;
  $effect.pre(() => {
    void toasts;
    focusWasInside = container?.contains(document.activeElement) ?? false;
  });
  $effect(() => {
    void toasts;
    if (!focusWasInside || !container || container.contains(document.activeElement)) return;
    const next = container.querySelector<HTMLButtonElement>("button");
    if (next) next.focus();
    else untrack(() => onfocusexit?.());
  });
</script>

<div class="toasts" role="region" aria-label="Notifications" bind:this={container}>
  <!-- Only the messages are announced; the buttons are not read out again. -->
  <div class="visually-hidden" role="status">
    {#each toasts as toast (toast.id)}
      <p>{toast.message}</p>
    {/each}
  </div>
  {#each toasts as toast (toast.id)}
    <!-- Keys bubble here from the toast's buttons. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="toast"
      {@attach dismissLater(toast.id)}
      onkeydown={(event) => handleKeydown(event, toast)}
    >
      <span class="message" id="toast-message-{toast.id}" aria-hidden="true">{toast.message}</span>
      {#if toast.action !== undefined}
        <button
          type="button"
          class="action"
          aria-describedby="toast-message-{toast.id}"
          aria-keyshortcuts="Control+Z Meta+Z"
          onclick={() => onaction?.(toast.id)}>{toast.action}</button
        >
      {/if}
      <button
        type="button"
        class="dismiss"
        aria-describedby="toast-message-{toast.id}"
        onclick={() => ondismiss(toast.id)}
      >
        <span aria-hidden="true">×</span>
        <span class="visually-hidden">Dismiss</span>
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: var(--space-24);
    bottom: var(--space-24);
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: var(--space-8);
    max-width: var(--note-max-width);
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: flex-start;
    gap: var(--space-12);
    padding: var(--space-10) var(--space-14);
    background: var(--color-conflict-bg);
    border: var(--space-1) solid var(--color-conflict-border);
    border-radius: var(--radius-lg);
    color: var(--color-text);
    font-size: var(--font-size-small);
    pointer-events: auto;
  }

  .message {
    flex: 1;
  }

  .action {
    flex-shrink: 0;
    padding: 0 var(--space-4);
    color: var(--color-accent);
    font-weight: var(--font-weight-bold);
    border-radius: var(--radius-sm);
  }

  .action:hover {
    color: var(--color-accent-hover);
  }

  .dismiss {
    flex-shrink: 0;
    padding: 0 var(--space-4);
    color: var(--color-muted);
    border-radius: var(--radius-sm);
  }

  .dismiss:hover {
    color: var(--color-text);
  }

  .action:focus-visible,
  .dismiss:focus-visible {
    outline-offset: 0;
  }
</style>
