<script lang="ts">
  import { PenLine, X } from "@lucide/svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";
  import { sheetOpened } from "../backstack";
  import { closeSheet } from "../motion";
  import { forgetImages, imageUrl } from "../attachments";
  import { MARK } from "../sketch";

  /** An image from the vault, shown full size over everything else. */
  let dialogEl: HTMLDialogElement;
  /** Gives back the sheet's place in history when it closes (phones). */
  let release = () => {};
  let src = $state<string | null>(null);
  let failed = $state(false);
  let loaded = $state(false);
  /** A drawing made in Wandika can go back to the drawing pad. */
  let drawing = $state(false);
  const name = $derived(app.viewing?.split("/").pop()?.replace(/\.age$/, "") ?? "");

  $effect(() => {
    const path = app.viewing;
    if (path && !dialogEl.open) {
      src = null;
      failed = false;
      loaded = false;
      drawing = false;
      if (/\.svg(\.age)?$/i.test(path))
        api.attachmentRead(path, "").then(
          (buf) => app.viewing === path && (drawing = new TextDecoder().decode(buf).includes(MARK)),
          () => {},
        );
      imageUrl(path, "").then(
        (url) => app.viewing === path && (src = url),
        () => app.viewing === path && (failed = true),
      );
      dialogEl.showModal();
      release = sheetOpened(() => (app.viewing = null));
    } else if (!path && dialogEl.open) {
      closeSheet(dialogEl);
      release();
      release = () => {};
    }
  });

  /** Syncs, then reads the picture again. */
  async function retry() {
    const path = app.viewing;
    if (!path) return;
    await app.sync(true);
    forgetImages();
    failed = false;
    imageUrl(path, "").then(
      (url) => app.viewing === path && (src = url),
      () => app.viewing === path && (failed = true),
    );
  }
</script>

<dialog
  bind:this={dialogEl}
  class="viewer"
  aria-label={name}
  onclose={() => (app.viewing = null)}
  oncancel={(e) => {
    e.preventDefault();
    app.viewing = null;
  }}
  onclick={(e) => e.target === dialogEl && (app.viewing = null)}
>
  <header>
    <span class="name">{name}</span>
    {#if drawing}
      <button
        class="btn quiet"
        onclick={() => {
          const target = app.viewing!;
          app.viewing = null;
          app.drawing = { note: "", edit: { target, from: "" } };
        }}><PenLine size={18} /> Edit drawing</button
      >
    {/if}
    <button class="icon-btn" onclick={() => (app.viewing = null)} aria-label="Close"><X size={22} /></button>
  </header>
  <div class="stage">
    {#if failed}
      <div class="failed">
        <p class="muted">This image hasn't arrived yet, or it was moved.</p>
        {#if app.synced}
          <button class="btn" onclick={retry}>Sync and try again</button>
        {/if}
      </div>
    {:else if src}
      <img {src} alt={name} class:shown={loaded} onload={() => (loaded = true)} />
    {/if}
  </div>
</dialog>

<style>
  .viewer[open] {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100dvh;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    border: 0;
    background: #000;
    color: #fff;
  }
  .viewer[open] {
    animation: fade-in var(--dur-quick) var(--ease-out);
  }
  .viewer::backdrop {
    background: transparent;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 52px;
    padding: 0 8px 0 20px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-md);
  }
  .icon-btn {
    color: #fff;
  }
  .stage {
    flex: 1;
    display: grid;
    place-items: center;
    min-height: 0;
    padding: 8px 16px 24px;
  }
  img {
    opacity: 0;
    transition: opacity var(--dur-quick) var(--ease-out);
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .muted {
    color: rgb(255 255 255 / 0.7);
  }
  img.shown {
    opacity: 1;
  }
  .failed {
    display: grid;
    justify-items: center;
    gap: var(--space-3);
  }
</style>
