<script lang="ts">
  import type { Toast } from "./appState.svelte";

  interface Props {
    toasts: readonly Toast[];
    ondismiss: (id: number) => void;
    /** How long a toast stays, in milliseconds. */
    duration?: number;
  }

  let { toasts, ondismiss, duration = 8_000 }: Props = $props();

  /** Dismisses a toast after `duration`, unless it is removed first. */
  function dismissLater(id: number) {
    return () => {
      const timer = setTimeout(() => ondismiss(id), duration);
      return () => clearTimeout(timer);
    };
  }
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts as toast (toast.id)}
    <div class="toast" {@attach dismissLater(toast.id)}>
      <span class="message">{toast.message}</span>
      <button type="button" class="dismiss" onclick={() => ondismiss(toast.id)}>
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

  .dismiss {
    flex-shrink: 0;
    padding: 0 var(--space-4);
    color: var(--color-muted);
    border-radius: var(--radius-sm);
  }

  .dismiss:hover {
    color: var(--color-text);
  }

  .dismiss:focus-visible {
    outline-offset: 0;
  }
</style>
