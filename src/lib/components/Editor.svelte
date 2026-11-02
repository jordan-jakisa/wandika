<script lang="ts">
  import { EditorState } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { ChevronLeft, Lock, LockOpen, Trash2, Link2 } from "@lucide/svelte";
  import { onDestroy } from "svelte";
  import { api, openUrl } from "../api";
  import { app, titleOf } from "../app.svelte";
  import { extensions } from "../editor/setup";
  import type { SearchHit } from "../types";
  import Menu from "./Menu.svelte";
  import Unlock from "./Unlock.svelte";

  let { path, compact = false }: { path: string; compact?: boolean } = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;
  let loadedPath: string | null = null;
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let title = $state("");
  let error = $state<string | null>(null);
  let locked = $state(false);
  let backlinks = $state<SearchHit[]>([]);
  const encrypted = $derived(path.endsWith(".age"));

  async function save() {
    clearTimeout(saveTimer);
    if (!dirty || !view || !loadedPath) return;
    dirty = false;
    try {
      await api.noteWrite(loadedPath, view.state.doc.toString());
      app.edited();
    } catch (e) {
      dirty = true;
      error = `Couldn't save: ${(e as Error).message}`;
    }
  }

  function onChange() {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  async function load(p: string) {
    await save();
    error = null;
    locked = false;
    title = titleOf(p);
    loadedPath = p;
    let text = "";
    try {
      text = await api.noteRead(p);
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("locked")) locked = true;
      else error = message;
      view?.destroy();
      view = null;
      return;
    }
    if (loadedPath !== p) return;
    const state = EditorState.create({
      doc: text,
      extensions: extensions({
        getTitles: () => app.titles,
        onOpenLink: (target) => void app.follow(target),
        onChange,
      }),
    });
    if (view) view.setState(state);
    else view = new EditorView({ state, parent: host });
    dirty = false;
    backlinks = await api.backlinks(p).catch(() => []);
    // A new note opens with its title selected so typing renames it.
    if (title === "Untitled" || /^Untitled \d+$/.test(title)) {
      queueMicrotask(() => {
        const input = document.getElementById("note-title") as HTMLInputElement | null;
        input?.focus();
        input?.select();
      });
    }
  }

  $effect(() => {
    void load(path);
  });

  // Reload when a sync changed this note on disk and nothing is waiting to be saved.
  $effect(() => {
    const { paths, at } = app.changed;
    if (!at || !loadedPath || !paths.includes(loadedPath)) return;
    if (dirty) return;
    void (async () => {
      const text = await api.noteRead(loadedPath!).catch(() => null);
      if (text === null) {
        app.current = null;
        return;
      }
      if (view && text !== view.state.doc.toString() && !dirty) {
        const sel = view.state.selection.main.head;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: Math.min(sel, text.length) },
        });
        dirty = false;
      }
    })();
  });

  app.flush = save;

  async function rename() {
    const next = title.trim();
    if (!loadedPath || !next || next === titleOf(loadedPath)) {
      title = titleOf(path);
      return;
    }
    try {
      await save();
      const to = await api.entryRename(loadedPath, next);
      loadedPath = to;
      await app.refreshFiles();
      app.current = to;
      app.edited();
    } catch (e) {
      app.say((e as Error).message);
      title = titleOf(path);
    }
  }

  async function toggleEncryption() {
    const enc = app.status?.encryption;
    if (!enc?.set_up || !enc.unlocked) {
      app.settingsOpen = true;
      app.say(enc?.set_up ? "Unlock encrypted notes first." : "Set up encryption in Settings first.");
      return;
    }
    await save();
    try {
      const to = await api.setEncrypted(path, !encrypted);
      await app.refreshFiles();
      app.current = to;
      app.edited();
      app.say(encrypted ? "Note decrypted." : "Note encrypted.");
    } catch (e) {
      app.say((e as Error).message);
    }
  }

  async function trash() {
    const ok = await app.ask({
      title: `Move “${title}” to the trash?`,
      message: "You can restore it from the .trash folder in the repository.",
      confirm: "Move to trash",
      danger: true,
    });
    if (ok === null) return;
    clearTimeout(saveTimer);
    dirty = false;
    await api.entryTrash(path);
    app.current = null;
    await app.refreshFiles();
    app.edited();
    app.say("Moved to trash.");
  }

  function onUrl(e: Event) {
    const href = (e as CustomEvent<string>).detail;
    if (/^https?:|^mailto:/.test(href)) void openUrl(href);
  }

  $effect(() => {
    const blur = () => void save();
    window.addEventListener("wandika:open-url", onUrl);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("wandika:open-url", onUrl);
      window.removeEventListener("blur", blur);
    };
  });

  onDestroy(() => {
    void save();
    view?.destroy();
    app.flush = async () => {};
  });
