<script lang="ts">
  import { HardDrive, RefreshCw } from "@lucide/svelte";
  import { ago, app } from "../app.svelte";

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const offline = $derived(app.syncError?.startsWith("No connection") ?? false);
  const text = $derived(
    app.syncing
      ? "Syncing…"
      : offline
        ? "Offline. Changes are saved here."
        : app.syncError
          ? "Sync failed"
          : `Synced ${ago(app.lastSync, now)}`,
  );
</script>

{#if !app.synced}
  <button class="sync" onclick={() => (app.openSettings("vault"))} title="Connect this vault to GitHub in Settings">
    <span class="icon"><HardDrive size={13} /></span>
    <span>On this device only</span>
  </button>
{:else}
<button
  class="sync"
  class:warn={offline}
  class:fail={app.syncError && !offline}
  onclick={() => app.sync()}
  disabled={app.syncing}
  title={app.syncError ?? "Sync now"}
  aria-label={`${text}. Sync now`}
>
  <span class="icon" class:spin={app.syncing}><RefreshCw size={13} /></span>
  <span>{text}</span>
</button>
{/if}

<style>
  .sync {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: none;
    padding: 2px 0;
    font-size: var(--small);
    color: var(--graphite);
    text-align: left;
  }
  .sync:hover:not(:disabled) {
    color: var(--ink);
  }
  .sync:disabled {
    cursor: default;
  }
  .warn {
    color: var(--amber);
  }
  .fail {
    color: var(--alarm);
  }
  .icon {
    display: inline-grid;
  }
  .spin {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
