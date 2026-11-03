<script lang="ts">
  import { Pin, Timer } from "@lucide/svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import { clock } from "../clock.svelte";
  import { focus } from "../focus.svelte";
  import { isIOS } from "../platform";
  import { PRIORITIES, composeTask, parseTask, type Priority } from "../taskText";

  /** Edits one task from the vault: its name and tags, due date, priority, pin and notes.
   *  Everything is written back into the note, in the Obsidian Tasks format. */
  let dialogEl: HTMLDialogElement;
  let name = $state("");
  let due = $state("");
  let priority = $state<Priority | "">("");
  let pinned = $state(false);
  let details = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);

  const task = $derived(app.editingTask);
  /** On iPhone a form sheet from the bottom, as iOS edits an item; elsewhere a centred dialog. */
  const ios = isIOS;
  let start = { name: "", due: "", priority: "" as Priority | "", pinned: false, details: "" };
  const dirty = $derived(
    name !== start.name || due !== start.due || priority !== start.priority || pinned !== start.pinned || details !== start.details,
  );

  $effect(() => {
    const t = app.editingTask;
    if (t && !dialogEl.open) {
      const p = parseTask(t.text);
      name = p.name;
      due = p.due ?? "";
      priority = p.priority ?? "";
      pinned = p.pinned;
      details = t.details;
      start = { name, due, priority, pinned, details };
      dragY = 0;
      error = null;
      dialogEl.showModal();
    } else if (!t && dialogEl.open) {
      dialogEl.close();
    }
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    const t = app.editingTask;
    if (!t) return;
    if (!name.trim()) {
      error = "Give the task a name.";
      return;
    }
    const text = composeTask(t.text, { name, due: due || null, priority: priority || null, pinned });
    saving = true;
    try {
      await api.taskEdit(t.path, t.line, t.text, text, details);
      app.edited();
      app.changed = { paths: [t.path], at: Date.now() };
      app.editingTask = null;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      saving = false;
    }
  }

  // The sheet follows a drag down from its top bar and closes past a point, unless there are
  // unsaved changes: then it springs back, and Cancel is the way out (HIG, Sheets).
  let dragY = $state(0);
  let dragFrom: number | null = null;
  function sheetDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    dragFrom = e.clientY;
  }
  function sheetMove(e: PointerEvent) {
    if (dragFrom !== null) dragY = Math.max(0, e.clientY - dragFrom);
  }
  function sheetUp() {
    if (dragFrom === null) return;
    dragFrom = null;
    if (dragY > 120 && !dirty) app.editingTask = null;
    dragY = 0;
  }

  function startFocus() {
    const t = app.editingTask;
    if (!t) return;
    app.editingTask = null;
    focus.start({ text: name || parseTask(t.text).name, task: t });
  }
</script>

