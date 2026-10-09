<script lang="ts" module>
  export type ViewMode = "list" | "text";
</script>

<script lang="ts">
  import Code from "@lucide/svelte/icons/code";
  import List from "@lucide/svelte/icons/list";

  interface Props {
    mode: ViewMode;
    onchange: (mode: ViewMode) => void;
    /** The shortcut that toggles the mode, for assistive technology and as a hint. */
    shortcut: { aria: string; hint: string };
  }

  let { mode, onchange, shortcut }: Props = $props();

  const OPTIONS: readonly { mode: ViewMode; label: string }[] = [
    { mode: "list", label: "list" },
    { mode: "text", label: "text" },
  ];

  function choose(next: ViewMode) {
    if (next !== mode) onchange(next);
  }

  /** Arrow keys move the selection (and focus) like any radio group; Enter and Space select. */
  function handleKeydown(event: KeyboardEvent, option: ViewMode) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      choose("list");
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      choose("text");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(option);
    }
  }
</script>

<div
  class="switch"
  role="radiogroup"
  aria-label="View as"
  aria-keyshortcuts={shortcut.aria}
  title="View as list or text ({shortcut.hint})"
  data-view-switch
>
  {#each OPTIONS as option (option.mode)}
    <button
      type="button"
      role="radio"
      class="option"
      aria-checked={option.mode === mode ? "true" : "false"}
      tabindex={option.mode === mode ? 0 : -1}
      onclick={() => choose(option.mode)}
      onkeydown={(event) => handleKeydown(event, option.mode)}
    >
      {#if option.mode === "list"}<List aria-hidden="true" />{:else}<Code aria-hidden="true" />{/if}
      {option.label}
    </button>
  {/each}
</div>

<style>
  .switch {
    display: flex;
    flex-shrink: 0;
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-sm);
  }

  .option {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-1) var(--space-8);
    color: var(--color-muted);
  }

  .option + .option {
    border-left: var(--space-1) solid var(--color-border-strong);
  }

  .option:hover {
    color: var(--color-text);
  }

  .option[aria-checked="true"] {
    background: var(--color-selected);
    color: var(--color-accent);
  }
</style>
