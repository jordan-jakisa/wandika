<script lang="ts">
  import { app, type Ask } from "../app.svelte";
  import { sheetOpened } from "../backstack";
  import { closeSheet } from "../motion";

  let dialogEl: HTMLDialogElement;
  /** Gives back the sheet's place in history when it closes (phones). */
  let release = () => {};
  let value = $state("");
  /** The question on screen; it stays while the dialog fades, after it is answered. */
  let shown = $state<Ask | null>(null);
  /** The question the field was filled for; a new one replacing it while open starts afresh. */
  let filledFor: Ask | null = null;

  $effect(() => {
    const d = app.dialog;
    if (d && d !== filledFor) value = d.input?.value ?? "";
    filledFor = d;
    if (d) shown = d;
    if (d && dialogEl.classList.contains("closing")) dialogEl.classList.remove("closing");
    if (d && !dialogEl.open) {
      dialogEl.showModal();
      release = sheetOpened(() => app.dialog?.resolve(null));
    } else if (!d && dialogEl.open) {
      closeSheet(dialogEl, () => !app.dialog && (shown = null));
      release();
      release = () => {};
    }
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const d = app.dialog;
    if (!d) return;
    if (d.input && !value.trim()) return;
    d.resolve(d.input ? value : "");
  }
</script>

<dialog
  bind:this={dialogEl}
  oncancel={(e) => {
    // Esc leaves the way Cancel does, with its fade.
    e.preventDefault();
    app.dialog?.resolve(null);
  }}
  aria-labelledby="dialog-title"
>
  {#if shown}
    <form onsubmit={submit}>
      <h2 id="dialog-title">{shown.title}</h2>
      {#if shown.message}<p class="muted">{shown.message}</p>{/if}
      {#if shown.input}
        <label for="dialog-input" class="sr-only">{shown.input.label}</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input id="dialog-input" class="field" bind:value placeholder={shown.input.label} autofocus />
      {/if}
      {#if shown.choices}
        <ul class="choices">
          {#each shown.choices as c (c.value)}
            <li><button type="button" onclick={() => app.dialog?.resolve(c.value)}>{c.label}</button></li>
          {/each}
        </ul>
      {/if}
      <div class="buttons" class:single={!!shown.choices}>
        <button type="button" class="btn" onclick={() => app.dialog?.resolve(null)}>{shown.cancel ?? "Cancel"}</button>
        {#if !shown.choices}
          <button class="btn primary" class:danger={shown.danger}>
            {shown.confirm}
          </button>
        {/if}
      </div>
    </form>
  {/if}
</dialog>

<style>
  dialog {
    width: min(420px, calc(100vw - 32px));
    padding: 20px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-lg);
    background: var(--sheet);
    color: var(--ink);
    box-shadow: var(--shadow-modal);
  }
  dialog[open] {
    animation: pop-in var(--dur-quick) var(--ease-out);
  }
  dialog::backdrop {
    background: var(--scrim);
  }
  form {
    display: grid;
    gap: 14px;
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    line-height: 1.35;
  }
  p {
    margin: -6px 0 0;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }
  .choices {
    list-style: none;
    margin: 0 -8px;
    padding: 0;
    max-height: 50dvh;
    overflow-y: auto;
  }
  .choices button {
    width: 100%;
    min-height: var(--target);
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
  }
  .choices button:active {
    background: color-mix(in srgb, var(--ink) 8%, transparent);
  }
  @media (hover: hover) {
    .choices button:hover {
      background: color-mix(in srgb, var(--ink) 6%, transparent);
    }
  }
</style>
