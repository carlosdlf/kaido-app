<script lang="ts">
  import { onDestroy } from "svelte";
  import { createStorage } from "$lib/storage";
  import { AppState } from "$lib/ui/appState.svelte";
  import AppShell from "$lib/ui/AppShell.svelte";

  const app = new AppState(createStorage());
  void app.start();
  onDestroy(() => app.dispose());
</script>

<AppShell {app} />
