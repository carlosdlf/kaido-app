<script lang="ts">
  import EditorPane from "./EditorPane.svelte";
  import { inbox, initialSelection, projects, sync } from "./fixtures";
  import ListPane from "./ListPane.svelte";
  import Sidebar from "./Sidebar.svelte";
  import { listItems, listSummary, listTitle, openDocument } from "./workspace";

  let folder: string = $state(initialSelection.folder);
  let item: string = $state(initialSelection.item);

  const items = $derived(listItems(folder));
  const doc = $derived(openDocument(item));

  function selectFolder(id: string) {
    if (id === folder) return;
    folder = id;
    item = listItems(id)[0]?.id ?? "";
  }
</script>

<div class="shell">
  <Sidebar {inbox} {projects} {sync} selected={folder} onselect={selectFolder} />
  <ListPane
    title={listTitle(folder)}
    summary={listSummary(folder)}
    {items}
    selected={item}
    onselect={(id) => (item = id)}
  />
  <EditorPane {doc} />
</div>

<style>
  .shell {
    display: grid;
    grid-template-columns:
      minmax(200px, var(--sidebar-width))
      minmax(220px, var(--list-width))
      minmax(0, 1fr);
    height: 100%;
    overflow: hidden;
  }
</style>
