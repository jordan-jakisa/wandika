<script lang="ts">
  import { ArrowLeft, FilePlus, FileText, Lock, Search, X } from "@lucide/svelte";
  import { isIOS } from "../platform";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import type { SearchHit } from "../types";

  /** `palette`: the ⌘K overlay on the Mac. `page`: the Search tab on phones. */
  /** `onExit`: the page's way out (back arrow on Android, Cancel on iOS). */
  let { mode = "palette", onExit }: { mode?: "palette" | "page"; onExit?: () => void } = $props();
  let focused = $state(false);

  let query = $state("");
  let hits = $state<SearchHit[]>([]);
  let failed = $state<string | null>(null);
  /** The query the shown results answer; "Create" waits for it, so it doesn't jump down. */
  let answered = $state("");
  let selected = $state(0);
  /** On phones nothing is highlighted until you type; the highlight is for keyboard selection. */
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const showSelection = $derived(!coarse || query.trim().length > 0);
  let input: HTMLInputElement;
  let seq = 0;

  const recent = $derived(
    app.titles.slice(0, 8).map((t) => ({ path: t.path, title: t.title, snippet: "", encrypted: t.encrypted })),
  );
  const results = $derived(query.trim() ? hits : recent);
  const canCreate = $derived(
    query.trim().length > 0 &&
      answered === query.trim() &&
      !hits.some((h) => h.title.toLowerCase() === query.trim().toLowerCase()),
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
      try {
        const found = await api.search(q);
        if (mine === seq) {
          hits = found;
          failed = null;
          answered = q.trim();
        }
      } catch (e) {
        if (mine === seq) failed = (e as Error).message;
      }
    }, 90);
    return () => clearTimeout(t);
  });

  $effect(() => {
    // The palette, and the Search tab on phones, are for typing: the field is ready.
    queueMicrotask(() => input?.focus());
  });

  /** Leaves Search: the field empties and the keyboard goes down. */
  function exit() {
    query = "";
    input?.blur();
    onExit?.();
  }

  function clear() {
    query = "";
    input?.focus();
  }

  async function choose(i: number) {
    if (i < results.length) return app.open(results[i].path);
    if (canCreate) {
      try {
        const path = await api.noteCreate(await app.newNoteFolder(), query.trim());
        await app.refreshFiles();
        app.open(path);
        app.edited();
      } catch (e) {
        app.say((e as Error).message);
      }
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
    } else if (e.key === "Escape" && onExit) {
      exit();
    }
  }
</script>

<div class="search {mode}" class:ios={isIOS}>
  <div class="input-row">
    {#if onExit && !isIOS}
      <!-- Android's search view: a back arrow on the left leaves search. -->
      <button class="icon-btn lead" onclick={exit} aria-label="Back"><ArrowLeft size={20} /></button>
    {:else}
      <Search size={18} />
    {/if}
    <input
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
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
    {#if onExit && query}
      <button class="icon-btn clear" onclick={clear} aria-label="Clear search"><X size={18} /></button>
    {/if}
    {#if onExit && isIOS && (focused || query)}
      <!-- iOS: Cancel beside the field leaves search. -->
      <button class="cancel" onclick={exit}>Cancel</button>
    {/if}
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
        class:selected={showSelection && i === selected}
        onclick={() => choose(i)}
        onkeydown={() => {}}
        onpointerenter={(e) => e.pointerType !== "touch" && (selected = i)}
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
        onpointerenter={(e) => e.pointerType !== "touch" && (selected = results.length)}
      >
        <FilePlus size={15} />
        <span class="text"><span class="title">Create “{query.trim()}”</span></span>
      </li>
    {/if}
    {#if failed && query.trim()}
      <li class="none" role="presentation">Search didn't finish. {failed}</li>
    {:else if query.trim() && answered === query.trim() && !results.length && !canCreate}
      <li class="none" role="presentation">No notes match.</li>
    {:else if !query.trim() && !recent.length}
      <li class="none" role="presentation">No notes yet. Type a title and press Return to create one.</li>
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
  .lead {
    margin-left: -8px;
    color: var(--ink);
  }
  .clear {
    color: var(--graphite);
  }
  .cancel {
    flex: none;
    min-height: var(--target);
    padding: 0 0 0 4px;
    border: 0;
    background: none;
    color: var(--papyrus);
    font: inherit;
  }
  /* The field's own clear button would sit beside ours. */
  .page input::-webkit-search-cancel-button {
    display: none;
  }
  input {
    flex: 1;
    min-height: 54px;
    border: 0;
    background: none;
    font-size: var(--text-lg);
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
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--graphite);
  }
  li[role="option"] :global(svg) {
    margin-top: 4px;
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
