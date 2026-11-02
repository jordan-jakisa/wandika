<script lang="ts">
  import { ChevronRight, FileText, Folder, FolderPlus, Lock, LockOpen, Pencil, Plus, Trash2, File } from "@lucide/svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import type { Entry } from "../types";
  import Menu from "./Menu.svelte";

  interface Node {
    entry: Entry;
    children: Node[];
  }

  const OPEN_KEY = "wandika.openFolders";
  let openFolders = $state<Set<string>>(load());
  let renaming = $state<string | null>(null);
  /** Row whose menu is open from a touch and hold, as on iOS and Android. */
  let pressedMenu = $state<string | null>(null);
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressStart = { x: 0, y: 0 };
  let swallowClick = false;

  function pressDown(e: PointerEvent, path: string) {
    if (e.pointerType !== "touch") return;
    pressStart = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressedMenu = path;
      swallowClick = true;
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

  function toggle(path: string) {
    const next = new Set(openFolders);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    openFolders = next;
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
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

  // Reveal the open note inside its folders.
  $effect(() => {
    const c = app.current;
    if (!c || !c.includes("/")) return;
    const parts = c.split("/").slice(0, -1);
    const needed = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    if (needed.every((p) => openFolders.has(p))) return;
    openFolders = new Set([...openFolders, ...needed]);
  });

  async function newFolder(parent: string) {
    const name = await app.ask({ title: "New folder", confirm: "Create folder", input: { label: "Folder name", value: "" } });
    if (!name?.trim()) return;
    const path = parent ? `${parent}/${name.trim()}` : name.trim();
    await api.folderCreate(path);
    toggle(path);
    await app.newNote(path);
  }

  function startRename(e: Entry) {
    renaming = e.path;
    renameValue = e.name;
  }

  async function commitRename(e: Entry) {
    const name = renameValue.trim();
    renaming = null;
    if (!name || name === e.name) return;
    try {
      await app.flush();
      const to = await api.entryRename(e.path, name);
      if (app.current === e.path) app.current = to;
      else if (app.current?.startsWith(e.path + "/")) app.current = to + app.current.slice(e.path.length);
      await app.refreshFiles();
      app.edited();
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

  async function trash(e: Entry) {
    const what = e.kind === "folder" ? `the folder “${e.name}” and everything in it` : `“${e.name}”`;
    const ok = await app.ask({
      title: `Move ${what} to the trash?`,
      message: "You can restore it from the .trash folder in the repository.",
      confirm: "Move to trash",
      danger: true,
    });
    if (ok === null) return;
    await api.entryTrash(e.path);
    if (app.current === e.path || app.current?.startsWith(e.path + "/")) app.current = null;
    await app.refreshFiles();
    app.edited();
  }

  const folderEncrypted = (path: string) => app.status?.encryption?.folders.includes(path) ?? false;
</script>

{#snippet branch(nodes: Node[], depth: number)}
  <ul role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Notes" : undefined}>
    {#each nodes as node (node.entry.path)}
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
                if (ev.key === "Escape") renaming = null;
              }}
              aria-label="New name"
            />
          {:else}
            <button
              class="item"
              onclick={() => {
                // The tap that ends a touch and hold opens the menu, not the note.
                if (swallowClick) return void (swallowClick = false);
                if (e.kind === "folder") toggle(e.path);
                else if (e.kind === "note") app.open(e.path);
              }}
              onpointerdown={(ev) => pressDown(ev, e.path)}
              onpointermove={pressMove}
              onpointerup={pressEnd}
              onpointercancel={pressEnd}
              oncontextmenu={(ev) => ev.preventDefault()}
              disabled={e.kind === "file"}
            >
              {#if e.kind === "folder"}
                <span class="chev" class:open={isOpen}><ChevronRight size={14} /></span>
                <Folder size={15} />
              {:else if e.kind === "note"}
                <span class="chev"></span>
                <FileText size={15} />
              {:else}
                <span class="chev"></span>
                <File size={15} />
              {/if}
              <span class="name">{e.name}</span>
              {#if e.encrypted || (e.kind === "folder" && folderEncrypted(e.path))}
                <Lock size={12} aria-label="Encrypted" />
              {/if}
            </button>
            {#if e.kind !== "file"}
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
                  {#if e.kind === "folder" ? folderEncrypted(e.path) : e.encrypted}
                    <button role="menuitem" onclick={() => encrypt(e, false)}><LockOpen size={16} /> Decrypt</button>
                  {:else}
                    <button role="menuitem" onclick={() => encrypt(e, true)}><Lock size={16} /> Encrypt</button>
                  {/if}
                  <button role="menuitem" class="danger" onclick={() => trash(e)}><Trash2 size={16} /> Move to trash</button>
                </Menu>
              </span>
            {/if}
          {/if}
        </div>
        {#if e.kind === "folder" && isOpen}
          {@render branch(node.children, depth + 1)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<nav class="tree">
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
  .row:hover,
  .row:focus-within {
    background: var(--papyrus-wash);
  }
  .row.current {
    background: color-mix(in srgb, var(--papyrus) 16%, transparent);
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
    transition: transform 120ms ease-out;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .actions {
    opacity: 0;
  }
  .row:hover .actions,
  .row:focus-within .actions {
    opacity: 1;
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
  .new-folder:hover {
    color: var(--ink);
  }
</style>
