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
      <div class="buttons">
        <button type="button" class="btn" onclick={() => app.dialog?.resolve(null)}>Cancel</button>
        <button class="btn" class:primary={!app.dialog.danger} class:danger-fill={app.dialog.danger}>
          {app.dialog.confirm}
        </button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  dialog {
    width: min(420px, calc(100vw - 32px));
    padding: 22px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-lg);
    background: var(--sheet);
    color: var(--ink);
    box-shadow: 0 24px 60px rgb(0 0 0 / 0.2);
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.35);
  }
  form {
    display: grid;
    gap: 14px;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
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
  .danger-fill {
    background: var(--alarm);
    border-color: var(--alarm);
    color: var(--sheet);
  }
</style>
