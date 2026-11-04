<script lang="ts">
  import { clock } from "../clock.svelte";
  import { tick } from "svelte";
  import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, FilePlus, Pencil, Plus, Trash2, CircleCheck, X } from "@lucide/svelte";
  import { api } from "../api";
  import { app, titleOf } from "../app.svelte";
  import { newCard, newLane, parse, serialize, tagsOf, tokens, type Card, type Lane } from "../kanban";
  import Menu from "./Menu.svelte";

  let { path, text, onchange }: { path: string; text: string; onchange: (text: string) => void } = $props();

  // svelte-ignore state_referenced_locally
  let board = $state(parse(text));
  let filter = $state<string | null>(null);
  let editing = $state<string | null>(null);
  let draft = $state("");
  let adding = $state<string | null>(null);
  let newText = $state("");
  let dragging = $state<{ card: string; from: string } | null>(null);
  let dropAt = $state<{ lane: string; index: number } | null>(null);

  const allTags = $derived([...new Set(board.lanes.flatMap((l) => l.cards.flatMap((c) => tagsOf(c.text))))].sort());
  // A tag no card carries any more (its last card was deleted or edited) stops filtering.
  $effect(() => {
    if (filter && !allTags.includes(filter)) filter = null;
  });
  const visible = (c: Card) => !filter || tagsOf(c.text).includes(filter);
  const today = $derived(clock.today);

  function commit() {
    onchange(serialize($state.snapshot(board)));
  }

  function due(text: string) {
    return /📅\s?(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
  }

  function display(text: string) {
    return text.replace(/\s*📅\s?\d{4}-\d{2}-\d{2}/, "").replace(/\s*✅ \d{4}-\d{2}-\d{2}/, "");
  }

  /** The card's first line as read aloud: links by their label, no date. */
  function plain(text: string) {
    return tokens(display(text).split("\n")[0])
      .map((t) => (t.kind === "link" ? t.label : t.kind === "tag" ? `#${t.tag}` : t.text))
      .join("")
      .trim();
  }

  /** After an edit ends, the keyboard lands back on what it was about, not on the page. */
  function refocus(selector: string) {
    void tick().then(() => document.querySelector<HTMLElement>(selector)?.focus());
  }

  function startEdit(c: Card) {
    editing = c.id;
    draft = c.text;
  }

  function finishEdit(lane: Lane, c: Card) {
    if (editing !== c.id) return;
    editing = null;
    const t = draft.trim();
    if (!t) lane.cards = lane.cards.filter((x) => x.id !== c.id);
    else c.text = t;
    commit();
    refocus(t ? `[data-card-id="${c.id}"] .trigger` : `[data-lane="${lane.id}"] .add`);
  }

  function addCard(lane: Lane) {
    const t = newText.trim();
    if (t) {
      const c = newCard(t);
      c.done = lane.complete;
      lane.cards.push(c);
      commit();
    }
    newText = "";
  }

  function move(cardId: string, fromId: string, toId: string, index?: number) {
    const from = board.lanes.find((l) => l.id === fromId);
    const to = board.lanes.find((l) => l.id === toId);
    if (!from || !to) return;
    const i = from.cards.findIndex((c) => c.id === cardId);
    if (i < 0) return;
    const [card] = from.cards.splice(i, 1);
    let at = index ?? to.cards.length;
    if (from === to && i < at) at -= 1;
    if (to.complete !== from.complete) card.done = to.complete;
    to.cards.splice(Math.max(0, Math.min(at, to.cards.length)), 0, card);
    commit();
  }

  /** Swaps a column with the one beside it. */
  function shiftLane(lane: Lane, by: -1 | 1) {
    const i = board.lanes.indexOf(lane);
    const j = i + by;
    if (i < 0 || j < 0 || j >= board.lanes.length) return;
    [board.lanes[i], board.lanes[j]] = [board.lanes[j], board.lanes[i]];
    commit();
  }

  /** A card's first line, for messages; long ones are cut. */
  const named = (text: string) => {
    const first = text.split("\n")[0].replace(/\[\[([^\]|]+)(\|([^\]]*))?\]\]/g, (_, a, __, b) => b || a).trim();
    return first.length > 40 ? `${first.slice(0, 39).trimEnd()}…` : first;
  };

  function remove(lane: Lane, c: Card) {
    const at = lane.cards.findIndex((x) => x.id === c.id);
    lane.cards = lane.cards.filter((x) => x.id !== c.id);
    commit();
    app.say(`Deleted “${named(c.text)}”.`, {
      label: "Undo",
      run: () => {
        const back = board.lanes.find((l) => l.id === lane.id);
        if (!back) return;
        back.cards.splice(Math.min(at, back.cards.length), 0, c);
        commit();
      },
    });
  }

  /** Turns a card into its own note and links the card to it, so the work has room to grow. */
  async function toNote(c: Card) {
    const title = c.text
      .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, "$1")
      .replace(/(^|\s)#[A-Za-z][\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}/-]*/gu, "")
      .replace(/📅\s?\d{4}-\d{2}-\d{2}/, "")
      .split("\n")[0]
      .trim()
      .slice(0, 80);
    if (!title) return;
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const tags = tagsOf(c.text).map((t) => `#${t}`).join(" ");
    try {
      const notePath = await api.noteCreate(folder, title, `Board: [[${titleOf(path)}]]${tags ? ` ${tags}` : ""}\n\n`);
      c.text = `[[${titleOf(notePath)}]]${tags ? ` ${tags}` : ""}${due(c.text) ? ` 📅 ${due(c.text)}` : ""}`;
      commit();
      await app.refreshFiles();
      app.say(`Created “${titleOf(notePath)}” and linked the card to it.`);
    } catch (e) {
      app.say((e as Error).message);
    }
  }

  async function renameLane(lane: Lane) {
    const name = await app.ask({ title: "Rename column", confirm: "Rename", input: { label: "Column name", value: lane.title } });
    if (name?.trim()) {
      lane.title = name.trim();
      commit();
    }
  }

  async function removeLane(lane: Lane) {
    // Text written in the column (not a card) goes with it too, so that is asked about as well.
    const n = lane.cards.length;
    if (n || lane.notes?.length) {
      const what = n ? `its ${n} ${n === 1 ? "card" : "cards"}${lane.notes?.length ? " and text" : ""}` : "the text in it";
      const ok = await app.ask({
        title: `Delete “${lane.title}” and ${what}?`,
        confirm: "Delete column",
        danger: true,
      });
      if (ok === null) return;
    }
    const at = board.lanes.findIndex((l) => l.id === lane.id);
    board.lanes = board.lanes.filter((l) => l.id !== lane.id);
    commit();
    app.say(`Deleted “${lane.title}”.`, {
      label: "Undo",
      run: () => {
        board.lanes.splice(Math.min(at, board.lanes.length), 0, lane);
        commit();
      },
    });
  }

  async function addLane() {
    const name = await app.ask({ title: "New column", confirm: "Add column", input: { label: "Column name", value: "" } });
    if (name?.trim()) {
      board.lanes.push(newLane(name.trim()));
      commit();
    }
  }

  function toggleComplete(lane: Lane) {
    lane.complete = !lane.complete;
    for (const c of lane.cards) c.done = lane.complete;
    commit();
  }

  function onDragOver(e: DragEvent, lane: Lane) {
    if (!dragging) return;
    e.preventDefault();
    const cards = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[data-card]")];
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        index = Number(cards[i].dataset.index);
        break;
      }
    }
    dropAt = { lane: lane.id, index };
  }

  function onDrop(e: DragEvent, lane: Lane) {
    e.preventDefault();
    if (dragging && dropAt) move(dragging.card, dragging.from, lane.id, dropAt.index);
    dragging = null;
    dropAt = null;
  }
