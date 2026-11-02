<script lang="ts">
  import { X } from "@lucide/svelte";
  import { app } from "../app.svelte";
  import { imageUrl } from "../attachments";

  /** An image from the vault, shown full size over everything else. */
  let dialogEl: HTMLDialogElement;
  let src = $state<string | null>(null);
  let failed = $state(false);
  let loaded = $state(false);
  const name = $derived(app.viewing?.split("/").pop()?.replace(/\.age$/, "") ?? "");

  $effect(() => {
    const path = app.viewing;
    if (path && !dialogEl.open) {
      src = null;
      failed = false;
      loaded = false;
      imageUrl(path, "").then(
        (url) => app.viewing === path && (src = url),
        () => (failed = true),
      );
      dialogEl.showModal();
    } else if (!path && dialogEl.open) {
      dialogEl.close();
    }
  });
</script>

<dialog
  bind:this={dialogEl}
  class="viewer"
  aria-label={name}
  onclose={() => (app.viewing = null)}
  onclick={(e) => e.target === dialogEl && (app.viewing = null)}
>
  <header>
    <span class="name">{name}</span>
    <button class="icon-btn" onclick={() => (app.viewing = null)} aria-label="Close"><X size={22} /></button>
  </header>
  <div class="stage">
    {#if failed}
      <p class="muted">This image couldn't be opened.</p>
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
</style>
