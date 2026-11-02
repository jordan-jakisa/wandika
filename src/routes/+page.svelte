<script lang="ts">
  import { app } from "$lib/app.svelte";
  import Dialog from "$lib/components/Dialog.svelte";
  import Settings from "$lib/components/Settings.svelte";
  import Start from "$lib/components/Start.svelte";
  import Workspace from "$lib/components/Workspace.svelte";
  import { prefs } from "$lib/prefs.svelte";
  import { onMount } from "svelte";

  // Before the first screen draws, so it opens in the chosen colours.
  prefs.apply();

  onMount(() => {
    void app.init();
  });
</script>

{#if app.bootError}
  <main class="boot">
    <p class="error" role="alert">Wandika couldn't start: {app.bootError}</p>
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

{#if app.toast}
  <div class="toast" role="status">{app.toast}</div>
{/if}

<style>
  .boot {
    min-height: 100dvh;
    display: grid;
    place-content: center;
    gap: 12px;
    padding: 24px;
  }
  .toast {
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
