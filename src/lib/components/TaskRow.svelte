<script module lang="ts">
  /** Only one row shows its swipe actions at a time: opening one closes the last. */
  let closeOpen: (() => void) | null = null;
</script>

<script lang="ts">
  import { Archive, Mail, Pencil, Pin, PinOff, Timer, Trash2 } from "@lucide/svelte";
  import { app } from "../app.svelte";
  import { mailRef } from "../mailLinks";
  import { plainText } from "../plain";
  import { parseTask, PRIORITIES } from "../taskText";
  import Menu from "./Menu.svelte";
  import { clock } from "../clock.svelte";
  import { duration } from "../motion";
  let {
    text,
    done,
    due = null,
    where,
    onToggle,
    onOpen,
    onEdit,
    onPin,
    onFocus,
    onArchive,
    onDelete,
    details = "",
    leaves = false,
  }: {
    text: string;
    done: boolean;
    due?: string | null;
    where: string;
    onToggle: () => Promise<void>;
    onOpen?: () => void;
    /** Opens the task editor (vault tasks). */
    onEdit?: () => void;
    /** Pins or unpins the task (vault tasks). */
    onPin?: () => Promise<void>;
    /** Starts a focus session on the task. */
    onFocus?: () => void;
    /** Moves the task to the archive note (vault tasks). */
    onArchive?: () => void;
    /** Deletes the task and its notes (vault tasks). */
    onDelete?: () => void;
    /** The notes under the task; the first line shows under it. */
    details?: string;
    /** The list hides done tasks: a ticked one shows its strike-through, then folds away. */
    leaves?: boolean;
  } = $props();
  let leaving = $state(false);

  let busy = $state(false);
  /** Ticks at once; a failed change puts the box back and says why. */
  let shown = $state<boolean | null>(null);
  const checked = $derived(shown ?? done);
  const today = $derived(clock.today);
  const overdue = $derived(!!due && due < today && !done);
  const parts = $derived(parseTask(text));
  const urgent = $derived(parts.priority === "highest" || parts.priority === "high");
  const priorityLabel = $derived(PRIORITIES.find((p) => p.value === parts.priority)?.label);
  const firstNote = $derived(details.split("\n")[0] ?? "");
  /** A task made from an email links back to it; the email opens in Wandika. */
  const email = $derived([...text.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]).find((u) => mailRef(u)));
  // Plain words for the list: markers move to the meta line, the email link to "Open email", Markdown marks go.
  const label = $derived(
    plainText(parts.name.replace(/\s*\[[^\]]*\]\((https?:[^)\s]+)\)/g, (all, url: string) => (mailRef(url) ? "" : all))),
  );

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function toggle() {
    busy = true;
    shown = !checked;
    if (shown) (navigator as { vibrate?: (ms: number) => boolean }).vibrate?.(10);
    try {
      if (shown && leaves) {
        // A moment to see it done; a pause, not motion, so it stays with reduced motion too.
        await wait(600);
        leaving = true;
        await wait(duration("--dur-base"));
      }
      await onToggle();
    } catch (e) {
      shown = null;
      leaving = false;
      app.taskFailed(e, undefined, "Couldn't tick that task.");
    } finally {
      busy = false;
    }
  }
  // Swipe on touch screens: right shows Pin, left shows Archive and Delete; a long swipe left deletes.
  const ACTION = 76;
  const lead = $derived(onPin ? ACTION : 0);
  const trail = $derived((onArchive ? ACTION : 0) + (onDelete ? ACTION : 0));
  let rowEl: HTMLLIElement;
  let offset = $state(0);
  let dragging = $state(false);
  let drag: { x: number; y: number; from: number; id: number; sideways: boolean | null } | null = null;
  let past = $state(false);
  const full = () => rowEl.clientWidth * 0.6;

  function close() {
    offset = 0;
    if (closeOpen === close) closeOpen = null;
  }
  function settle(to: number) {
    offset = to;
    if (to !== 0) {
      if (closeOpen && closeOpen !== close) closeOpen();
      closeOpen = close;
    } else if (closeOpen === close) closeOpen = null;
  }
  function down(e: PointerEvent) {
    if (e.pointerType !== "touch" || (!lead && !trail) || busy) return;
    drag = { x: e.clientX, y: e.clientY, from: offset, id: e.pointerId, sideways: null };
    past = false;
  }
  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.sideways === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      drag.sideways = Math.abs(dx) > Math.abs(dy);
      if (!drag.sideways) return void (drag = null);
      rowEl.setPointerCapture?.(e.pointerId);
      dragging = true;
    }
    const next = Math.max(trail ? -rowEl.clientWidth : 0, Math.min(lead ? rowEl.clientWidth : 0, drag.from + dx));
    const beyond = next < -full() && !!onDelete;
    if (beyond !== past) {
      past = beyond;
      if (beyond) (navigator as { vibrate?: (ms: number) => boolean }).vibrate?.(10);
    }
    offset = next;
  }
  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const sideways = drag.sideways;
    drag = null;
    dragging = false;
    if (!sideways) return;
    if (offset < -full() && onDelete) return run(onDelete);
    if (offset > full() && onPin) return run(pinIt);
    settle(offset < -trail / 2 ? -trail : offset > lead / 2 ? lead : 0);
  }
  /** A tap on an open row closes it instead of opening the task. */
  function tapWhileOpen(e: MouseEvent) {
    if (offset === 0) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  function run(action: () => void) {
    close();
    action();
  }
  const pinIt = () => void onPin?.().catch((e) => app.taskFailed(e));

  // Once the list reloads with the new state, the row follows it again.
  $effect(() => {
    void done;
    shown = null;
  });
</script>

<li
  class="task"
  class:done={checked}
  class:leaving
  class:pinned={parts.pinned}
  class:swiped={dragging || offset !== 0}
  bind:this={rowEl}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
>
  {#if lead && offset > 0}
    <div class="swipe lead" style:width="{offset}px" aria-hidden="true">
      <button class="act pin" tabindex="-1" onclick={() => run(pinIt)}>
        {#if parts.pinned}<PinOff size={20} />Unpin{:else}<Pin size={20} />Pin{/if}
      </button>
    </div>
  {/if}
  {#if trail && offset < 0}
    <div class="swipe trail" style:width="{-offset}px" aria-hidden="true">
      {#if onArchive}<button class="act archive" tabindex="-1" onclick={() => run(onArchive)}><Archive size={20} />Archive</button>{/if}
      {#if onDelete}<button class="act delete" class:full={past} tabindex="-1" onclick={() => run(onDelete)}><Trash2 size={20} />Delete</button>{/if}
    </div>
  {/if}
  <div class="slide" class:dragging class:moved={dragging || offset !== 0} style:transform={offset ? `translateX(${offset}px)` : null} onclickcapture={tapWhileOpen}>
    <label class="box"><input type="checkbox" {checked} disabled={busy} onchange={toggle} aria-label={label} /></label>
    <div class="body">
      {#if onEdit}
        <button class="text edit" onclick={onEdit}>{#if parts.pinned}<Pin size={14} aria-label="Pinned" />{/if}{label}</button>
      {:else}
        <span class="text">{#if parts.pinned}<Pin size={14} aria-label="Pinned" />{/if}{label}</span>
      {/if}
      {#if firstNote}<span class="note">{firstNote}</span>{/if}
      <span class="meta">
        {#if priorityLabel}<span class:urgent>{priorityLabel} priority</span>{/if}
        {#if email}<button class="where" onclick={() => app.openLink(email)}>Open email</button>{/if}
        {#if due}<span class:overdue class:due-today={due === today}>{due === today ? "Today" : overdue ? `Overdue, ${due}` : due}</span>{/if}
        {#if onOpen}
          <button class="where" onclick={onOpen}>{where}</button>
        {:else}
          <span>{where}</span>
        {/if}
      </span>
    </div>
    {#if onEdit || onPin || onFocus || onArchive || onDelete}
      <span class="actions">
        <Menu label={`Actions for ${label}`} size={16}>
          {#if onEdit}<button role="menuitem" onclick={onEdit}><Pencil size={18} /> Edit</button>{/if}
          {#if onPin}
            <button role="menuitem" onclick={pinIt}>
              {#if parts.pinned}<PinOff size={18} /> Unpin{:else}<Pin size={18} /> Pin to top{/if}
            </button>
          {/if}
          {#if onFocus && !checked}<button role="menuitem" onclick={onFocus}><Timer size={18} /> Focus on this</button>{/if}
          {#if email}<button role="menuitem" onclick={() => app.openLink(email)}><Mail size={18} /> Open email</button>{/if}
          {#if onArchive}<button role="menuitem" onclick={onArchive}><Archive size={18} /> Archive</button>{/if}
          {#if onDelete}<button role="menuitem" class="danger" onclick={onDelete}><Trash2 size={18} /> Delete</button>{/if}
        </Menu>
      </span>
    {/if}
  </div>
</li>

<style>
  .task {
    position: relative;
    max-height: 12em;
    transition:
      max-height var(--dur-base) var(--ease-in),
      opacity var(--dur-base) var(--ease-in),
      padding var(--dur-base) var(--ease-in);
    /* Vertical scrolling stays the browser's; a sideways drag is the swipe. */
    touch-action: pan-y;
  }
  /* Clipped only while swiped: the ⋯ menu opens outside the row. */
  .task.swiped {
    overflow: hidden;
  }
  .slide {
    position: relative;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 8px 0;
    transition: transform var(--dur-base) var(--ease-out);
  }
  /* Opaque only while it slides, so the actions stay hidden behind it. Phones show lists on paper. */
  .slide.moved {
    background: var(--paper);
  }
  .slide.dragging {
    transition: none;
  }
  .swipe {
    position: absolute;
    inset-block: 0;
    display: flex;
    overflow: hidden;
  }
  .swipe.lead {
    left: 0;
  }
  .swipe.trail {
    right: 0;
    justify-content: flex-end;
  }
  .act {
    flex: 1 0 76px;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 4px;
    min-width: 76px;
    border: 0;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--sheet);
  }
  .act.pin {
    background: var(--papyrus);
    color: var(--on-papyrus);
  }
  .act.archive {
    background: var(--graphite);
  }
  .act.delete {
    background: var(--alarm);
  }
  /* Past the full-swipe point, Delete takes the whole width it is given. */
  .act.delete.full {
    flex-grow: 100;
  }
  input {
    width: 18px;
    height: 18px;
    margin: 2px 0 0;
    accent-color: var(--papyrus);
    flex: none;
  }
  .box {
    position: relative;
    display: flex;
    flex: none;
  }
  @media (pointer: coarse) {
    input {
      width: 22px;
      height: 22px;
    }
    /* A 44px tap area around the box, the box itself stays small. */
    .box::after {
      content: "";
      position: absolute;
      inset: -11px;
    }
  }
  .body {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 1px;
    overflow-wrap: anywhere;
  }
  .text {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
  }
  .text :global(svg) {
    flex: none;
    align-self: center;
    color: var(--papyrus);
  }
  .edit {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    overflow-wrap: anywhere;
  }
  @media (hover: hover) {
    .edit:hover {
      color: var(--papyrus);
    }
  }
  .note {
    font-size: var(--small);
    color: var(--graphite);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .urgent {
    color: var(--alarm);
  }
  .actions {
    margin-left: auto;
    flex: none;
  }
  .done .text {
    color: var(--graphite);
    text-decoration: line-through;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0 10px;
    font-size: var(--small);
    color: var(--graphite);
  }
  .where {
    border: 0;
    background: none;
    padding: 0;
    color: var(--graphite);
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  @media (hover: hover) {
    .where:hover {
      color: var(--papyrus);
    }
  }
  .overdue {
    color: var(--alarm);
  }
  .due-today {
    color: var(--amber);
    font-weight: 600;
  }
  .leaving {
    max-height: 0;
    padding-block: 0;
    opacity: 0;
    overflow: hidden;
  }
  .text {
    transition: color var(--dur-quick) var(--ease-out);
  }
</style>
