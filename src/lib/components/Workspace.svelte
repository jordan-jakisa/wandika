<script lang="ts">
  import { tick, untrack } from "svelte";
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
    PanelLeftClose,
    PanelLeftOpen,
    ChevronLeft,
    FolderPlus,
    RefreshCw,
  } from "@lucide/svelte";
  import { api } from "../api";
  import Menu from "./Menu.svelte";
  import { isIOS } from "../platform";
  import { push } from "../transitions";
  import { app, titleOf, type Tab } from "../app.svelte";
  import Editor from "./Editor.svelte";
  import FileTree from "./FileTree.svelte";
  import GraphView from "./GraphView.svelte";
  import ProjectsView from "./ProjectsView.svelte";
  import Search from "./Search.svelte";
  import StatusBar from "./StatusBar.svelte";
  import SyncStatus from "./SyncStatus.svelte";
  import TasksView from "./TasksView.svelte";
  import TodayPanel from "./TodayPanel.svelte";
  import Resizer from "./Resizer.svelte";

  let width = $state(typeof window === "undefined" ? 1200 : window.innerWidth);
  const wide = $derived(width >= 900);
  // A board needs the width; the Today column steps aside while one is open.
  const boardOpen = $derived(!!app.current && !!app.titles.find((t) => t.path === app.current)?.board);
  // Column widths, dragged by their edges and kept per device.
  const SIDEBAR = { initial: 268, min: 200, max: 420 };
  const TODAY = { initial: 320, min: 260, max: 520 };
  const LAYOUT_KEY = "wandika.layout";
  const MAIN_MIN = 460;
  let cols = $state(loadLayout());
  function loadLayout() {
    try {
      const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
      return {
        sidebar: Number(v.sidebar) || SIDEBAR.initial,
        today: Number(v.today) || TODAY.initial,
        sidebarOpen: v.sidebarOpen !== false,
      };
    } catch {
      return { sidebar: SIDEBAR.initial, today: TODAY.initial, sidebarOpen: true };
    }
  }
  function setCols(patch: Partial<typeof cols>) {
    cols = { ...cols, ...patch };
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(cols));
    } catch {
      /* private mode: widths reset next launch */
    }
  }
  // On a narrow window the sidebar gives way first, so the note always keeps room.
  const sidebarW = $derived(cols.sidebarOpen ? Math.max(SIDEBAR.min, Math.min(cols.sidebar, width - MAIN_MIN)) : 0);
  const toggleSidebar = () => setCols({ sidebarOpen: !cols.sidebarOpen });
  const roomForToday = $derived(
    width - sidebarW - cols.today >= MAIN_MIN && !boardOpen && !(app.tab === "graph" && !app.current),
  );
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
    } else if (k === "\\") {
      e.preventDefault();
      toggleSidebar();
    } else if (k === ",") {
      e.preventDefault();
      app.openSettings();
    }
  }

  // Phones: system back (Android) and swipe back (iOS) leave the note, as in native apps. Opening
  // a note adds a history entry so the system back gesture has somewhere to go.
  let notePushed = false;
  $effect(() => {
    if (wide) return;
    const open = !!app.current;
    if (open && !notePushed) {
      history.pushState({ wandika: "note" }, "");
      notePushed = true;
    } else if (!open && notePushed) {
      notePushed = false;
      if (history.state?.wandika === "note") history.back();
    }
  });
  function onPopState() {
    // Settings keeps its own screens in history and handles back itself.
    if (app.settingsOpen) return;
    if (notePushed) {
      notePushed = false;
      app.current = null;
    }
  }

  // iOS: drag from the left edge to go back.
  let swipeX = $state(0);
  let swipeFrom: { x: number; y: number } | null = null;
  function swipeStart(e: TouchEvent) {
    const t = e.touches[0];
    swipeFrom = isIOS && app.current && t.clientX < 24 ? { x: t.clientX, y: t.clientY } : null;
  }
  function swipeMove(e: TouchEvent) {
    if (!swipeFrom) return;
    const t = e.touches[0];
    const dx = t.clientX - swipeFrom.x;
    if (Math.abs(t.clientY - swipeFrom.y) > Math.abs(dx) && swipeX === 0) return void (swipeFrom = null);
    swipeX = Math.max(0, dx);
  }
  /** Where the note was when a swipe let go, so it carries on from there instead of jumping. */
  let releasedAt = $state(0);
  function swipeEnd() {
    releasedAt = 0;
    if (swipeFrom && swipeX > width * 0.33) {
      releasedAt = swipeX;
      app.current = null;
    }
    swipeFrom = null;
    swipeX = 0;
  }

  const recentNotes = $derived(
    [...app.titles].sort((a, b) => b.modified - a.modified).slice(0, 6),
  );

  // Phones show three places. Views that live inside one of them show "‹ Today" or "‹ Notes".
  const phoneTabs: { id: Tab; label: string; icon: typeof FolderClosed }[] = [
    { id: "notes", label: "Notes", icon: FolderClosed },
    { id: "today", label: "Today", icon: CalendarDays },
    { id: "search", label: "Search", icon: SearchIcon },
  ];
  const PARENT: Partial<Record<Tab, Tab>> = { tasks: "today", projects: "notes", graph: "notes" };
  const parentTab = $derived(PARENT[app.tab] ?? app.tab);

  // Each tab keeps its own scroll position, so Notes is where you left it after a look at Today.
  const tabScroll = new Map<Tab, number>();
  let scrollTab: Tab = app.tab;
  $effect.pre(() => {
    const t = app.tab;
    untrack(() => {
      if (phoneBody && t !== scrollTab) tabScroll.set(scrollTab, phoneBody.scrollTop);
      scrollTab = t;
      void tick().then(() => phoneBody && (phoneBody.scrollTop = tabScroll.get(t) ?? 0));
    });
  });
  const subView = $derived(
    PARENT[app.tab] ? { parent: PARENT[app.tab]!, parentLabel: PARENT[app.tab] === "today" ? "Today" : "Notes" } : null,
  );


  // Pull down at the top of a list to sync.
  const PULL_TRIGGER = 64;
  let phoneBody = $state<HTMLDivElement>();
  let pull = $state(0);
  let pullFrom: number | null = null;
  function pullStart(e: TouchEvent) {
    pullFrom = app.synced && (phoneBody?.scrollTop ?? 1) <= 0 ? e.touches[0].clientY : null;
  }
  function pullMove(e: TouchEvent) {
    if (pullFrom === null) return;
    const dy = e.touches[0].clientY - pullFrom;
    pull = dy > 0 ? Math.min(96, dy * 0.5) : 0;
  }
  /** True while a sync you pulled for runs; background syncs never push the list down. */
  let pulledSync = $state(false);
  function pullEnd() {
    if (pull >= PULL_TRIGGER) {
      pulledSync = true;
      void app.sync().finally(() => (pulledSync = false));
    }
    pull = 0;
    pullFrom = null;
  }

  // While the keyboard is up, bottom bars would ride on top of it; tuck them away.
  let typing = $state(false);
  function onFocusIn(e: FocusEvent) {
    const el = e.target as HTMLElement;
    typing = el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName);
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

