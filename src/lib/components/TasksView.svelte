<script lang="ts">
  import { readView, saveView } from "../viewPrefs";
  import { untrack } from "svelte";
  import { Check, Search } from "@lucide/svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import { focus } from "../focus.svelte";
  import { composeTask, matchesTask, parseTask, tagsOf, taskOrder } from "../taskText";
  import type { RemoteTask, VaultTask } from "../types";
  import TaskRow from "./TaskRow.svelte";

  let tasks = $state<VaultTask[]>([]);
  const remote = $derived<RemoteTask[]>(app.today?.remote_tasks ?? []);
  let showDone = $state(readView("tasks", { showDone: false }).showDone);
  $effect(() => saveView("tasks", { showDone }));
  let loading = $state(true);
  let failed = $state(false);

  async function load() {
    loading = true;
    // Google Tasks and Reminders arrive through Today on their own; the vault's tasks never wait on the network.
    void app.loadToday();
    try {
      tasks = await api.tasksVault();
      failed = false;
    } catch (e) {
      failed = true;
      app.say((e as Error).message);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void app.changed.at;
    untrack(() => load());
  });

  let query = $state("");
  const visible = $derived(tasks.filter((t) => (showDone || !t.done) && matchesTask(t, query)));
  /** Pinned tasks sit together at the top, whatever note they live in. */
  const pinned = $derived(visible.filter((t) => parseTask(t.text).pinned).sort((a, b) => taskOrder(a.text, b.text)));
  /** The tags on open tasks, most used first: one tap filters by them. */
  const tags = $derived.by(() => {
    const count = new Map<string, number>();
    for (const t of tasks) if (!t.done) for (const tag of tagsOf(t.text)) count.set(tag, (count.get(tag) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([tag]) => tag);
  });
  const words = $derived(query.trim().toLowerCase().split(/\s+/).filter(Boolean));
  function toggleTag(tag: string) {
    const word = `#${tag}`;
    query = words.includes(word) ? words.filter((w) => w !== word).join(" ") : [...words, word].join(" ");
  }
  const byNote = $derived.by(() => {
    const groups = new Map<string, VaultTask[]>();
    for (const t of visible) {
      if (parseTask(t.text).pinned) continue;
      if (!groups.has(t.path)) groups.set(t.path, []);
      groups.get(t.path)!.push(t);
    }
    // Inside a note, tasks keep the note's order.
    for (const items of groups.values()) items.sort((a, b) => a.line - b.line);
    return [...groups.entries()];
  });
  const byList = $derived.by(() => {
    const groups = new Map<string, RemoteTask[]>();
    for (const t of remote) {
      if (!matchesTask({ text: t.title, title: t.list }, query)) continue;
      const key = `${t.source === "apple" ? "Reminders" : "Google Tasks"}: ${t.list}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    return [...groups.entries()];
  });
  const open = $derived(tasks.filter((t) => !t.done).length);
  const shown = $derived(visible.length + byList.reduce((n, [, items]) => n + items.length, 0));

  async function refresh(path: string) {
    app.edited();
    app.changed = { paths: [path], at: Date.now() };
  }
  const pin = (t: VaultTask) => async () => {
    await api.taskEdit(t.path, t.line, t.text, composeTask(t.text, { pinned: !parseTask(t.text).pinned }), t.details);
    await refresh(t.path);
  };
  const toggle = (t: VaultTask) => async () => {
    await api.taskToggle(t.path, t.line, t.text);
    await refresh(t.path);
  };
  const where = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "Vault");
  /** A big vault has thousands of tasks; notes are listed a page at a time. */
  const PAGE = 40;
  let notesShown = $state(PAGE);
</script>

<section class="tasks" aria-labelledby="tasks-title">
  <header>
    <h2 id="tasks-title">Tasks</h2>
    <button class="chip" aria-pressed={showDone} class:on={showDone} onclick={() => (showDone = !showDone)}>
      {#if showDone}<Check size={16} />{/if} Show done
    </button>
  </header>
  <p class="muted summary">
    {loading && !tasks.length
      ? "Gathering tasks from your notes…"
      : failed && !tasks.length
        ? "Couldn't gather your tasks."
        : open
          ? `${open} open ${open === 1 ? "task" : "tasks"} in your notes.`
          : "No open tasks. Write - [ ] in any note to add one."}
  </p>

  {#if tasks.length || remote.length}
    <div class="find">
      <label class="search">
        <Search size={16} aria-hidden="true" />
        <span class="sr-only">Search tasks</span>
        <input type="search" class="field" bind:value={query} placeholder="Search tasks, or #tag" />
      </label>
      {#if tags.length}
        <div class="tags" role="group" aria-label="Tags">
          {#each tags as tag (tag)}
            {@const on = words.includes(`#${tag}`)}
            <button class="chip" class:on aria-pressed={on} onclick={() => toggleTag(tag)}>#{tag}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if query.trim() && !shown}
    <p class="muted">No tasks match “{query.trim()}”. <button class="link-btn" onclick={() => (query = "")}>Clear search</button></p>
  {/if}

  {#snippet row(t: VaultTask, place: string)}
    <TaskRow
      leaves={!showDone}
      text={t.text}
      done={t.done}
      due={t.due}
      details={t.details}
      where={place}
      onToggle={toggle(t)}
      onEdit={() => (app.editingTask = t)}
      onPin={pin(t)}
      onFocus={() => focus.start({ text: parseTask(t.text).name, task: t })}
      onArchive={() => app.archiveTask(t)}
      onDelete={() => app.deleteTask(t)}
    />
  {/snippet}

  {#if pinned.length}
    <section class="group" aria-labelledby="pinned-h">
      <h3 id="pinned-h">Pinned</h3>
      <ul>
        {#each pinned as t (t.path + t.line)}
          {@render row(t, t.title)}
        {/each}
      </ul>
    </section>
  {/if}

  {#each byNote.slice(0, notesShown) as [path, items] (path)}
    <section class="group">
      <h3><button onclick={() => app.open(path)}>{items[0].title}</button></h3>
      <ul>
        {#each items as t (t.line)}
          {@render row(t, where(path))}
        {/each}
      </ul>
    </section>
  {/each}
  {#if byNote.length > notesShown}
    {@const left = byNote.length - notesShown}
    <button class="more" onclick={() => (notesShown += PAGE)}>
      {left > PAGE ? `Show ${PAGE} more notes of ${left}` : `Show ${left} more ${left === 1 ? "note" : "notes"}`}
    </button>
  {/if}

  {#each byList as [list, items] (list)}
    <section class="group">
      <h3>{list}</h3>
      <ul>
        {#each items as t (t.id)}
          <TaskRow
            leaves={!showDone}
            text={t.title}
            done={t.done}
            due={t.due}
            where={t.list}
            onFocus={() => focus.start({ text: t.title, remote: t })}
            onToggle={async () => {
              await api.remoteTaskToggle(t.source, t.list_id, t.id, !t.done);
              await app.loadToday(true);
            }}
          />
        {/each}
      </ul>
    </section>
  {/each}
</section>

<style>
  .tasks {
    padding: 20px 20px calc(32px + var(--safe-bottom));
    max-width: 72ch;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: var(--view-title-size);
    font-weight: var(--view-title-weight);
    letter-spacing: var(--view-title-tracking);
  }
  .more {
    min-height: var(--target);
    margin: 4px 0 16px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--papyrus);
    font-size: var(--small);
  }
  .summary {
    margin: 6px 0 16px;
  }
  .find {
    display: grid;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .search {
    position: relative;
    display: block;
  }
  .search :global(svg) {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--graphite);
    pointer-events: none;
  }
  .search input {
    padding-left: 38px;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  /* Filter chip: 32dp, 8dp corners, check mark when on. */
  .group {
    margin-bottom: 20px;
  }
  h3 {
    margin: 0 0 4px;
    font-size: var(--text-md);
    font-weight: 600;
  }
  h3 button {
    border: 0;
    background: none;
    padding: 0;
    font-weight: 600;
    color: var(--ink);
  }
  @media (hover: hover) {
    h3 button:hover {
      color: var(--papyrus);
    }
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
