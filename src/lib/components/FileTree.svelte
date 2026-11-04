<script lang="ts">
  import { touch } from "../tips";
  import { haptic } from "../haptics";
  import { tick, untrack } from "svelte";
  import { ChevronRight, FileText, Folder, FolderInput, FolderPlus, Lock, LockOpen, Pencil, Plus, Trash2, File, Image as ImageIcon } from "@lucide/svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import { isImage } from "../attachments";
  import type { Entry } from "../types";
  import Menu from "./Menu.svelte";
  import { focusMenuIn, isMenuKey } from "../keyboard";

  interface Node {
    entry: Entry;
    children: Node[];
  }

  const OPEN_KEY = "wandika.openFolders";
  /** Folders with thousands of files (attachment folders) list them a page at a time. */
  const PAGE = 200;
  let pages = $state(new Map<string, number>());
  const keyOf = (nodes: Node[]) => nodes[0]?.entry.path.split("/").slice(0, -1).join("/") ?? "";
  const shown = (nodes: Node[]) => (pages.get(keyOf(nodes)) ?? 1) * PAGE;
  const moreLabel = (left: number) => (left > PAGE ? `Show ${PAGE} more of ${left}` : `Show ${left} more`);
  function showMore(nodes: Node[]) {
    const k = keyOf(nodes);
    pages = new Map(pages).set(k, (pages.get(k) ?? 1) + 1);
  }
  let openFolders = $state<Set<string>>(load());
  let renaming = $state<string | null>(null);
  /** Row whose menu is open from a touch and hold, as on iOS and Android. */
  let pressedMenu = $state<string | null>(null);
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressStart = { x: 0, y: 0 };
  let swallowClick = false;

  function pressDown(e: PointerEvent, path: string) {
    // A hold that ended without a click (the menu took it, or the finger slid off) mustn't eat
    // the next tap on another row.
    swallowClick = false;
    if (e.pointerType !== "touch") return;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressedMenu = path;
      swallowClick = true;
      haptic("selection");
    }, 450);
  }

  function pressMove(e: PointerEvent) {
    if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 8) clearTimeout(pressTimer);
  }

  function pressEnd() {
    clearTimeout(pressTimer);
  }
  let renameValue = $state("");

  function load() {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]"));
    } catch {
      return new Set<string>();
    }
  }

  /** Up and Down move between rows; Right opens a folder and Left closes it, as in Finder. */
  function treeKey(e: KeyboardEvent) {
    const at = (e.target as HTMLElement).closest<HTMLElement>("button.item");
    if (!at || !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const rows = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("button.item")];
    const i = rows.indexOf(at);
    const path = at.dataset.path!;
    e.preventDefault();
    if (e.key === "ArrowDown") rows[i + 1]?.focus();
    else if (e.key === "ArrowUp") rows[i - 1]?.focus();
    else if (at.dataset.kind === "folder" && (e.key === "ArrowRight") !== openFolders.has(path)) toggle(path);
    // Left on a note, or on a folder already closed, goes to the folder it's in, as in Finder.
    else if (e.key === "ArrowLeft" && path.includes("/")) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      rows.find((r) => r.dataset.path === parent)?.focus();
    }
  }

  function toggle(path: string) {
    const next = new Set(openFolders);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    openFolders = next;
    save();
  }

  function save() {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...openFolders]));
    } catch {
      /* private mode: folders just start closed */
    }
  }

  const roots = $derived.by(() => {
    const byPath = new Map<string, Node>();
    const top: Node[] = [];
    for (const entry of app.tree) {
      const node = { entry, children: [] };
      byPath.set(entry.path, node);
      const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
      (parent ? byPath.get(parent)?.children : top)?.push(node);
    }
    const sort = (nodes: Node[]) => {
      nodes.sort(
        (a, b) =>
          Number(b.entry.kind === "folder") - Number(a.entry.kind === "folder") ||
          a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true, sensitivity: "base" }),
      );
      nodes.forEach((n) => sort(n.children));
      return nodes;
    };
    return sort(top);
  });

  // Reveal the open note inside its folders, once each time a note opens. It mustn't watch the
  // open folders too, or closing the folder that holds the open note would reopen it at once.
  $effect(() => {
    const c = app.current;
    if (!c || !c.includes("/")) return;
    const parts = c.split("/").slice(0, -1);
    const needed = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    untrack(() => {
      if (!needed.every((p) => openFolders.has(p))) {
        openFolders = new Set([...openFolders, ...needed]);
        save();
      }
    });
    // Bring the open note's row into view, e.g. after opening it from search.
    void tick().then(() => document.querySelector(".tree .row.current")?.scrollIntoView({ block: "nearest" }));
  });

  async function newFolder(parent: string) {
    const path = await app.newFolder(parent);
    if (path && !openFolders.has(path)) toggle(path);
  }

  function startRename(e: Entry) {
    renaming = e.path;
    renameValue = e.name.replace(/\.age$/, "");
  }

  async function commitRename(e: Entry) {
    // Escape already ended the rename; the blur as the field leaves the page must not save it.
    if (renaming !== e.path) return;
    const name = renameValue.trim();
    renaming = null;
    if (!name || name === e.name) return focusRow(e.path);
    try {
      await app.flush();
      const to = await api.entryRename(e.path, name);
      // A renamed folder stays open, and so do the folders inside it.
      if (e.kind === "folder") {
        openFolders = new Set([...openFolders].map((p) => (p === e.path ? to : p.startsWith(e.path + "/") ? to + p.slice(e.path.length) : p)));
        save();
      }
      if (app.current === e.path) app.current = to;
      else if (app.current?.startsWith(e.path + "/")) app.current = to + app.current.slice(e.path.length);
      await app.refreshFiles();
      app.edited();
      focusRow(to);
    } catch (err) {
      app.say((err as Error).message);
      focusRow(e.path);
    }
  }

  /** After a rename, the keyboard stays on the row, under its new name. */
  function focusRow(path: string) {
    void tick().then(() => document.querySelector<HTMLElement>(`.tree button.item[data-path="${CSS.escape(path)}"]`)?.focus());
  }

  /** Moves a row into a folder picked from a list, the keyboard's way to do what dragging would. */
  async function moveEntry(e: Entry) {
    const here = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
    const inside = (p: string) => e.kind === "folder" && (p === e.path || p.startsWith(`${e.path}/`));
    const folders = app.tree.filter((x) => x.kind === "folder" && x.path !== here && !inside(x.path)).map((x) => x.path);
    const choices = [...(here ? [{ label: "Top of the vault", value: "/" }] : []), ...folders.map((p) => ({ label: p, value: p }))];
    if (!choices.length) return app.say("There's no other folder to move it to. Make one with New folder.");
    const pick = await app.ask({ title: `Move “${e.name.replace(/\.md(\.age)?$/, "")}” to`, confirm: "", choices });
    if (!pick) return;
    try {
      await app.flush();
      const to = await api.entryMove(e.path, pick === "/" ? "" : pick);
      if (app.current === e.path) app.current = to;
      else if (app.current?.startsWith(e.path + "/")) app.current = to + app.current.slice(e.path.length);
      if (pick !== "/" && !openFolders.has(pick)) toggle(pick);
      await app.refreshFiles();
      app.edited();
      app.say(`Moved to ${pick === "/" ? "the top of the vault" : pick}.`);
    } catch (err) {
      app.say((err as Error).message);
    }
  }

  async function encrypt(e: Entry, on: boolean) {
    const enc = app.status?.encryption;
    if (!enc?.set_up || !enc.unlocked) {
      app.openSettings("encryption");
      app.say(enc?.set_up ? "Unlock encrypted notes first." : "Set up encryption in Settings first.");
      return;
    }
    try {
      await app.flush();
      const to = await api.setEncrypted(e.path, on);
      if (app.current === e.path) app.current = to;
      await app.refreshStatus();
      await app.refreshFiles();
      app.edited();
      app.say(e.kind === "folder" ? (on ? "Folder encrypted. New notes in it are encrypted too." : "Folder decrypted.") : on ? "Note encrypted." : "Note decrypted.");
    } catch (err) {
      app.say((err as Error).message);
    }
  }

  const trash = (e: Entry) => app.trash(e.path, e.name, e.kind === "folder");

  const folderEncrypted = (path: string) => app.status?.encryption?.folders.includes(path) ?? false;