<svelte:window bind:innerWidth={width} onkeydown={onKey} onpopstate={onPopState} onfocusin={onFocusIn} onfocusout={() => (typing = false)} />
<svelte:document onvisibilitychange={onVisibility} />

{#snippet conflictsBanner()}
  {#if app.conflicts.length}
    <div class="banner conflict" role="status">
      <p>
        {app.conflicts.length === 1 ? "A note was" : `${app.conflicts.length} notes were`} edited on two devices at once.
        Both versions are kept:
        {#each app.conflicts as c, i (c)}
          <button class="link-btn" onclick={() => app.open(c)}>{titleOf(c)}</button>{i < app.conflicts.length - 1 ? ", " : "."}
        {/each}
        Open each copy, keep what you need in the note, then move the copy to the trash.
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
  <!-- The likeliest next step is the note you were just in. Today's note is one click away in the
       sidebar and the Today column, so it isn't offered a third time here. -->
  <div class="empty">
    {#if recentNotes.length}
      <h2 class="empty-title">Recent notes</h2>
      <ul class="recent">
        {#each recentNotes as n (n.path)}
          <li>
            <button onclick={() => app.open(n.path)}>
              <span class="recent-title">{n.title}</span>
              {#if n.path.includes("/")}<span class="recent-folder">{n.path.slice(0, n.path.lastIndexOf("/"))}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <h2 class="empty-title">Start your first note</h2>
    {/if}
    <div class="empty-actions">
      <button class="btn" onclick={() => app.newNote()}><Plus size={16} /> New note</button>
    </div>
    {#if isMac}
      <p class="muted keys">Search with ⌘K. New note with ⌘N.{app.synced ? " Sync with ⌘S." : ""}</p>
    {/if}
  </div>
{/snippet}

{#if wide}
  <div
    class="shell"
    class:mac={isMac}
    class:with-today={app.showToday && roomForToday}
    class:collapsed={!cols.sidebarOpen}
    style="--sidebar: {sidebarW}px; --today: {cols.today}px"
  >
    <aside class="sidebar" aria-label="Vault" hidden={!cols.sidebarOpen}>
      <Resizer
        edge="right"
        value={sidebarW}
        min={SIDEBAR.min}
        max={SIDEBAR.max}
        initial={SIDEBAR.initial}
        label="Resize the sidebar"
        onchange={(w) => setCols({ sidebar: w })}
      />
      <div class="side-head" data-tauri-drag-region>
        <div class="vault" data-tauri-drag-region>
          <span class="vault-name" title={app.vaultName}>{app.vault?.name}</span>
        </div>
        <button class="icon-btn" onclick={() => app.openSettings()} aria-label="Settings"><SettingsIcon size={18} /></button>
        <button class="icon-btn" onclick={toggleSidebar} aria-label="Hide the sidebar" title="Hide the sidebar (⌘\\)"><PanelLeftClose size={18} /></button>
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
      {#if !cols.sidebarOpen}
        <button class="icon-btn sidebar-toggle" onclick={toggleSidebar} aria-label="Show the sidebar" title="Show the sidebar (⌘\\)">
          <PanelLeftOpen size={18} />
        </button>
      {/if}
      {@render conflictsBanner()}
      {#if app.current}
        {#key app.openCount}
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
        <Resizer
          edge="left"
          value={cols.today}
          min={TODAY.min}
          max={Math.min(TODAY.max, width - sidebarW - MAIN_MIN)}
          initial={TODAY.initial}
          label="Resize the Today column"
          onchange={(w) => setCols({ today: w })}
        />
        <div class="today-scroll"><TodayPanel /></div>
      </aside>
    {/if}
    <StatusBar />
  </div>

  <dialog bind:this={switcherEl} class="switcher" oncancel={() => (app.switcherOpen = false)} onclick={(e) => { if (e.target === switcherEl) app.switcherOpen = false; }}>
    {#if app.switcherOpen}<Search mode="palette" />{/if}
  </dialog>
{:else}
  <!-- Swipe back is a shortcut; the Back button does the same with a tap or a keyboard. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="phone"
    class:typing
    ontouchstart={swipeStart}
    ontouchmove={swipeMove}
    ontouchend={swipeEnd}
    style={swipeX ? `--swipe: ${swipeX}px` : undefined}
  >
    <!-- The list stays mounted under an open note, so back returns to the same place and a swipe
         back shows it underneath. -->
    <div class="phone-list" inert={!!app.current}>
      <!-- Pull to sync is a shortcut for the sync status line. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="phone-body"
        bind:this={phoneBody}
        ontouchstart={pullStart}
        ontouchmove={pullMove}
        ontouchend={pullEnd}
      >
        {#if app.synced && (pull > 0 || pulledSync)}
          <div class="pull" class:settling={pull === 0} style="height: {pulledSync && !pull ? 44 : pull}px" aria-live="polite">
            {pulledSync ? "Syncing…" : pull >= PULL_TRIGGER ? "Release to sync" : "Pull to sync"}
          </div>
        {/if}
        {@render conflictsBanner()}
        {#if subView}
          <button class="back up" onclick={() => (app.tab = subView.parent)}>
            <ChevronLeft size={22} /> {subView.parentLabel}
          </button>
        {/if}
        <!-- A screen inside a tab (Tasks, Projects, Graph) slides in; switching tabs is instant. -->
        {#key app.tab}
          <div class="view" in:push={{ enabled: !!PARENT[app.tab] }}>
            {#if app.tab === "notes"}
              <header class="phone-head">
                <h1 class="vault-name">{app.vault?.name}</h1>
                <Menu label="More" size={22}>
                  <button role="menuitem" onclick={() => app.showGraph()}><Network size={18} /> Graph</button>
                  <button role="menuitem" onclick={() => (app.tab = "projects")}><Columns3 size={18} /> Projects</button>
                  <button role="menuitem" onclick={() => app.newFolder()}><FolderPlus size={18} /> New folder</button>
                  {#if app.synced}
                    <button role="menuitem" onclick={() => app.sync()}><RefreshCw size={18} /> Sync now</button>
                  {/if}
                  <button role="menuitem" onclick={() => app.openSettings()}><SettingsIcon size={18} /> Settings</button>
                </Menu>
              </header>
              <div class="phone-status"><SyncStatus /></div>
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
        {/key}
      </div>

      <!-- Three places and one action. Tasks live in Today; boards, tags and the graph in Notes. -->
      <!-- iOS: the bar floats on Liquid Glass over the content. Android: a flat bar. -->
      <nav class="bar" class:glassbar={isIOS} aria-label="Sections">
        <div class="tabs" class:glass={isIOS}>
          {#each phoneTabs as t (t.id)}
            {@const on = parentTab === t.id}
            <button class:active={on} aria-current={on ? "page" : undefined} onclick={() => (app.tab = t.id)}>
              <t.icon size={22} strokeWidth={on ? 2.3 : 1.9} />
              <span>{t.label}</span>
            </button>
          {/each}
        </div>
        <button class="new" class:glass={isIOS} onclick={() => app.newNote()} aria-label="New note"><Plus size={24} /></button>
      </nav>
    </div>
    {#if app.current}
      <div
        class="note-host"
        class:swiping={swipeX > 0}
        in:push
        out:push={{ from: releasedAt }}
      >
        {#key app.openCount}
          <Editor path={app.current} compact />
        {/key}
      </div>
    {/if}
  </div>
{/if}

<style>
  .shell {
    display: grid;
    transition: grid-template-columns var(--dur-base) var(--ease-out);
    grid-template-columns: var(--sidebar) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    height: 100dvh;
  }
  .shell.with-today {
    grid-template-columns: var(--sidebar) minmax(0, 1fr) var(--today);
  }
  .sidebar {
    position: relative;
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
    font-size: var(--text-xs);
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
  @media (hover: hover) {
    .side-nav button:hover {
      background: var(--papyrus-wash);
    }
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
    padding-top: 32px;
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
    padding-top: 20px;
  }
  .phone-graph {
    height: 100%;
  }
  .sidebar-toggle {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 3;
  }
  /* Clear the traffic lights when the sidebar no longer covers them. */
  .mac .sidebar-toggle {
    top: 30px;
    left: 12px;
  }
  .collapsed .main :global(.bar) {
    padding-left: 52px;
  }
  .sidebar[hidden] {
    display: none;
  }
  .shell.collapsed {
    grid-template-columns: minmax(0, 1fr);
  }
  .shell.collapsed.with-today {
    grid-template-columns: minmax(0, 1fr) var(--today);
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
    position: relative;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--rule);
    background: var(--paper);
  }
  .today-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .mac .today-col {
    padding-top: 20px;
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
    font-size: var(--text-xl);
    font-weight: 650;
    letter-spacing: -0.01em;
    line-height: 1.2;
  }
  .empty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .recent {
    display: grid;
    width: min(28rem, 100%);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .recent button {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    width: 100%;
    min-height: 40px;
    padding: 0 var(--space-3);
    margin: 0 calc(-1 * var(--space-3));
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    text-align: left;
  }
  @media (hover: hover) {
    .recent button:hover {
      background: var(--papyrus-wash);
    }
  }
  .recent-title {
    font-family: var(--font-note);
    font-size: var(--text-lg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent-folder {
    margin-left: auto;
    flex: none;
    color: var(--graphite);
    font-size: var(--small);
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
    margin-top: 32px;
  }
  .banner.conflict {
    background: color-mix(in srgb, var(--alarm) 12%, var(--sheet));
  }
  .banner p {
    flex: 1;
    margin: 0;
    font-size: var(--small);
  }
  .switcher[open] {
    animation: pop-in var(--dur-quick) var(--ease-out);
  }
  .switcher {
    width: min(620px, calc(100vw - 32px));
    margin-top: 14vh;
    padding: 0;
    border: 1px solid var(--rule);
    border-radius: var(--radius-lg);
    background: var(--sheet);
    color: var(--ink);
    box-shadow: var(--shadow-modal);
  }
  .switcher::backdrop {
    background: var(--scrim);
  }

  /* Phone */
  .phone {
    position: relative;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    overflow: hidden;
  }
  .phone-list {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .note-host {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    background: var(--sheet);
    transform: translateX(var(--swipe, 0));
    transition: transform var(--dur-base) var(--ease-out);
  }
  .note-host.swiping {
    transition: none;
    box-shadow: -8px 0 24px rgb(0 0 0 / 0.15); /* the edge of the page being swiped away */
  }
  .note-host > :global(.note) {
    flex: 1;
    min-height: 0;
  }
  .phone-body {
    flex: 1;
    overflow-y: auto;
    padding-top: var(--safe-top);
    -webkit-overflow-scrolling: touch;
  }
  .pull {
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  /* Once the finger lifts, the row eases to its resting height. */
  .pull.settling {
    transition: height var(--dur-base) var(--ease-out);
    font-size: var(--small);
    color: var(--graphite);
  }
  .phone-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 8px 0 max(20px, var(--safe-left));
  }
  .phone-head .vault-name {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: var(--view-title-size);
    font-weight: var(--view-title-weight);
    letter-spacing: var(--view-title-tracking);
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .phone-status {
    padding: 0 20px 10px max(20px, var(--safe-left));
  }
  .up {
    margin: var(--space-1) 0 calc(-1 * var(--space-2)) var(--space-2);
  }

  /* Bottom bar: three places and the new-note button. */
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: calc(60px + var(--safe-bottom));
    padding: 0 max(8px, var(--safe-right)) var(--safe-bottom) max(8px, var(--safe-left));
    border-top: 1px solid var(--hairline);
    background: var(--paper);
  }
  .typing .bar {
    display: none;
  }
  .tabs {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    align-items: center;
  }
  .bar button {
    display: grid;
    justify-items: center;
    gap: 2px;
    min-height: 52px;
    align-content: center;
    border: 0;
    background: none;
    color: var(--graphite);
    font-size: var(--text-2xs);
    font-weight: 500;
  }
  .bar button.active {
    color: var(--ink);
  }
  .bar .new {
    flex: none;
    width: 48px;
    height: 48px;
    min-height: 0;
    place-items: center;
    border-radius: var(--radius-lg);
    background: var(--papyrus);
    color: var(--on-papyrus);
  }
  .bar .new:active {
    filter: brightness(0.92);
  }

  /* iOS: a Liquid Glass capsule floating over the content, the new-note button beside it. */
  .bar.glassbar {
    position: absolute;
    left: max(16px, var(--safe-left));
    right: max(16px, var(--safe-right));
    bottom: max(10px, calc(var(--safe-bottom) - 8px));
    z-index: 10;
    gap: 10px;
    height: auto;
    padding: 0;
    border: 0;
    background: none;
    pointer-events: none;
  }
  .glass {
    pointer-events: auto;
    background: color-mix(in srgb, var(--sheet) 58%, transparent);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    backdrop-filter: blur(22px) saturate(180%);
    border: 1px solid color-mix(in srgb, white 45%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, white 55%, transparent),
      0 10px 30px rgb(0 0 0 / 0.14);
  }
  :global([data-mode="dark"]) .glass {
    background: color-mix(in srgb, var(--sheet) 55%, transparent);
    border-color: color-mix(in srgb, white 14%, transparent);
    box-shadow:
      inset 0 1px 0 color-mix(in srgb, white 12%, transparent),
      0 10px 30px rgb(0 0 0 / 0.4);
  }
  .glassbar .tabs {
    height: 62px;
    padding: 4px;
    border-radius: 999px;
  }
  .glassbar .tabs button {
    height: 100%;
    min-height: 0;
    border-radius: 999px;
    color: var(--ink);
    font-size: var(--text-2xs);
    font-weight: 600;
    transition: background var(--dur-quick) var(--ease-out);
  }
  .glassbar .tabs button.active {
    color: var(--papyrus);
    background: color-mix(in srgb, var(--ink) 8%, transparent);
  }
  /* The one action is tinted glass in the accent colour. */
  .glassbar .new {
    width: 62px;
    height: 62px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--papyrus) 80%, transparent);
    color: var(--on-papyrus);
  }
  /* The floating bar overlaps content, so lists leave room to scroll past it. */
  :global([data-platform="ios"]) .phone-body {
    padding-bottom: calc(96px + var(--safe-bottom));
  }
  @media (prefers-reduced-transparency: reduce) {
    .glass {
      background: var(--sheet);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
</style>
