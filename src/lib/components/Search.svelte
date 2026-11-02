<script lang="ts">
  import { FilePlus, FileText, Lock, Search } from "@lucide/svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import type { SearchHit } from "../types";

  /** `palette`: the ⌘K overlay on the Mac. `page`: the Search tab on phones. */
  let { mode = "palette" }: { mode?: "palette" | "page" } = $props();

  let query = $state("");
  let hits = $state<SearchHit[]>([]);
  let selected = $state(0);
  let input: HTMLInputElement;
  let seq = 0;

  const recent = $derived(
    app.titles.slice(0, 8).map((t) => ({ path: t.path, title: t.title, snippet: "", encrypted: t.encrypted })),
  );
  const results = $derived(query.trim() ? hits : recent);
  const canCreate = $derived(
    query.trim().length > 0 && !hits.some((h) => h.title.toLowerCase() === query.trim().toLowerCase()),
  );
  const count = $derived(results.length + (canCreate ? 1 : 0));

  $effect(() => {
    const q = query;
    const mine = ++seq;
    selected = 0;
    if (!q.trim()) {
      hits = [];
      return;
    }
    const t = setTimeout(async () => {
      const found = await api.search(q).catch(() => []);
      if (mine === seq) hits = found;
    }, 90);
    return () => clearTimeout(t);
  });

  $effect(() => {
    if (mode === "palette") queueMicrotask(() => input?.focus());
  });

  async function choose(i: number) {
    if (i < results.length) return app.open(results[i].path);
    if (canCreate) {
      const path = await api.noteCreate(app.currentFolder(), query.trim());
      await app.refreshFiles();
      app.open(path);
      app.edited();
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = (selected + 1) % Math.max(count, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = (selected - 1 + count) % Math.max(count, 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void choose(selected);
    } else if (e.key === "Escape" && mode === "palette") {
      app.switcherOpen = false;
    }
  }
</script>

<div class="search {mode}">
  <div class="input-row">
    <Search size={18} />
    <input
      bind:this={input}
      bind:value={query}
      onkeydown={onKey}
      placeholder="Search or create a note"
      aria-label="Search notes"
      role="combobox"
      aria-expanded="true"
      aria-controls="search-results"
      aria-activedescendant={count ? `hit-${selected}` : undefined}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      type="search"
    />
  </div>
  <ul id="search-results" role="listbox" aria-label={query.trim() ? "Results" : "Recent notes"}>
    {#if !query.trim() && recent.length}
      <li class="heading" role="presentation">Recent</li>
    {/if}
    {#each results as hit, i (hit.path)}
      <li
        id={`hit-${i}`}
        role="option"
        aria-selected={i === selected}
        class:selected={i === selected}
        onclick={() => choose(i)}
        onkeydown={() => {}}
        onpointerenter={() => (selected = i)}
      >
        {#if hit.encrypted}<Lock size={15} />{:else}<FileText size={15} />{/if}
        <span class="text">
          <span class="title">{hit.title}</span>
          {#if hit.snippet}<span class="snippet">{hit.snippet}</span>{/if}
          {#if hit.path.includes("/")}<span class="folder">{hit.path.slice(0, hit.path.lastIndexOf("/"))}</span>{/if}
        </span>
      </li>
    {/each}
    {#if canCreate}
      <li
        id={`hit-${results.length}`}
        role="option"
        aria-selected={selected === results.length}
        class:selected={selected === results.length}
        onclick={() => choose(results.length)}
        onkeydown={() => {}}
        onpointerenter={() => (selected = results.length)}
      >
        <FilePlus size={15} />
        <span class="text"><span class="title">Create “{query.trim()}”</span></span>
      </li>
    {/if}
    {#if query.trim() && !results.length && !canCreate}
      <li class="none" role="presentation">No notes match.</li>
    {/if}
  </ul>
</div>

<style>
  .search {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    border-bottom: 1px solid var(--rule);
    color: var(--graphite);
  }
  input {
    flex: 1;
    min-height: 54px;
    border: 0;
    background: none;
    font-size: 1.05rem;
    color: var(--ink);
  }
  input:focus {
    outline: none;
  }
  input::-webkit-search-cancel-button {
    display: none;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
  }
  .palette ul {
    max-height: min(420px, 60vh);
  }
  .page ul {
    flex: 1;
  }
  li[role="option"] {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 9px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--graphite);
  }
  li[role="option"] :global(svg) {
    margin-top: 3px;
    flex: none;
  }
  li.selected {
    background: var(--papyrus-wash);
  }
  .text {
    min-width: 0;
    display: grid;
  }
  .title {
    color: var(--ink);
    font-weight: 500;
  }
  .snippet,
  .folder {
    font-size: var(--small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .heading {
    padding: 6px 10px 2px;
    font-size: var(--small);
    color: var(--graphite);
  }
  .none {
    padding: 14px 10px;
    color: var(--graphite);
  }
  @media (pointer: coarse) {
    li[role="option"] {
      min-height: var(--target);
    }
  }
</style>
