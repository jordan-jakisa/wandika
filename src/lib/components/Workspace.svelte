<script lang="ts">
  import {
    CalendarDays,
    ListChecks,
    NotebookPen,
    PanelRightClose,
    PanelRightOpen,
    Plus,
    Search as SearchIcon,
    Settings as SettingsIcon,
    FolderClosed,
    Columns3,
    Network,
  } from "@lucide/svelte";
  import { app, titleOf, type Tab } from "../app.svelte";
  import Editor from "./Editor.svelte";
  import FileTree from "./FileTree.svelte";
  import GraphView from "./GraphView.svelte";
  import ProjectsView from "./ProjectsView.svelte";
  import Search from "./Search.svelte";
  import SyncStatus from "./SyncStatus.svelte";
  import TasksView from "./TasksView.svelte";
  import TodayPanel from "./TodayPanel.svelte";

  let width = $state(typeof window === "undefined" ? 1200 : window.innerWidth);
  const wide = $derived(width >= 900);
  // A board needs the width; the Today column steps aside while one is open.
  const boardOpen = $derived(!!app.current && !!app.titles.find((t) => t.path === app.current)?.board);
  const roomForToday = $derived(width >= 1180 && !boardOpen && !(app.tab === "graph" && !app.current));
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform) && !("ontouchend" in document);

  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "k" || k === "o") {
      e.preventDefault();
      app.switcherOpen = !app.switcherOpen;
    } else if (k === "n" && !e.shiftKey) {
      e.preventDefault();
      void app.newNote();
    } else if (k === "s") {
      e.preventDefault();
      void app.sync();
    } else if (k === "d") {
      e.preventDefault();
      void app.openDaily();
    } else if (k === ",") {
      e.preventDefault();
      app.settingsOpen = true;
    }
  }

  function onVisibility() {
    if (document.visibilityState === "visible") void app.sync();
    else void app.flush();
  }

  let switcherEl = $state<HTMLDialogElement>();
  $effect(() => {
    if (!switcherEl) return;
    if (app.switcherOpen && !switcherEl.open) switcherEl.showModal();
    if (!app.switcherOpen && switcherEl.open) switcherEl.close();
  });

  const tabs: { id: Tab; label: string; icon: typeof FolderClosed }[] = [
    { id: "notes", label: "Notes", icon: FolderClosed },
    { id: "today", label: "Today", icon: CalendarDays },
    { id: "tasks", label: "Tasks", icon: ListChecks },
    { id: "projects", label: "Projects", icon: Columns3 },
    { id: "search", label: "Search", icon: SearchIcon },
  ];
</script>

<svelte:window bind:innerWidth={width} onkeydown={onKey} />
<svelte:document onvisibilitychange={onVisibility} />