</script>

<article class="note" class:compact>
  <header class="bar">
    {#if compact}
      <button class="icon-btn back" onclick={() => (app.current = null)} aria-label="Back to notes">
        <ChevronLeft size={22} />
      </button>
    {/if}
    <span class="spacer"></span>
    {#if encrypted}
      <span class="badge" title="Stored encrypted on GitHub and on this device"><Lock size={14} /> Encrypted</span>
    {/if}
    <Menu label="Note actions">
      <button role="menuitem" onclick={toggleEncryption}>
        {#if encrypted}<LockOpen size={16} /> Decrypt note{:else}<Lock size={16} /> Encrypt note{/if}
      </button>
      <button role="menuitem" class="danger" onclick={trash}><Trash2 size={16} /> Move to trash</button>
    </Menu>
  </header>

  <div class="page">
    <input
      id="note-title"
      class="title"
      bind:value={title}
      onblur={rename}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
          view?.focus();
        }
        if (e.key === "Escape") {
          title = titleOf(path);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      aria-label="Note title"
      spellcheck="false"
    />

    {#if error}
      <p class="error">{error}</p>
    {/if}

    {#if locked}
      <Unlock onunlocked={() => load(path)} />
    {/if}

    <div class="cm-host" bind:this={host} hidden={locked || !!error}></div>

    {#if backlinks.length && !locked}
      <section class="backlinks" aria-labelledby="backlinks-h">
        <h2 id="backlinks-h"><Link2 size={15} /> Linked from {backlinks.length} {backlinks.length === 1 ? "note" : "notes"}</h2>
        <ul>
          {#each backlinks as b (b.path)}
            <li>
              <button onclick={() => app.open(b.path)}>
                <span class="bl-title">{b.title}</span>
                <span class="bl-snippet">{b.snippet}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</article>

<style>
  .note {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--sheet);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 52px;
    padding: calc(8px + var(--safe-top)) 16px 8px;
    position: sticky;
    top: 0;
    background: var(--sheet);
    z-index: 2;
  }
  .compact .bar {
    padding-left: max(8px, var(--safe-left));
  }
  .spacer {
    flex: 1;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--small);
    color: var(--graphite);
    margin-right: 4px;
  }
  .page {
    flex: 1;
    overflow-y: auto;
    padding: 8px max(20px, var(--safe-right)) 30vh max(20px, var(--safe-left));
    -webkit-overflow-scrolling: touch;
  }
  @media (min-width: 900px) {
    .page {
      padding: 24px 56px 30vh;
    }
  }
  .page > * {
    max-width: 68ch;
    margin-left: auto;
    margin-right: auto;
  }
  .cm-host :global(.cm-editor) {
    max-width: 68ch;
  }
  .title {
    display: block;
    width: 100%;
    border: 0;
    background: none;
    font-family: var(--font-note);
    font-size: calc(var(--note-size) * 2.25);
    font-weight: 620;
    line-height: 1.15;
    letter-spacing: -0.01em;
    padding: 0;
    margin-bottom: 0.6em;
    color: var(--ink);
  }
  .title:focus {
    outline: none;
  }
  .backlinks {
    margin-top: 32px;
    padding-top: 20px;
    border-top: 1px solid var(--rule);
  }
  .backlinks h2 {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--small);
    font-weight: 600;
    color: var(--graphite);
    margin: 0 0 8px;
  }
  .backlinks ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .backlinks button {
    display: block;
    width: 100%;
    text-align: left;
    border: 0;
    background: none;
    padding: 8px 0;
  }
  .bl-title {
    display: block;
    color: var(--papyrus);
    font-weight: 500;
  }
  .bl-snippet {
    display: block;
    color: var(--graphite);
    font-size: var(--small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [hidden] {
    display: none !important;
  }
</style>