</script>

<div class="board">
  {#if allTags.length}
    <div class="filters" role="toolbar" aria-label="Filter cards by tag">
      <button class="chip" class:on={!filter} onclick={() => (filter = null)}>All cards</button>
      {#each allTags as t (t)}
        <button class="chip" class:on={filter === t} aria-pressed={filter === t} onclick={() => (filter = filter === t ? null : t)}>#{t}</button>
      {/each}
    </div>
  {/if}

  <div class="lanes">
    {#each board.lanes as lane (lane.id)}
      <section
        class="lane"
        data-lane={lane.id}
        class:target={dropAt?.lane === lane.id}
        aria-label={lane.title}
        ondragover={(e) => onDragOver(e, lane)}
        ondrop={(e) => onDrop(e, lane)}
        ondragleave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropAt = null;
        }}
      >
        <header>
          <h3>{lane.title}</h3>
          <span class="count">{lane.cards.length}</span>
          {#if lane.complete}<CircleCheck size={15} aria-label="Cards here are marked done" />{/if}
          <span class="grow"></span>
          <Menu label={`Actions for column ${lane.title}`} size={16}>
            <button role="menuitem" onclick={() => renameLane(lane)}><Pencil size={16} /> Rename column</button>
            {#if board.lanes.indexOf(lane) > 0}
              <button role="menuitem" onclick={() => shiftLane(lane, -1)}><ArrowLeft size={16} /> Move left</button>
            {/if}
            {#if board.lanes.indexOf(lane) < board.lanes.length - 1}
              <button role="menuitem" onclick={() => shiftLane(lane, 1)}><ArrowRight size={16} /> Move right</button>
            {/if}
            <button role="menuitem" onclick={() => toggleComplete(lane)}>
              <CircleCheck size={16} />
              {lane.complete ? "Stop marking cards done" : "Mark cards here as done"}
            </button>
            <button role="menuitem" class="danger" onclick={() => removeLane(lane)}><Trash2 size={16} /> Delete column</button>
          </Menu>
        </header>

        <ol class="cards">
          {#each lane.cards as card, index (card.id)}
            {#if visible(card)}
              {#if dropAt?.lane === lane.id && dropAt.index === index && dragging?.card !== card.id}
                <li class="drop-line" aria-hidden="true"></li>
              {/if}
              <li
                class="card"
                data-card-id={card.id}
                class:done={card.done}
                class:dragging={dragging?.card === card.id}
                data-card
                data-index={index}
                draggable={editing !== card.id}
                ondragstart={(e) => {
                  dragging = { card: card.id, from: lane.id };
                  e.dataTransfer?.setData("text/plain", card.text);
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                ondragend={() => {
                  dragging = null;
                  dropAt = null;
                }}
              >
                {#if editing === card.id}
                  <!-- svelte-ignore a11y_autofocus -->
                  <textarea
                    class="edit"
                    bind:value={draft}
                    autofocus
                    rows="3"
                    aria-label="Card text"
                    onblur={() => finishEdit(lane, card)}
                    onkeydown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        (e.currentTarget as HTMLTextAreaElement).blur();
                      }
                      if (e.key === "Escape") {
                        editing = null;
                        refocus(`[data-card-id="${card.id}"] .trigger`);
                      }
                    }}
                  ></textarea>
                {:else}
                  <div class="card-top">
                    <input
                      type="checkbox"
                      checked={card.done}
                      aria-label={card.done ? "Mark as not done" : "Mark as done"}
                      onchange={() => {
                        card.done = !card.done;
                        commit();
                      }}
                    />
                    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                    <div class="text" onclick={(e) => {
                      if (!(e.target as HTMLElement).closest("button")) startEdit(card);
                    }}>
                      {#each tokens(display(card.text)) as t, ti (ti)}
                        {#if t.kind === "link"}
                          <button class="link" onclick={() => app.follow(t.target)}>{t.label}</button>
                        {:else if t.kind === "tag"}
                          <button class="tag" onclick={() => (filter = t.tag)}>#{t.tag}</button>
                        {:else}
                          {t.text}
                        {/if}
                      {/each}
                    </div>
                    <Menu label={`Actions for ${plain(card.text)}`} size={16}>
                      <button role="menuitem" onclick={() => startEdit(card)}><Pencil size={16} /> Edit card</button>
                      {#if !/^\[\[[^\]]+\]\]/.test(card.text)}
                        <button role="menuitem" onclick={() => toNote(card)}><FilePlus size={16} /> Make into a note</button>
                      {/if}
                      <!-- The keyboard's way to reorder, besides dragging. -->
                      {#if index > 0}
                        <button role="menuitem" onclick={() => move(card.id, lane.id, lane.id, index - 1)}><ArrowUp size={16} /> Move up</button>
                      {/if}
                      {#if index < lane.cards.length - 1}
                        <button role="menuitem" onclick={() => move(card.id, lane.id, lane.id, index + 2)}><ArrowDown size={16} /> Move down</button>
                      {/if}
                      {#each board.lanes.filter((l) => l.id !== lane.id) as other (other.id)}
                        <button role="menuitem" onclick={() => move(card.id, lane.id, other.id)}><ArrowRight size={16} /> Move to {other.title}</button>
                      {/each}
                      <button role="menuitem" class="danger" onclick={() => remove(lane, card)}><Trash2 size={16} /> Delete card</button>
                    </Menu>
                  </div>
                  {#if due(card.text)}
                    {@const d = due(card.text)!}
                    <span class="due" class:today={d === today} class:late={d < today && !card.done}>
                      {d === today ? "Due today" : d < today && !card.done ? `Overdue, ${d}` : `Due ${d}`}
                    </span>
                  {/if}
                {/if}
              </li>
            {/if}
          {/each}
          {#if dropAt?.lane === lane.id && dropAt.index >= lane.cards.length}
            <li class="drop-line" aria-hidden="true"></li>
          {/if}
        </ol>

        {#if adding === lane.id}
          <form
            class="add-form"
            onsubmit={(e) => {
              e.preventDefault();
              addCard(lane);
            }}
          >
            <!-- svelte-ignore a11y_autofocus -->
            <textarea
              bind:value={newText}
              autofocus
              rows="2"
              placeholder="Card text. Use [[ ]] to link a note and # for tags."
              aria-label="New card"
              onkeydown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  addCard(lane);
                }
                if (e.key === "Escape") {
                  adding = null;
                  refocus(`[data-lane="${lane.id}"] .add`);
                }
              }}
            ></textarea>
            <div class="add-actions">
              <button class="btn primary">Add card</button>
              <button
                type="button"
                class="icon-btn"
                aria-label="Stop adding cards"
                onclick={() => {
                  adding = null;
                  refocus(`[data-lane="${lane.id}"] .add`);
                }}><X size={18} /></button>
            </div>
          </form>
        {:else}
          <button class="add" onclick={() => { adding = lane.id; newText = ""; }}><Plus size={16} /> Add a card</button>
        {/if}
      </section>
    {/each}
    <button class="add-lane" onclick={addLane}><Plus size={16} /> Add a column</button>
  </div>
</div>

<style>
  .board {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .lanes {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    overflow-x: auto;
    padding-bottom: 16px;
    scroll-snap-type: x proximity;
    -webkit-overflow-scrolling: touch;
  }
  .lane {
    flex: 0 0 min(300px, 84vw);
    scroll-snap-align: start;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-radius: var(--radius);
    background: var(--paper);
  }
  .lane.target {
    box-shadow: inset 0 0 0 2px var(--papyrus);
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 4px;
    color: var(--graphite);
  }
  h3 {
    margin: 0;
    font-size: var(--ui-size);
    font-weight: 600;
    color: var(--ink);
  }
  .count {
    font-size: var(--small);
    font-variant-numeric: tabular-nums;
  }
  .grow {
    flex: 1;
  }
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
    min-height: 8px;
  }
  .card {
    padding: 10px;
    border-radius: var(--radius-sm);
    background: var(--sheet);
    border: 1px solid var(--rule);
    cursor: grab;
  }
  .card.dragging {
    opacity: 0.4;
  }
  .card-top {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .card-top input {
    margin-top: 4px;
    accent-color: var(--papyrus);
    flex: none;
  }
  .card-top :global(.menu .trigger) {
    width: 28px;
    height: 28px;
    margin: -4px -4px 0 0;
  }
  @media (pointer: coarse) {
    .card-top :global(.menu .trigger) {
      width: var(--target);
      height: var(--target);
      margin: -12px -12px -8px 0;
    }
  }
  .text {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    cursor: text;
  }
  .done .text {
    color: var(--graphite);
    text-decoration: line-through;
  }
  .link,
  .tag {
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
  }
  .link {
    color: var(--papyrus);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .tag {
    color: var(--papyrus);
    font-size: 0.88em;
    font-weight: 500;
  }
  .due {
    display: block;
    margin: 6px 0 0 24px;
    font-size: var(--small);
    color: var(--graphite);
  }
  .due.today {
    color: var(--amber);
    font-weight: 600;
  }
  .due.late {
    color: var(--alarm);
  }
  .drop-line {
    height: 3px;
    border-radius: var(--radius-xs);
    background: var(--papyrus);
  }
  .edit,
  .add-form textarea {
    width: 100%;
    resize: vertical;
    padding: 8px;
    border: 1px solid var(--papyrus);
    border-radius: var(--radius-sm);
    background: var(--sheet);
    line-height: 1.4;
  }
  .edit:focus,
  .add-form textarea:focus {
    outline: none;
    box-shadow: 0 0 0 3px var(--papyrus-wash);
  }
  .add-form {
    display: grid;
    gap: 6px;
  }
  .add-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .add,
  .add-lane {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    padding: 0 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--graphite);
  }
  @media (hover: hover) {
    .add:hover,
    .add-lane:hover {
      background: var(--papyrus-wash);
      color: var(--ink);
    }
  }
  .add-lane {
    flex: 0 0 auto;
    padding: 0 12px;
    background: var(--paper);
  }
  @media (pointer: coarse) {
    .add,
    .add-lane {
      min-height: var(--target);
    }
  }
</style>
