<script lang="ts">
  import { onMount, type Snippet } from "svelte";

  interface Props {
    title: string;
    /** The question, with emphasis where needed. */
    children: Snippet;
    /** Label of the button that goes ahead, e.g. `Delete`. */
    confirmLabel: string;
    /** The action cannot be taken back from the app. */
    danger?: boolean;
    onconfirm: () => void;
    /** The dialog should go away without acting; focus was already given back. */
    oncancel: () => void;
    /** Where focus goes when the dialog closes; by default what had focus when it opened. */
    returnFocus?: HTMLElement | null;
  }

  let {
    title,
    children,
    confirmLabel,
    danger = false,
    onconfirm,
    oncancel,
    returnFocus,
  }: Props = $props();

  const uid = $props.id();
  let dialog: HTMLElement | undefined = $state();
  let cancelButton: HTMLButtonElement | undefined = $state();
  let previous: HTMLElement | null = null;

  onMount(() => {
    previous =
      returnFocus !== undefined
        ? returnFocus
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    // The safe choice has focus, so Enter right away changes nothing.
    cancelButton?.focus();
  });

  function giveBack() {
    if (previous?.isConnected) previous.focus();
  }

  function cancel() {
    giveBack();
    oncancel();
  }

  function confirm() {
    giveBack();
    onconfirm();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key !== "Tab" || !dialog) return;
    // Focus stays in the dialog.
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<!-- Clicking outside the dialog cancels; the keyboard uses Escape. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="backdrop"
  onmousedown={(event) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    cancel();
  }}
>
  <div
    class="dialog"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="{uid}-title"
    aria-describedby="{uid}-message"
    tabindex="-1"
    bind:this={dialog}
    onkeydown={handleKeydown}
  >
    <h1 id="{uid}-title">{title}</h1>
    <p id="{uid}-message" class="message">{@render children()}</p>
    <div class="actions">
      <button type="button" class="secondary" bind:this={cancelButton} onclick={cancel}
        >Cancel</button
      >
      <button type="button" class="confirm" class:danger onclick={confirm}>{confirmLabel}</button>
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
    gap: var(--space-12);
    width: min(var(--picker-width), calc(100% - var(--space-48)));
    padding: var(--space-16);
    background: var(--color-surface-raised);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-lg);
  }

  .dialog:focus {
    outline: none;
  }

  h1 {
    color: var(--color-heading);
    font-size: var(--font-size-ui);
    font-weight: var(--font-weight-semibold);
  }

  .message {
    color: var(--color-text);
    overflow-wrap: anywhere;
  }

  .message :global(strong) {
    color: var(--color-heading);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-8);
  }

  .secondary,
  .confirm {
    padding: var(--space-6) var(--space-14);
    border-radius: var(--radius-md);
  }

  .secondary {
    border: var(--space-1) solid var(--color-border-strong);
  }

  .secondary:hover {
    border-color: var(--color-dim);
  }

  .confirm {
    background: var(--color-accent);
    color: var(--color-on-accent);
    font-weight: var(--font-weight-bold);
  }

  .confirm:hover {
    background: var(--color-accent-hover);
  }

  .confirm.danger {
    background: var(--color-danger);
    color: var(--color-on-danger);
  }

  .confirm.danger:hover {
    filter: brightness(1.1);
  }

  .secondary:focus-visible,
  .confirm:focus-visible {
    outline-offset: var(--space-2);
  }
</style>
