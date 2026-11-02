<script lang="ts">
  import { Lock } from "@lucide/svelte";
  import { api } from "../api";
  import { app } from "../app.svelte";

  let { onunlocked }: { onunlocked?: () => void } = $props();
  let passphrase = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  const setUp = $derived(app.status?.encryption?.set_up ?? false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await (setUp ? api.encryptionUnlock(passphrase) : api.encryptionSetup(passphrase));
      passphrase = "";
      await app.refreshStatus();
      await app.refreshFiles();
      onunlocked?.();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<form class="unlock" onsubmit={submit}>
  <p class="lead"><Lock size={18} /> {setUp ? "This note is encrypted." : "Set up encryption for this vault."}</p>
  <p class="muted">
    {setUp
      ? "Enter your vault passphrase. This device remembers it in the keychain until you lock it."
      : "Choose a passphrase of at least 8 characters. Wandika can't recover it if you forget it."}
  </p>
  <label class="sr-only" for="passphrase">Passphrase</label>
  <input
    id="passphrase"
    class="field"
    type="password"
    autocomplete={setUp ? "current-password" : "new-password"}
    bind:value={passphrase}
    placeholder="Passphrase"
  />
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button class="btn primary" disabled={busy || passphrase.length < 8}>
    {busy ? (setUp ? "Unlocking…" : "Setting up…") : setUp ? "Unlock" : "Set up encryption"}
  </button>
</form>

<style>
  .unlock {
    display: grid;
    gap: 12px;
    max-width: 420px;
    padding: 20px 0;
  }
  .lead {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-weight: 600;
  }
  p {
    margin: 0;
  }
  .btn {
    justify-self: start;
  }
</style>
