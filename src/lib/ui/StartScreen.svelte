<script lang="ts">
  interface Props {
    title: string;
    message: string;
    /** Shown as an alert, e.g. when the last workspace could not be opened. */
    error?: boolean;
    /** Hides the button while a folder is being opened. */
    busy?: boolean;
    onpick: () => void;
  }

  let { title, message, error = false, busy = false, onpick }: Props = $props();
</script>

<main class="start" aria-labelledby="start-title" aria-busy={busy}>
  <div class="panel">
    <div class="brand"><span class="prompt" aria-hidden="true">❯</span>kaido</div>
    <h1 id="start-title">{title}</h1>
    <p class="message" class:error role={error ? "alert" : undefined}>{message}</p>
    {#if !busy}
      <!-- svelte-ignore a11y_autofocus -->
      <button type="button" class="primary" onclick={onpick} autofocus>Open folder…</button>
    {/if}
  </div>
</main>

<style>
  .start {
    display: grid;
    place-items: center;
    height: 100%;
    padding: var(--space-24);
    background: var(--color-bg);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-16);
    max-width: var(--note-max-width);
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
    font-size: var(--font-size-note-h2);
    font-weight: var(--font-weight-semibold);
  }

  .message {
    color: var(--color-muted);
    overflow-wrap: anywhere;
  }

  .message.error {
    color: var(--color-danger);
  }

  .primary {
    align-self: flex-start;
    padding: var(--space-8) var(--space-16);
    background: var(--color-accent);
    border-radius: var(--radius-md);
    color: var(--color-on-accent);
    font-weight: var(--font-weight-bold);
  }

  .primary:hover {
    background: var(--color-accent-hover);
  }

  .primary:focus-visible {
    outline-offset: var(--space-2);
  }
</style>
