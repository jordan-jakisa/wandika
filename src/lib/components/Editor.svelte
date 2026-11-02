<script lang="ts">
  import { EditorState } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { ChevronLeft, Code, ImagePlus, LayoutTemplate, Columns3, Lock, LockOpen, Network, Trash2, Link2 } from "@lucide/svelte";
  import { onDestroy } from "svelte";
  import { api, codeOf, openUrl } from "../api";
  import { app, titleOf } from "../app.svelte";
  import { pastedName } from "../attachments";
  import { extensions } from "../editor/setup";
  import { isBoard } from "../kanban";
  import type { SearchHit } from "../types";
  import Board from "./Board.svelte";
  import KeyboardBar from "./KeyboardBar.svelte";
  import Menu from "./Menu.svelte";
  import Unlock from "./Unlock.svelte";

  let { path, compact = false }: { path: string; compact?: boolean } = $props();

  let host: HTMLDivElement;
  let view: EditorView | null = null;
  let loadedPath: string | null = null;
  /** Text typed or changed on the board that hasn't reached the disk yet. */
  let pending: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let title = $state("");
  let error = $state<string | null>(null);
  let locked = $state(false);
  let backlinks = $state<SearchHit[]>([]);
  /** Board notes show as columns; this switches to their Markdown source. */
  let boardText = $state<string | null>(null);
  let boardKey = $state(0);
  let showSource = $state(false);
  const encrypted = $derived(path.endsWith(".age"));
  let picker: HTMLInputElement;
  /** Until the note has been tapped into, inserts go to its end rather than before its title. */
  let cursorPlaced = false;
  const insertAt = (v: EditorView) => (cursorPlaced ? v.state.selection.main.head : v.state.doc.length);
  let pickAt = 0;

  /** Saves files as attachments and embeds them, each on its own line, at `pos`. */
  async function addFiles(files: File[], v: EditorView, pos: number) {
    const note = loadedPath ?? path;
    const links: string[] = [];
    for (const f of files) {
      try {
        const rel = await api.attachmentSave(note, pastedName(f), f);
        links.push(`![[${rel.split("/").pop()}]]`);
      } catch (e) {
        app.say(`Couldn't add ${f.name || "the file"}: ${(e as Error).message}`);
      }
    }
    if (!links.length || v !== view) return;
    void app.refreshFiles();
    pos = Math.min(pos, v.state.doc.length);
    const line = v.state.doc.lineAt(pos);
    const insert = (pos > line.from ? "\n" : "") + links.join("\n") + (pos < line.to ? "\n" : "");
    v.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
    v.focus();
  }

  async function insertTemplate() {
    const list = await api.templatesList().catch(() => []);
    if (!list.length) {
      app.say("Put notes in a Templates folder to insert them here.");
      return;
    }
    const pick = await app.ask({
      title: "Insert template",
      confirm: "",
      choices: list.map((p) => ({ label: titleOf(p), value: p })),
    });
    if (!pick || !view) return;
    try {
      let text = await api.templateRender(pick, title);
      const pos = insertAt(view);
      if (pos > 0 && view.state.sliceDoc(pos - 1, pos) !== "\n") text = "\n\n" + text;
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
      view.focus();
    } catch (e) {
      app.say((e as Error).message);
    }
  }

  function pickImages() {
    pickAt = view ? insertAt(view) : 0;
    picker.click();
  }

  /** On phones the writing toolbar shows while the note's text has focus. */
  let writing = $state(false);

  async function save() {
    clearTimeout(saveTimer);
    if (pending === null || !loadedPath) return;
    const text = pending;
    pending = null;
    try {
      await api.noteWrite(loadedPath, text);
      app.edited();
      saveError = null;
      saveTries = 0;
    } catch (e) {
      // The text stays in the editor and in `pending`; keep trying, more slowly each time.
      pending ??= text;
      saveError = (e as Error).message;
      saveTries++;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, Math.min(30_000, 2_000 * 2 ** (saveTries - 1)));
    }
  }

  let saveError = $state<string | null>(null);
  let saveTries = 0;

  let statsTimer: ReturnType<typeof setTimeout> | undefined;

  /** Word and character counts for the status bar, ignoring frontmatter. */
  function count(text: string, board: boolean) {
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
    app.noteStats = {
      words: body.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0,
      chars: body.length,
      cards: board ? (body.match(/^[-*+] \[[ xX]\]/gm)?.length ?? 0) : null,
      backlinks: backlinks.length,
      encrypted: path.endsWith(".age"),
    };
  }

  function onChange(text: string) {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => count(text, boardText !== null), 250);
    pending = text;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  function onBoardChange(text: string) {
    boardText = text;
    onChange(text);
  }

  async function load(p: string) {
    await save();
    error = null;
    locked = false;
    title = titleOf(p);
    loadedPath = p;
    cursorPlaced = false;
    let text = "";
    try {
      text = await api.noteRead(p);
    } catch (e) {
      if (codeOf(e) === "locked") locked = true;
      else error = (e as Error).message;
      view?.destroy();
      view = null;
      return;
    }
    if (loadedPath !== p) return;
    backlinks = await api.backlinks(p).catch(() => []);
    count(text, isBoard(text) && !showSource);
    if (isBoard(text) && !showSource) {
      view?.destroy();
      view = null;
      boardText = text;
      boardKey++;
      return;
    }
    boardText = null;
    const state = EditorState.create({
      doc: text,
      extensions: extensions({
        getTitles: () => app.titles,
        onOpenLink: (target) => void app.follow(target),
        onTag: (tag) => app.showTag(tag),
        onChange,
        getPath: () => loadedPath ?? path,
        onFiles: addFiles,
      }),
    });
    if (view) view.setState(state);
    else view = new EditorView({ state, parent: host });
    pending = null;
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
    if (pending !== null) return;
    void (async () => {
      const text = await api.noteRead(loadedPath!).catch(() => null);
      if (text === null) {
        app.current = null;
        return;
      }
      if (boardText !== null && pending === null && text !== boardText) {
        boardText = text;
        boardKey++;
        return;
      }
      if (view && text !== view.state.doc.toString() && pending === null) {
        const sel = view.state.selection.main.head;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: Math.min(sel, text.length) },
        });
        pending = null;
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
      app.openSettings("encryption");
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
    pending = null;
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
      <button class="back" onclick={() => (app.current = null)} aria-label="Back to notes">
        <ChevronLeft size={22} /><span>Notes</span>
      </button>
    {/if}
    <span class="spacer"></span>
    {#if encrypted}
      <span class="badge" title="Stored encrypted on GitHub and on this device"><Lock size={14} /> Encrypted</span>
    {/if}
    <Menu label="Note actions">
      {#if boardText !== null || showSource}
        <button role="menuitem" onclick={async () => { await save(); showSource = !showSource; await load(path); }}>
          {#if showSource}<Columns3 size={16} /> Show as board{:else}<Code size={16} /> Edit as Markdown{/if}
        </button>
      {/if}
      {#if boardText === null && !locked && !error}
        <button role="menuitem" onclick={pickImages}><ImagePlus size={16} /> Add image</button>
        <button role="menuitem" onclick={insertTemplate}><LayoutTemplate size={16} /> Insert template</button>
      {/if}
      <button role="menuitem" onclick={async () => { await save(); app.showGraph(true); }}><Network size={16} /> Show in graph</button>
      <button role="menuitem" onclick={toggleEncryption}>
        {#if encrypted}<LockOpen size={16} /> Decrypt note{:else}<Lock size={16} /> Encrypt note{/if}
      </button>
      <button role="menuitem" class="danger" onclick={trash}><Trash2 size={16} /> Move to trash</button>
    </Menu>
  </header>

  <div class="page" class:wide={boardText !== null}>
    <div class="column">
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
    {#if saveError}
      <div class="save-error" role="alert">
        <p>Couldn't save. {saveError} Your text is safe here, and Wandika keeps trying.</p>
        <button class="btn" onclick={save}>Try again</button>
      </div>
    {/if}

    {#if locked}
      <Unlock onunlocked={() => load(path)} />
    {/if}

    {#if boardText !== null}
      {#key boardKey}
        <Board {path} text={boardText} onchange={onBoardChange} />
      {/key}
    {/if}

    <div
      class="cm-host"
      class:writing
      bind:this={host}
      hidden={locked || !!error || boardText !== null}
      onfocusin={() => {
        writing = compact;
        cursorPlaced = true;
      }}
      onfocusout={() => (writing = false)}
    ></div>

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
  </div>
  <input
    bind:this={picker}
    type="file"
    accept="image/*"
    multiple
    hidden
    onchange={(e) => {
      const input = e.currentTarget as HTMLInputElement;
      const files = [...(input.files ?? [])];
      input.value = "";
      if (files.length && view) void addFiles(files, view, pickAt);
    }}
  />
  {#if writing}
    <KeyboardBar view={() => view} onImage={pickImages} />
  {/if}
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
  /* Room for the writing toolbar, so the last line can scroll above it. */
  .cm-host.writing {
    padding-bottom: 64px;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-height: var(--target);
    padding: 0 8px 0 0;
    border: 0;
    background: none;
    color: var(--graphite);
    font-size: calc(16px * var(--text-scale));
  }
  .back:active {
    opacity: 0.5;
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
  /* One column sized in the note font, so the title, text and backlinks share the same edges
     whatever font, size or line width is chosen in Settings. */
  .column {
    max-width: var(--measure);
    margin: 0 auto;
    font-family: var(--font-note);
    font-size: var(--note-size);
  }
  .page.wide .column {
    max-width: none;
    font-family: var(--font-ui);
    font-size: var(--ui-size);
  }
  .column > :global(.error),
  .column > :global(.unlock) {
    font-family: var(--font-ui);
    font-size: var(--ui-size);
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
    font-family: var(--font-ui);
    font-size: var(--ui-size);
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
  .save-error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin: 0 0 12px;
    padding: 10px 14px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--alarm) 10%, transparent);
    color: var(--ink);
    font-size: var(--small);
  }
  .save-error p {
    flex: 1 1 16em;
    margin: 0;
  }
</style>