{#snippet nameField()}
  <label class="block">
    <span>Task</span>
    <input class="field" bind:value={name} placeholder="What needs doing? Add #tags" />
  </label>
{/snippet}
{#snippet dueField()}
  <label class="block">
    <span>Due</span>
    <input class="field date" type="date" bind:value={due} />
  </label>
{/snippet}
{#snippet quickDates()}
  <div class="quick">
    <button type="button" class="chip" class:on={due === clock.today} onclick={() => (due = clock.today)}>Today</button>
    <button type="button" class="chip" class:on={due === clock.tomorrow} onclick={() => (due = clock.tomorrow)}>Tomorrow</button>
    {#if due}<button type="button" class="link-btn" onclick={() => (due = "")}>No date</button>{/if}
  </div>
{/snippet}
{#snippet priorityField()}
  <label class="block">
    <span>Priority</span>
    <select class="field" bind:value={priority}>
      <option value="">None</option>
      {#each PRIORITIES as p (p.value)}
        <option value={p.value}>{p.label}</option>
      {/each}
    </select>
  </label>
{/snippet}
{#snippet pinField()}
  <label class="check">
    <input type="checkbox" class:toggle={ios} bind:checked={pinned} />
    <span class="check-text"><Pin size={16} /> Pin to the top of Tasks</span>
  </label>
{/snippet}
{#snippet notesField()}
  <label class="block">
    <span>Notes</span>
    <textarea class="field" rows="4" bind:value={details} placeholder="Links, steps, anything that helps"></textarea>
  </label>
{/snippet}

<dialog
  bind:this={dialogEl}
  class="editor"
  class:ios
  class:dragging={dragY > 0}
  style={dragY ? `--drag: ${dragY}px` : undefined}
  aria-labelledby="task-editor-h"
  onclose={() => (app.editingTask = null)}
  onclick={(e) => e.target === dialogEl && (app.editingTask = null)}
>
  {#if task && ios}
    <form onsubmit={save}>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <header class="bar" onpointerdown={sheetDown} onpointermove={sheetMove} onpointerup={sheetUp} onpointercancel={sheetUp}>
        <span class="grabber" aria-hidden="true"></span>
        <button type="button" class="bar-btn" onclick={() => (app.editingTask = null)}>Cancel</button>
        <h2 id="task-editor-h">Edit task</h2>
        <button class="bar-btn save" disabled={saving}>Save</button>
      </header>
      <div class="groups">
        <div class="group">{@render nameField()}</div>
        <div class="group">
          {@render dueField()}
          {@render quickDates()}
          {@render priorityField()}
          {@render pinField()}
        </div>
        <div class="group">{@render notesField()}</div>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if !task.done}
          <div class="group">
            <button type="button" class="row-btn" onclick={startFocus}><Timer size={18} /> Focus</button>
          </div>
        {/if}
      </div>
    </form>
  {:else if task}
    <form onsubmit={save}>
      <h2 id="task-editor-h">Edit task</h2>
      {@render nameField()}
      <div class="pair">
        <div class="due">
          {@render dueField()}
          {@render quickDates()}
        </div>
        {@render priorityField()}
      </div>
      {@render pinField()}
      {@render notesField()}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="buttons">
        {#if !task.done}
          <button type="button" class="btn quiet" onclick={startFocus}><Timer size={16} /> Focus</button>
        {/if}
        <span class="spacer"></span>
        <button type="button" class="btn" onclick={() => (app.editingTask = null)}>Cancel</button>
        <button class="btn primary" disabled={saving}>Save</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  .editor {
    width: min(480px, calc(100vw - 32px));
    padding: var(--space-6);
    border: 1px solid var(--rule);
    border-radius: var(--radius-lg);
    background: var(--sheet);
    color: var(--ink);
    box-shadow: var(--shadow-modal);
  }
  .editor[open] {
    animation: pop-in var(--dur-quick) var(--ease-out);
  }
  .editor::backdrop {
    background: var(--scrim);
  }
  form {
    display: grid;
    gap: var(--space-4);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
  }
  .block {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .block > span {
    font-size: var(--small);
    color: var(--graphite);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }
  @media (max-width: 420px) {
    .pair {
      grid-template-columns: 1fr;
    }
  }
  .due {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }
  .quick {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  /* A date field fills its column instead of keeping the browser's own width. */
  .date {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  textarea.field {
    padding: 10px 14px;
    resize: vertical;
    line-height: 1.5;
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--target);
    cursor: pointer;
  }
  .check input:not(.toggle) {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--papyrus);
  }
  .check-text {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .error {
    margin: 0;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .spacer {
    flex: 1;
  }
  /* iPhone: a form sheet. Paper behind, grouped rows on the sheet colour, Cancel and Save in the
     top bar, a grabber, labels on the left and values on the right of each row. */
  .editor.ios {
    width: 100%;
    max-width: 100%;
    /* The large detent: an edit sheet needs its full height, as Mail's compose sheet does. */
    height: calc(100dvh - var(--safe-top) - 12px);
    max-height: none;
    margin: auto 0 0;
    padding: 0 0 calc(var(--space-5) + var(--safe-bottom));
    border: 0;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    background: var(--paper);
    box-shadow: none;
    overflow-y: auto;
    transform: translateY(var(--drag, 0));
    transition: transform var(--dur-base) var(--ease-sheet);
  }
  .editor.ios.dragging {
    transition: none;
  }
  .editor.ios[open] {
    animation: sheet-up var(--dur-slow) var(--ease-sheet);
  }
  @keyframes sheet-up {
    from {
      transform: translateY(100%);
    }
  }
  .ios form {
    gap: 0;
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 14px 8px 6px;
    background: var(--paper);
    touch-action: none;
  }
  .grabber {
    position: absolute;
    top: 5px;
    left: 50%;
    width: 36px;
    height: 5px;
    margin-left: -18px;
    border-radius: var(--radius-xs);
    background: color-mix(in srgb, var(--graphite) 45%, transparent);
  }
  .ios h2 {
    grid-column: 2;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .bar-btn {
    min-height: var(--target);
    padding: 0 var(--space-2);
    border: 0;
    background: none;
    color: var(--papyrus);
    font-size: var(--text-md);
    justify-self: start;
  }
  .bar-btn.save {
    grid-column: 3;
    justify-self: end;
    font-weight: 600;
  }
  .bar-btn:active {
    opacity: 0.5;
  }
  .bar-btn:disabled {
    opacity: 0.4;
  }
  .groups {
    display: grid;
    gap: var(--space-6);
    padding: var(--space-2) var(--space-4) 0;
  }
  .ios .group {
    border-radius: var(--radius-xl);
    background: var(--sheet);
    overflow: hidden;
  }
  .ios .group > * + * {
    box-shadow: inset 16px 0 0 var(--sheet), inset 0 1px 0 var(--hairline);
  }
  .ios .block,
  .ios .check,
  .ios .quick,
  .ios .row-btn {
    min-height: var(--target);
    padding: 6px 16px;
  }
  .ios .block {
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: var(--space-3);
  }
  .ios .block > span {
    font-size: var(--text-md);
    color: var(--ink);
  }
  .ios .field {
    min-height: 0;
    padding: 6px 0;
    border: 0;
    border-radius: 0;
    background: none;
    font-size: var(--text-md);
  }
  .ios input.field:not(.date) {
    text-align: left;
  }
  /* The task's name is the row: no label beside it, the field takes the width. */
  .ios .group:first-child .block {
    grid-template-columns: 1fr;
  }
  .ios .group:first-child .block > span {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .ios .date,
  .ios select.field {
    justify-self: end;
    width: auto;
    -webkit-appearance: none;
    appearance: none;
    color: var(--papyrus);
    text-align: right;
    text-align-last: right;
  }
  .ios .quick {
    padding-block: 8px;
  }
  .ios .check {
    justify-content: space-between;
    flex-direction: row-reverse;
  }
  .ios .check-text {
    font-size: var(--text-md);
  }
  .ios .check-text :global(svg) {
    display: none;
  }
  .ios textarea.field {
    padding: 4px 0 8px;
    resize: none;
  }
  .ios .group:nth-child(3) .block {
    grid-template-columns: 1fr;
    gap: 2px;
    padding-top: 10px;
  }
  .ios .group:nth-child(3) .block > span {
    font-size: var(--text-sm);
    color: var(--graphite);
  }
  .row-btn {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    border: 0;
    background: none;
    color: var(--papyrus);
    font-size: var(--text-md);
    text-align: left;
  }
  .row-btn:active {
    background: var(--press);
  }
  .ios .error {
    padding: 0 16px;
  }
  @media (prefers-reduced-motion: reduce) {
    .editor.ios[open] {
      animation: none;
    }
  }
</style>
