<script lang="ts">
  interface Props {
    /** Adds the missing lines. */
    onsetup: () => Promise<void>;
    /** Hides the banner for this workspace for good. */
    ondismiss: () => void;
    /**
     * The banner went away with focus inside and focus had nowhere better to
     * go; the caller moves it to a sensible place.
     */
    onfocusexit?: () => void;
  }

  let { onsetup, ondismiss, onfocusexit }: Props = $props();

  const uid = $props.id();
  let working = $state(false);
  let banner: HTMLElement | undefined = $state();
  /** Focus is inside the banner. */
  let hasFocus = false;
  /** Where focus came from when it entered the banner. */
  let cameFrom: HTMLElement | null = null;

  function handleFocusIn(event: FocusEvent) {
    if (!hasFocus) {
      const from = event.relatedTarget;
      cameFrom = from instanceof HTMLElement && !banner?.contains(from) ? from : null;
    }
    hasFocus = true;
  }

  function handleFocusOut(event: FocusEvent) {
    // Without a target, focus is being lost (the banner may be going away):
    // keep the mark so it can be given back.
    const to = event.relatedTarget;
    if (to instanceof Node && !banner?.contains(to)) hasFocus = false;
  }

  // Once the banner goes away (after Set up or Not now), focus would fall to
  // the page; give it back to where it came from, or to the caller.
  $effect(() => {
    const element = banner;
    return () => {
      if (!hasFocus || !element) return;
      const active = document.activeElement;
      const lost = active === null || active === document.body || element.contains(active);
      if (!lost) return;
      if (cameFrom?.isConnected) cameFrom.focus();
      else onfocusexit?.();
    };
  });

  async function setUp() {
    if (working) return;
    working = true;
    try {
      await onsetup();
    } finally {
      working = false;
    }
  }
</script>

<div
  class="setup"
  role="group"
  aria-labelledby="{uid}-title"
  aria-describedby="{uid}-text"
  bind:this={banner}
  onfocusin={handleFocusIn}
  onfocusout={handleFocusOut}
>
  <p>
    <strong id="{uid}-title">Set up this folder for Kaido?</strong>
    <span id="{uid}-text"
      >Adds <code>.gitattributes</code> and <code>.gitignore</code> lines so task lists merge cleanly.</span
    >
  </p>
  <div class="actions">
    <!-- aria-disabled keeps a focused button focusable while setting up. -->
    <button type="button" class="primary" aria-disabled={working} onclick={() => void setUp()}
      >Set up</button
    >
    <button
      type="button"
      class="secondary"
      aria-disabled={working}
      onclick={() => {
        if (!working) ondismiss();
      }}>Not now</button
    >
  </div>
</div>

<style>
  .setup {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-8) var(--space-16);
    padding: var(--space-8) var(--space-16);
    background: var(--color-conflict-bg);
    border-bottom: var(--space-1) solid var(--color-conflict-border);
  }

  p {
    flex: 1;
    min-width: 0;
    color: var(--color-text);
  }

  strong {
    margin-right: var(--space-6);
    font-weight: var(--font-weight-semibold);
  }

  span {
    color: var(--color-muted);
  }

  code {
    color: var(--color-text);
  }

  .actions {
    display: flex;
    gap: var(--space-8);
  }

  .primary,
  .secondary {
    padding: var(--space-4) var(--space-10);
    border-radius: var(--radius-md);
  }

  .primary {
    background: var(--color-accent);
    color: var(--color-on-accent);
    font-weight: var(--font-weight-bold);
  }

  .primary:hover:not([aria-disabled="true"]) {
    background: var(--color-accent-hover);
  }

  .secondary {
    border: var(--space-1) solid var(--color-border-strong);
  }

  .secondary:hover:not([aria-disabled="true"]) {
    border-color: var(--color-dim);
  }

  button[aria-disabled="true"] {
    cursor: default;
    opacity: 0.6;
  }

  .primary:focus-visible,
  .secondary:focus-visible {
    outline-offset: var(--space-2);
  }
</style>
