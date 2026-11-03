<script lang="ts">
  import { Pin, Timer } from "@lucide/svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import { clock } from "../clock.svelte";
  import { focus } from "../focus.svelte";
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

  $effect(() => {
    const t = app.editingTask;
    if (t && !dialogEl.open) {
      const p = parseTask(t.text);
      name = p.name;
      due = p.due ?? "";
      priority = p.priority ?? "";
      pinned = p.pinned;
      details = t.details;
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

  function startFocus() {
    const t = app.editingTask;
    if (!t) return;
    app.editingTask = null;
    focus.start({ text: name || parseTask(t.text).name, task: t });
  }
</script>

<dialog
  bind:this={dialogEl}
  class="editor"
  aria-labelledby="task-editor-h"
  onclose={() => (app.editingTask = null)}
  onclick={(e) => e.target === dialogEl && (app.editingTask = null)}
>
  {#if task}
    <form onsubmit={save}>
      <h2 id="task-editor-h">Edit task</h2>

      <label class="block">
        <span>Task</span>
        <input class="field" bind:value={name} placeholder="What needs doing? Add #tags" />
      </label>

      <div class="pair">
        <label class="block">
          <span>Due</span>
          <input class="field" type="date" bind:value={due} />
        </label>
        <label class="block">
          <span>Priority</span>
          <select class="field" bind:value={priority}>
            <option value="">None</option>
            {#each PRIORITIES as p (p.value)}
              <option value={p.value}>{p.label}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="quick">
        <button type="button" class="chip" class:on={due === clock.today} onclick={() => (due = clock.today)}>Today</button>
        <button type="button" class="chip" class:on={due === clock.tomorrow} onclick={() => (due = clock.tomorrow)}>Tomorrow</button>
        {#if due}<button type="button" class="link-btn" onclick={() => (due = "")}>No date</button>{/if}
      </div>

      <label class="check">
        <input type="checkbox" bind:checked={pinned} />
        <Pin size={16} /> Pin to the top of Tasks
      </label>

      <label class="block">
        <span>Notes</span>
        <textarea class="field" rows="4" bind:value={details} placeholder="Links, steps, anything that helps"></textarea>
      </label>

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
  .quick {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: calc(-1 * var(--space-2));
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
  .check input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--papyrus);
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
</style>
