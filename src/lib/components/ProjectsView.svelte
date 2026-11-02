<script lang="ts">
  import { Columns3, FileText, Hash, Plus } from "@lucide/svelte";
  import { app } from "../app.svelte";

  const boards = $derived(app.titles.filter((n) => n.board));
  const tags = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const n of app.titles) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  });
  const tagged = $derived(app.tagFilter ? app.titles.filter((n) => n.tags.includes(app.tagFilter!)) : []);
  const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
</script>

<section class="projects" aria-labelledby="projects-title">
  <header>
    <h2 id="projects-title">Projects</h2>
    <button class="btn primary" onclick={() => app.newBoard()}><Plus size={16} /> New board</button>
  </header>

  <section aria-labelledby="boards-h">
    <h3 id="boards-h">Boards</h3>
    {#if boards.length}
      <ul class="list">
        {#each boards as b (b.path)}
          <li>
            <button onclick={() => app.open(b.path)}>
              <Columns3 size={16} />
              <span class="name">{b.title}</span>
              {#if folderOf(b.path)}<span class="meta">{folderOf(b.path)}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">A board is a note with columns of cards. Link cards to notes with [[ ]] and group them with #tags.</p>
    {/if}
  </section>

  <section aria-labelledby="tags-h">
    <h3 id="tags-h">Tags</h3>
    {#if tags.length}
      <div class="chips" role="toolbar" aria-label="Tags">
        {#each tags as [tag, count] (tag)}
          <button
            class="chip"
            class:on={app.tagFilter === tag}
            aria-pressed={app.tagFilter === tag}
            onclick={() => (app.tagFilter = app.tagFilter === tag ? null : tag)}
          >
            #{tag} <span class="count">{count}</span>
          </button>
        {/each}
      </div>
      {#if app.tagFilter}
        <ul class="list tagged" aria-label={`Notes tagged ${app.tagFilter}`}>
          {#each tagged as n (n.path)}
            <li>
              <button onclick={() => app.open(n.path)}>
                {#if n.board}<Columns3 size={16} />{:else}<FileText size={16} />{/if}
                <span class="name">{n.title}</span>
                {#if folderOf(n.path)}<span class="meta">{folderOf(n.path)}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      <p class="muted"><Hash size={14} /> Write #tag in a note or on a card and it appears here.</p>
    {/if}
  </section>
</section>

<style>
  .projects {
    display: grid;
    gap: 26px;
    padding: 20px 20px calc(32px + var(--safe-bottom));
    max-width: 72ch;
    align-content: start;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: var(--view-title-size);
    font-weight: var(--view-title-weight);
    letter-spacing: var(--view-title-tracking);
  }
  h3 {
    margin: 0 0 8px;
    font-size: 1rem;
    font-weight: 600;
  }
  p {
    margin: 0;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 40px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--graphite);
    text-align: left;
  }
  .list button:hover {
    background: var(--papyrus-wash);
  }
  .name {
    color: var(--ink);
    font-weight: 500;
  }
  .meta {
    margin-left: auto;
    font-size: var(--small);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--rule);
    border-radius: 999px;
    background: var(--sheet);
    color: var(--ink);
    font-size: var(--small);
  }
  .chip.on {
    border-color: var(--papyrus);
    background: var(--papyrus);
    color: var(--on-papyrus);
  }
  .count {
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
  .tagged {
    margin-top: 12px;
  }
  @media (pointer: coarse) {
    .list button,
    .chip {
      min-height: var(--target);
    }
  }
</style>