{#snippet conflictsBanner()}
  {#if app.conflicts.length}
    <div class="banner" role="status">
      <p>
        {app.conflicts.length === 1 ? "A note was" : `${app.conflicts.length} notes were`} edited on two devices at once.
        Both versions are kept:
        {#each app.conflicts as c, i (c)}
          <button class="inline-link" onclick={() => app.open(c)}>{titleOf(c)}</button>{i < app.conflicts.length - 1 ? ", " : "."}
        {/each}
      </p>
      <button class="btn" onclick={() => (app.conflicts = [])}>Dismiss</button>
    </div>
  {/if}
  {#if app.tooBig.length}
    <div class="banner" role="status">
      <p>{app.tooBig.length === 1 ? "One file is" : `${app.tooBig.length} files are`} over 50 MB and stay on this device only: {app.tooBig.map(titleOf).join(", ")}.</p>
      <button class="btn" onclick={() => (app.tooBig = [])}>Dismiss</button>
    </div>
  {/if}
{/snippet}

{#snippet emptyMain()}
  <div class="empty">
    <p class="empty-title">Pick a note, or start today's.</p>
    <div class="empty-actions">
      <button class="btn primary" onclick={() => app.openDaily()}><NotebookPen size={16} /> Open today's note</button>
      <button class="btn" onclick={() => app.newNote("")}><Plus size={16} /> New note</button>
    </div>
    <p class="muted keys">Search with ⌘K. New note with ⌘N. Sync with ⌘S.</p>
  </div>
{/snippet}

{#if wide}
  <div class="shell" class:mac={isMac} class:with-today={app.showToday && roomForToday}>
    <aside class="sidebar" aria-label="Vault">
      <div class="side-head" data-tauri-drag-region>
        <div class="vault" data-tauri-drag-region>
          <span class="vault-name" title={app.vaultName}>{app.vault?.name}</span>
          <SyncStatus />
        </div>
        <button class="icon-btn" onclick={() => (app.settingsOpen = true)} aria-label="Settings"><SettingsIcon size={18} /></button>
      </div>
      <div class="side-actions">
        <button class="search-btn" onclick={() => (app.switcherOpen = true)}>
          <SearchIcon size={15} /> <span>Search</span> <kbd>⌘K</kbd>
        </button>
        <button class="icon-btn" onclick={() => app.newNote()} aria-label="New note"><Plus size={18} /></button>
      </div>
      <nav class="side-nav" aria-label="Views">
        <button onclick={() => app.openDaily()}><NotebookPen size={16} /> Today's note</button>
        <button class:active={!app.current && app.tab === "tasks"} onclick={() => { app.current = null; app.tab = "tasks"; }}>
          <ListChecks size={16} /> Tasks
        </button>
        <button class:active={!app.current && app.tab === "projects"} onclick={() => { app.current = null; app.tab = "projects"; }}>
          <Columns3 size={16} /> Projects
        </button>
        <button class:active={!app.current && app.tab === "graph"} onclick={() => app.showGraph()}>
          <Network size={16} /> Graph
        </button>
        {#if !roomForToday}
          <button class:active={!app.current && app.tab === "today"} onclick={() => { app.current = null; app.tab = "today"; }}>
            <CalendarDays size={16} /> Today
          </button>
        {/if}
      </nav>
      <div class="side-tree">
        <FileTree />
      </div>
    </aside>

    <main class="main">
      {@render conflictsBanner()}
      {#if app.current}
        {#key app.current}
          <Editor path={app.current} />
        {/key}
      {:else if app.tab === "tasks"}
        <div class="scroll"><TasksView /></div>
      {:else if app.tab === "projects"}
        <div class="scroll"><ProjectsView /></div>
      {:else if app.tab === "graph"}
        <div class="graph-host"><GraphView /></div>
      {:else if app.tab === "today" && !roomForToday}
        <div class="scroll"><TodayPanel /></div>
      {:else}
        {@render emptyMain()}
      {/if}
      {#if roomForToday}
        <button
          class="icon-btn today-toggle"
          onclick={() => (app.showToday = !app.showToday)}
          aria-label={app.showToday ? "Hide today" : "Show today"}
          aria-pressed={app.showToday}
        >
          {#if app.showToday}<PanelRightClose size={18} />{:else}<PanelRightOpen size={18} />{/if}
        </button>
      {/if}
    </main>

    {#if app.showToday && roomForToday}
      <aside class="today-col" aria-label="Today">
        <TodayPanel />
      </aside>
    {/if}
  </div>

  <dialog bind:this={switcherEl} class="switcher" oncancel={() => (app.switcherOpen = false)} onclick={(e) => { if (e.target === switcherEl) app.switcherOpen = false; }}>
    {#if app.switcherOpen}<Search mode="palette" />{/if}
  </dialog>
{:else}
  <div class="phone">
    {#if app.current}
      {#key app.current}
        <Editor path={app.current} compact />
      {/key}
    {:else}
      <div class="phone-body">
        {@render conflictsBanner()}
        {#if app.tab === "notes"}
          <header class="phone-head">
            <div class="vault">
              <span class="vault-name">{app.vault?.name}</span>
              <SyncStatus />
            </div>
            <button class="icon-btn" onclick={() => app.showGraph()} aria-label="Graph"><Network size={20} /></button>
            <button class="icon-btn" onclick={() => (app.settingsOpen = true)} aria-label="Settings"><SettingsIcon size={20} /></button>
            <button class="icon-btn" onclick={() => app.newNote()} aria-label="New note"><Plus size={22} /></button>
          </header>
          <button class="daily" onclick={() => app.openDaily()}><NotebookPen size={18} /> Open today's note</button>
          <FileTree />
        {:else if app.tab === "today"}
          <TodayPanel />
        {:else if app.tab === "tasks"}
          <TasksView />
        {:else if app.tab === "projects"}
          <ProjectsView />
        {:else if app.tab === "graph"}
          <div class="graph-host phone-graph"><GraphView /></div>
        {:else}
          <Search mode="page" />
        {/if}
      </div>
      <nav class="tabbar" aria-label="Sections">
        {#each tabs as t (t.id)}
          <button class:active={app.tab === t.id || (t.id === "notes" && app.tab === "graph")} aria-current={app.tab === t.id ? "page" : undefined} onclick={() => (app.tab = t.id)}>
            <t.icon size={22} />
            <span>{t.label}</span>
          </button>
        {/each}
      </nav>
    {/if}
  </div>
{/if}

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--sidebar) minmax(0, 1fr);
    height: 100dvh;
  }
  .shell.with-today {
    grid-template-columns: var(--sidebar) minmax(0, 1fr) var(--today);
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--rule);
    background: var(--paper);
  }
  .side-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 14px 10px 6px 16px;
  }
  .mac .side-head {
    padding-top: 40px;
  }
  .vault {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .vault-name {
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .side-actions {
    display: flex;
    gap: 4px;
    padding: 6px 10px 6px 12px;
  }
  .search-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    background: var(--sheet);
    color: var(--graphite);
  }
  .search-btn span {
    flex: 1;
    text-align: left;
  }
  kbd {
    font: inherit;
    font-size: 12px;
    color: var(--graphite);
  }
  .side-nav {
    display: grid;
    padding: 4px 8px;
  }
  .side-nav button {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink);
    text-align: left;
  }
  .side-nav button:hover {
    background: var(--papyrus-wash);
  }
  .side-nav button.active {
    background: color-mix(in srgb, var(--papyrus) 16%, transparent);
    font-weight: 600;
  }
  .side-tree {
    flex: 1;
    overflow-y: auto;
    border-top: 1px solid var(--rule);
    margin-top: 6px;
    padding-top: 6px;
  }
  .main {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--sheet);
  }
  .main > :global(.note) {
    flex: 1;
    min-height: 0;
  }
  .mac .main :global(.bar) {
    padding-top: 30px;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding-top: 24px;
  }
  .mac .scroll {
    padding-top: 40px;
  }
  .graph-host {
    flex: 1;
    min-height: 0;
  }
  .mac .graph-host {
    padding-top: 22px;
  }
  .phone-graph {
    height: 100%;
  }
  .today-toggle {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 3;
  }
  .mac .today-toggle {
    top: 30px;
  }
  .main :global(.bar) {
    padding-right: 52px;
  }
  .today-col {
    min-height: 0;
    overflow-y: auto;
    border-left: 1px solid var(--rule);
    background: var(--paper);
  }
  .mac .today-col {
    padding-top: 22px;
  }
  .empty {
    flex: 1;
    display: grid;
    align-content: center;
    justify-items: start;
    gap: 16px;
    padding: 40px 56px;
    max-width: calc(var(--measure) + 112px);
    margin: 0 auto;
    width: 100%;
  }
  .empty-title {
    margin: 0;
    font-family: var(--font-note);
    font-size: 1.8rem;
    font-weight: 600;
    line-height: 1.2;
  }
  .empty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .keys {
    margin: 0;
    font-size: var(--small);
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 12px 16px 0;
    padding: 10px 12px 10px 14px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--amber) 14%, var(--sheet));
  }
  .mac .main > .banner:first-child {
    margin-top: 34px;
  }
  .banner p {
    flex: 1;
    margin: 0;
    font-size: var(--small);
  }
  .inline-link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--papyrus);
    text-decoration: underline;
    font-size: inherit;
  }
  .switcher {
    width: min(620px, calc(100vw - 32px));
    margin-top: 14vh;
    padding: 0;
    border: 1px solid var(--rule);
    border-radius: var(--radius-lg);
    background: var(--sheet);
    color: var(--ink);
    box-shadow: 0 24px 60px rgb(0 0 0 / 0.22);
  }
  .switcher::backdrop {
    background: rgb(0 0 0 / 0.25);
  }

  /* Phone */
  .phone {
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--paper);
  }
  .phone > :global(.note) {
    flex: 1;
    min-height: 0;
  }
  .phone-body {
    flex: 1;
    overflow-y: auto;
    padding-top: var(--safe-top);
    -webkit-overflow-scrolling: touch;
  }
  .phone-head {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 12px 8px 4px max(20px, var(--safe-left));
  }
  .phone-head .vault-name {
    font-family: var(--font-note);
    font-size: 1.6rem;
    font-weight: 620;
  }
  .daily {
    display: flex;
    align-items: center;
    gap: 10px;
    width: calc(100% - 32px);
    margin: 8px 16px 6px;
    min-height: 48px;
    padding: 0 14px;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--sheet);
    font-weight: 500;
  }
  .tabbar {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    border-top: 1px solid var(--rule);
    background: var(--sheet);
    padding-bottom: var(--safe-bottom);
    padding-left: var(--safe-left);
    padding-right: var(--safe-right);
  }
  .tabbar button {
    display: grid;
    justify-items: center;
    gap: 2px;
    min-height: 54px;
    padding: 6px 0 4px;
    border: 0;
    background: none;
    color: var(--graphite);
    font-size: 11px;
    font-weight: 500;
  }
  .tabbar button.active {
    color: var(--papyrus);
  }
</style>