</script>

{#snippet branch(nodes: Node[], depth: number)}
  <ul role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Notes" : undefined}>
    {#each nodes.slice(0, shown(nodes)) as node (node.entry.path)}
      {@const e = node.entry}
      {@const isOpen = openFolders.has(e.path)}
      <li role="treeitem" aria-expanded={e.kind === "folder" ? isOpen : undefined} aria-selected={app.current === e.path}>
        <div class="row" class:current={app.current === e.path} style="--depth: {depth}">
          {#if renaming === e.path}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="rename"
              bind:value={renameValue}
              autofocus
              onblur={() => commitRename(e)}
              onkeydown={(ev) => {
                if (ev.key === "Enter") (ev.currentTarget as HTMLInputElement).blur();
                if (ev.key === "Escape") {
                  renaming = null;
                  focusRow(e.path);
                }
              }}
              aria-label="New name"
            />
          {:else}
            <button
              class="item"
              data-path={e.path}
              data-kind={e.kind}
              onclick={() => {
                // The tap that ends a touch and hold opens the menu, not the note.
                if (swallowClick) return void (swallowClick = false);
                if (e.kind === "folder") toggle(e.path);
                else if (e.kind === "note") app.open(e.path);
                else if (isImage(e.path.replace(/\.age$/, ""))) app.viewing = e.path;
              }}
              onpointerdown={(ev) => pressDown(ev, e.path)}
              onpointermove={pressMove}
              onpointerup={pressEnd}
              onpointercancel={pressEnd}
              onkeydown={(ev) => {
                if (!isMenuKey(ev)) return;
                ev.preventDefault();
                pressedMenu = e.path;
                focusMenuIn((ev.currentTarget as HTMLElement).closest(".row"));
              }}
              oncontextmenu={(ev) => {
                ev.preventDefault();
                // A right-click or two-finger click opens the row's menu, as in Finder. Touch has
                // its own press and hold.
                if (!touch) pressedMenu = e.path;
              }}
              aria-disabled={e.kind === "file" && !isImage(e.path.replace(/\.age$/, "")) ? true : undefined}
            >
              {#if e.kind === "folder"}
                <span class="chev" class:open={isOpen}><ChevronRight size={14} /></span>
                <Folder size={15} />
              {:else if e.kind === "note"}
                <span class="chev"></span>
                <FileText size={15} />
              {:else}
                <span class="chev"></span>
                {#if isImage(e.path.replace(/\.age$/, ""))}<ImageIcon size={15} />{:else}<File size={15} />{/if}
              {/if}
              <span class="name">{e.name}</span>
              {#if e.encrypted || (e.kind === "folder" && folderEncrypted(e.path))}
                <Lock size={12} aria-label="Encrypted" />
              {/if}
            </button>
            <span class="actions">
                <Menu
                  label={`Actions for ${e.name}`}
                  size={16}
                  bind:open={() => pressedMenu === e.path, (v) => (pressedMenu = v ? e.path : pressedMenu === e.path ? null : pressedMenu)}
                >
                  {#if e.kind === "folder"}
                    <button role="menuitem" onclick={() => app.newNote(e.path)}><Plus size={16} /> New note here</button>
                    <button role="menuitem" onclick={() => newFolder(e.path)}><FolderPlus size={16} /> New folder here</button>
                  {/if}
                  <button role="menuitem" onclick={() => startRename(e)}><Pencil size={16} /> Rename</button>
                  <button role="menuitem" onclick={() => moveEntry(e)}><FolderInput size={16} /> Move to…</button>
                  {#if e.kind !== "file"}
                    {#if e.kind === "folder" ? folderEncrypted(e.path) : e.encrypted}
                      <button role="menuitem" onclick={() => encrypt(e, false)}><LockOpen size={16} /> Decrypt</button>
                    {:else}
                      <button role="menuitem" onclick={() => encrypt(e, true)}><Lock size={16} /> Encrypt</button>
                    {/if}
                  {/if}
                  <button role="menuitem" class="danger" onclick={() => trash(e)}><Trash2 size={16} /> Move to trash</button>
                </Menu>
              </span>
          {/if}
        </div>
        {#if e.kind === "folder" && isOpen}
          {@render branch(node.children, depth + 1)}
        {/if}
      </li>
    {/each}
    {#if nodes.length > shown(nodes)}
      <li role="none">
        <button class="more" style="--depth: {depth}" onclick={() => showMore(nodes)}>
          {moreLabel(nodes.length - shown(nodes))}
        </button>
      </li>
    {/if}
  </ul>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<nav class="tree" onkeydown={treeKey}>
  <button class="new-folder" onclick={() => newFolder("")}><FolderPlus size={15} /> New folder</button>
  {#if app.tree.length}
    {@render branch(roots, 0)}
  {:else}
    <p class="muted empty">No notes yet. Create one with the + button.</p>
  {/if}
</nav>

<style>
  .tree {
    padding: 4px 8px 16px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
  }
  .row:focus-within {
    background: var(--papyrus-wash);
  }
  @media (hover: hover) {
    .row:hover {
      background: var(--papyrus-wash);
    }
  }
  .row.current {
    background: var(--papyrus-selected);
  }
  .row.current .name {
    color: var(--ink);
    font-weight: 600;
  }
  .item {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 6px 0 calc(4px + var(--depth) * 14px);
    border: 0;
    background: none;
    color: var(--graphite);
    text-align: left;
  }
  .item:disabled {
    cursor: default;
    opacity: 0.7;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ink);
  }
  .chev {
    display: inline-grid;
    width: 14px;
    transition: transform var(--dur-instant) var(--ease-out);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .actions {
    opacity: 0;
  }
  .row:focus-within .actions {
    opacity: 1;
  }
  @media (hover: hover) {
    .row:hover .actions {
      opacity: 1;
    }
  }
  /* Phones: rows are full-height targets and actions come from touch and hold, so the ⋯ buttons
     stay out of the way (they still open with a pointer). */
  @media (pointer: coarse) {
    .item {
      min-height: var(--target);
    }
    .actions {
      opacity: 1;
      width: 0;
      overflow: visible;
    }
    .actions :global(.trigger) {
      display: none;
    }
    /* An iPad with a keyboard: the ⋯ button comes back for keyboard focus (⇧F10 opens it too). */
    .row:has(:focus-visible) .actions :global(.trigger) {
      display: inline-flex;
    }
    .row:active {
      background: var(--papyrus-wash);
    }
  }
  .rename {
    flex: 1;
    margin: 2px 4px 2px calc(24px + var(--depth) * 14px);
    min-height: 30px;
    border: 1px solid var(--papyrus);
    border-radius: var(--radius-sm);
    background: var(--sheet);
    padding: 0 8px;
  }
  .empty {
    padding: 8px 10px;
    margin: 0;
  }
  .more {
    display: block;
    min-height: 32px;
    padding: 0 10px 0 calc(4px + var(--depth) * 14px + 20px);
    border: 0;
    background: none;
    color: var(--graphite);
    font-size: var(--small);
  }
  .new-folder {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    min-height: 32px;
    padding: 0 10px;
    border: 0;
    background: none;
    color: var(--graphite);
    font-size: var(--small);
  }
  /* Phones create folders from the Notes menu. */
  @media (max-width: 899px) {
    .new-folder {
      display: none;
    }
  }
  @media (hover: hover) {
    .new-folder:hover {
      color: var(--ink);
    }
  }
</style>
