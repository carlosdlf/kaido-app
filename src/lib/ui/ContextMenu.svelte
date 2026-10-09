<script lang="ts" module>
  export interface MenuItem {
    id: string;
    label: string;
    /** Shortcut that runs the same action, for assistive technology and as a visible hint. */
    shortcut?: { aria: string; hint: string };
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";

  interface Props {
    /** Accessible name of the menu. */
    label: string;
    /** Where the menu opens, in viewport pixels. */
    x: number;
    y: number;
    items: readonly MenuItem[];
    onselect: (id: string) => void;
    /** `returnFocus` is false when focus already moved elsewhere, e.g. after a click outside. */
    onclose: (returnFocus: boolean) => void;
  }

  let { label, x, y, items, onselect, onclose }: Props = $props();

  let menu: HTMLElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);

  function buttons(): HTMLButtonElement[] {
    return menu ? [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")] : [];
  }

  onMount(() => {
    left = x;
    top = y;
    // Keep the menu inside the window.
    if (menu) {
      const rect = menu.getBoundingClientRect();
      left = Math.max(0, Math.min(x, window.innerWidth - rect.width));
      top = Math.max(0, Math.min(y, window.innerHeight - rect.height));
    }
    buttons()[0]?.focus();

    const outside = (event: Event) => {
      if (menu && event.target instanceof Node && menu.contains(event.target)) return;
      onclose(event.type === "scroll" || event.type === "resize");
    };
    const blur = () => onclose(false);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", outside, true);
    window.addEventListener("resize", outside);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", outside);
      window.removeEventListener("blur", blur);
    };
  });

  function handleKeydown(event: KeyboardEvent) {
    const all = buttons();
    const current = all.findIndex((button) => button === document.activeElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = (current + 1) % all.length;
        break;
      case "ArrowUp":
        next = (current - 1 + all.length) % all.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = all.length - 1;
        break;
      case "Escape":
      case "Tab":
        event.preventDefault();
        event.stopPropagation();
        onclose(true);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    all[next]?.focus();
  }
</script>

<div
  class="menu"
  role="menu"
  tabindex="-1"
  aria-label={label}
  bind:this={menu}
  style:left="{left}px"
  style:top="{top}px"
  onkeydown={handleKeydown}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#each items as item (item.id)}
    <button
      type="button"
      role="menuitem"
      tabindex="-1"
      class="item"
      aria-keyshortcuts={item.shortcut?.aria}
      onclick={() => onselect(item.id)}
    >
      <span class="label">{item.label}</span>
      {#if item.shortcut}
        <kbd aria-hidden="true">{item.shortcut.hint}</kbd>
      {/if}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: calc(var(--space-80) * 2);
    padding: var(--space-4);
    background: var(--color-panel);
    border: var(--space-1) solid var(--color-border-strong);
    border-radius: var(--radius-lg);
    font-size: var(--font-size-small);
  }

  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-16);
    padding: var(--space-6) var(--space-10);
    border-radius: var(--radius-sm);
    color: var(--color-text);
  }

  .item:hover,
  .item:focus-visible {
    background: var(--color-selected);
  }

  .item:focus-visible {
    outline-offset: 0;
  }

  kbd {
    font-family: inherit;
    font-size: var(--font-size-meta);
    color: var(--color-muted);
  }
</style>
