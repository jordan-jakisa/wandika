<script lang="ts">
  import { app } from "../app.svelte";

  let dialogEl: HTMLDialogElement;
  let value = $state("");

  $effect(() => {
    const d = app.dialog;
    if (d && !dialogEl.open) {
      value = d.input?.value ?? "";
      dialogEl.showModal();
    } else if (!d && dialogEl.open) {
      dialogEl.close();
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

<dialog bind:this={dialogEl} oncancel={() => app.dialog?.resolve(null)} aria-labelledby="dialog-title">
  {#if app.dialog}
    <form onsubmit={submit}>
      <h2 id="dialog-title">{app.dialog.title}</h2>
      {#if app.dialog.message}<p class="muted">{app.dialog.message}</p>{/if}
      {#if app.dialog.input}
        <label for="dialog-input" class="sr-only">{app.dialog.input.label}</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input id="dialog-input" class="field" bind:value placeholder={app.dialog.input.label} autofocus />
      {/if}
      {#if app.dialog.choices}
        <ul class="choices">
          {#each app.dialog.choices as c (c.value)}
            <li><button type="button" onclick={() => app.dialog?.resolve(c.value)}>{c.label}</button></li>
          {/each}
        </ul>
      {/if}
      <div class="buttons" class:single={!!app.dialog.choices}>
        <button type="button" class="btn" onclick={() => app.dialog?.resolve(null)}>Cancel</button>
        {#if !app.dialog.choices}
          <button class="btn" class:primary={!app.dialog.danger} class:danger-fill={app.dialog.danger}>
            {app.dialog.confirm}
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
  .danger-fill {
    background: var(--alarm);
    border-color: var(--alarm);
    color: var(--sheet);
  }
</style>
