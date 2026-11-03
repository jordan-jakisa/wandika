<script lang="ts">
  import { app } from "$lib/app.svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import ImageViewer from "$lib/components/ImageViewer.svelte";
  import Sketch from "$lib/components/Sketch.svelte";
  import FocusSession from "$lib/components/FocusSession.svelte";
  import MailReader from "$lib/components/MailReader.svelte";
  import TaskEditor from "$lib/components/TaskEditor.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import Start from "$lib/components/Start.svelte";
  import Workspace from "$lib/components/Workspace.svelte";
  import "$lib/platform";
  import { prefs } from "$lib/prefs.svelte";
  import { onMount } from "svelte";

  let toastEl = $state<HTMLDivElement>();
  // The bar lives in the top layer, above any open dialog, so its words and Undo stay readable
  // and clickable. Each new message raises it again, over a dialog opened since.
  // It stays open (invisible between messages), so screen readers keep the live region.
  $effect(() => {
    if (!toastEl) return;
    if (typeof toastEl.showPopover !== "function") return void toastEl.removeAttribute("popover");
    try {
      toastEl.showPopover();
    } catch {
      toastEl.removeAttribute("popover");
    }
  });
  $effect(() => {
    if (!app.toast || !toastEl?.hasAttribute("popover")) return;
    try {
      toastEl.hidePopover();
      toastEl.showPopover();
    } catch {
      /* already gone from the page */
    }
  });
  let lastToast = $state("");
  let lastAction = $state<string | null>(null);
  $effect(() => {
    if (!app.toast) return;
    lastToast = app.toast;
    lastAction = app.toastAction?.label ?? null;
  });

  // Before the first screen draws, so it opens in the chosen colours.
  prefs.apply();

  onMount(() => {
    void app.init();
  });
</script>

{#if app.bootError}
  <main class="boot">
    <p class="error" role="alert">Wandika couldn't open your vault. {app.bootError}</p>
    <button class="btn" onclick={() => location.reload()}>Try again</button>
  </main>
{:else if !app.status}
  <main class="boot" aria-busy="true"></main>
{:else if !app.status.vault}
  <Start />
{:else}
  <Workspace />
  <Settings />
{/if}

<Dialog />
<ImageViewer />
<Sketch />
<MailReader />
<TaskEditor />
<FocusSession />

<!-- Always in the page, so screen readers announce each new message. The last message stays
     drawn while the bar fades, so it fades with its words. -->
<div class="toast" class:shown={!!app.toast} role="status" aria-live="polite" popover="manual" bind:this={toastEl}>
  <span>{app.toast ?? lastToast}</span>
  {#if lastAction}
    <button
      class="toast-action"
      tabindex={app.toast ? 0 : -1}
      disabled={!app.toast}
      onclick={() => {
        const run = app.toastAction?.run;
        app.toast = null;
        app.toastAction = null;
        run?.();
      }}>{lastAction}</button
    >
  {/if}
</div>

<style>
  .boot {
    min-height: 100dvh;
    display: grid;
    place-content: center;
    gap: 12px;
    padding: 24px;
  }
  /* Empty and invisible between messages, but still in the accessibility tree. */
  .toast:not(.shown) {
    opacity: 0;
    translate: 0 4px;
    pointer-events: none;
  }
  .toast-action {
    margin-left: var(--space-3);
    padding: var(--space-1) var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .toast {
    inset: auto;
    margin: 0;
    border: 0;
    overflow: visible;
    display: flex;
    align-items: center;
    justify-content: space-between;
    transition:
      opacity var(--dur-quick) var(--ease-out),
      translate var(--dur-quick) var(--ease-out);
    position: fixed;
    left: 50%;
    bottom: calc(76px + var(--safe-bottom));
    transform: translateX(-50%);
    max-width: calc(100vw - 32px);
    padding: 10px 16px;
    border-radius: var(--radius);
    background: var(--ink);
    color: var(--paper);
    font-size: var(--small);
    z-index: 50;
  }
  @media (min-width: 900px) {
    .toast {
      bottom: 24px;
    }
  }
</style>
