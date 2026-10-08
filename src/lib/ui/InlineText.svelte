<script lang="ts">
  import { parseInline } from "$lib/core/blocks";

  let { text }: { text: string } = $props();
</script>

{#each parseInline(text) as inline, index (index)}
  {#if inline.kind === "code"}<code>{inline.text}</code>{:else if inline.kind === "tag"}<span
      class="tag">{inline.text}</span
    >{:else}{inline.text}{/if}
{/each}

<style>
  code {
    color: var(--color-accent);
    font-size: var(--font-size-ui);
  }

  .tag {
    color: var(--color-accent);
  }
</style>
