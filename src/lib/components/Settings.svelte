<script lang="ts">
  import { X } from "@lucide/svelte";
  import { api, openUrl } from "../api";
  import { ago, app } from "../app.svelte";
  import type { AppleAccess } from "../types";
  import Unlock from "./Unlock.svelte";

  let dialogEl: HTMLDialogElement;
  let device = $state<{ user_code: string; verification_uri: string } | null>(null);
  let waiting = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (app.settingsOpen && !dialogEl.open) dialogEl.showModal();
    if (!app.settingsOpen && dialogEl.open) dialogEl.close();
  });

  function close() {
    clearTimeout(pollTimer);
    device = null;
    waiting = null;
    app.settingsOpen = false;
  }

  const s = $derived(app.status);
  const c = $derived(s?.connectors);
  const appleText: Record<AppleAccess, string> = {
    granted: "Allowed on this device",
    not_asked: "Not connected",
    denied: "Turned off in Settings, under Privacy",
    unsupported: "Only on iPhone and Mac",
  };

  async function connect(provider: string) {
    waiting = provider;
    try {
      const start = await api.connectorConnect(provider);
      if (start.kind === "device") {
        device = { user_code: start.user_code, verification_uri: start.verification_uri };
        const poll = async () => {
          try {
            if (await api.connectorPoll(start.device_code)) {
              device = null;
              waiting = null;
              await app.refreshStatus();
              app.say("Outlook is connected.");
              return;
            }
            pollTimer = setTimeout(poll, Math.max(start.interval, 2) * 1000);
          } catch (e) {
            device = null;
            waiting = null;
            app.say((e as Error).message);
          }
        };
        pollTimer = setTimeout(poll, start.interval * 1000);
      } else if (start.kind === "done") {
        waiting = null;
        await app.refreshStatus();
      }
      // "browser": the connectors-changed event refreshes status when Google sends us back.
    } catch (e) {
      waiting = null;
      app.say((e as Error).message);
    }
  }

  $effect(() => {
    // Google finished in the browser: stop showing "Waiting…".
    if (waiting === "google" && c?.google) waiting = null;
  });

  async function disconnect(provider: string) {
    await api.connectorDisconnect(provider);
    await app.refreshStatus();
  }

  async function copyAndOpen() {
    if (!device) return;
    await navigator.clipboard?.writeText(device.user_code).catch(() => {});
    await openUrl(device.verification_uri);
  }

  async function lock() {
    await api.encryptionLock();
    await app.refreshStatus();
    await app.refreshFiles();
    if (app.current?.endsWith(".age")) app.current = null;
  }
</script>

<dialog bind:this={dialogEl} oncancel={close} aria-labelledby="settings-title" class="settings">
  <header>
    <h2 id="settings-title">Settings</h2>
    <button class="icon-btn" onclick={close} aria-label="Close settings"><X size={20} /></button>
  </header>

  <div class="body">
    <section aria-labelledby="vault-h">
      <h3 id="vault-h">Vault</h3>
      <div class="row">
        {#if s?.user?.avatar_url}<img src={s.user.avatar_url} alt="" width="36" height="36" />{/if}
        <div class="grow">
          <div>{app.vaultName}</div>
          <div class="muted small">Signed in as {s?.user?.login}. Synced {ago(app.lastSync)}.</div>
        </div>
      </div>
      <div class="buttons">
        <button class="btn" onclick={() => app.sync()} disabled={app.syncing}>{app.syncing ? "Syncing…" : "Sync now"}</button>
        <button class="btn" onclick={() => app.switchRepo()}>Switch repository</button>
        <button class="btn danger" onclick={() => app.signOut()}>Sign out</button>
      </div>
      {#if app.syncError}<p class="error small">Last sync: {app.syncError}</p>{/if}
    </section>

    <section aria-labelledby="enc-h">
      <h3 id="enc-h">Encryption</h3>
      {#if s?.encryption?.set_up && s.encryption.unlocked}
        <p class="muted">
          Encrypted notes are unlocked on this device.
          {#if s.encryption.folders.length}Encrypted folders: {s.encryption.folders.join(", ")}.{/if}
          Encrypt a note or folder from its menu.
        </p>
        <button class="btn" onclick={lock}>Lock encrypted notes</button>
      {:else}
        <p class="muted">
          Encrypted notes are stored as age files on GitHub and on your devices. Only your passphrase opens them,
          and they also open with the age command-line tool.
        </p>
        <Unlock />
      {/if}
    </section>

    <section aria-labelledby="conn-h">
      <h3 id="conn-h">Connections</h3>
      <p class="muted">Your calendar, inbox and task lists appear in Today. Wandika reads mail and calendars; it never sends or changes them.</p>

      {#snippet connection(name: string, detail: string, connected: boolean, provider: string, configured: boolean, canDisconnect = true)}
        <div class="conn">
          <div class="grow">
            <div>{name}</div>
            <div class="muted small">{configured ? detail : "Not set up in this build. See docs/setup.md."}</div>
          </div>
          {#if connected && canDisconnect}
            <button class="btn" onclick={() => disconnect(provider)}>Disconnect</button>
          {:else if !connected && configured}
            <button class="btn" onclick={() => connect(provider)} disabled={waiting === provider}>
              {waiting === provider ? "Waiting…" : "Connect"}
            </button>
          {/if}
        </div>
      {/snippet}

      {@render connection("Google", c?.google ?? "Gmail, Calendar and Tasks", !!c?.google, "google", !!s?.configured.google)}
      {@render connection("Outlook", c?.microsoft ?? "Outlook mail and calendar", !!c?.microsoft, "microsoft", !!s?.configured.microsoft)}

      {#if device}
        <div class="device" role="status">
          <p>Enter this code on Microsoft's sign-in page:</p>
          <p class="code">{device.user_code}</p>
          <button class="btn primary" onclick={copyAndOpen}>Copy code and open Microsoft</button>
        </div>
      {/if}

      {@render connection("Apple Calendar", appleText[c?.apple_calendar ?? "unsupported"], c?.apple_calendar === "granted", "apple_calendar", c?.apple_calendar === "not_asked" || c?.apple_calendar === "granted", false)}
      {@render connection("Apple Reminders", appleText[c?.apple_reminders ?? "unsupported"], c?.apple_reminders === "granted", "apple_reminders", c?.apple_reminders === "not_asked" || c?.apple_reminders === "granted", false)}
    </section>
  </div>
</dialog>

<style>
  .settings {
    width: min(560px, 100vw);
    max-height: min(760px, 100dvh);
    padding: 0;
    border: 1px solid var(--rule);
    border-radius: var(--radius-lg);
    background: var(--sheet);
    color: var(--ink);
    box-shadow: 0 24px 60px rgb(0 0 0 / 0.2);
  }
  .settings[open] {
    display: flex;
    flex-direction: column;
  }
  .settings::backdrop {
    background: rgb(0 0 0 / 0.35);
  }
  @media (max-width: 599px) {
    .settings {
      max-width: 100vw;
      width: 100vw;
      height: 100dvh;
      max-height: 100dvh;
      margin: 0;
      border-radius: 0;
      border: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(14px + var(--safe-top)) 14px 10px 22px;
    border-bottom: 1px solid var(--rule);
  }
  h2 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
  }
  .body {
    overflow-y: auto;
    padding: 4px 22px calc(24px + var(--safe-bottom));
  }
  section {
    padding: 18px 0;
  }
  section + section {
    border-top: 1px solid var(--rule);
  }
  h3 {
    margin: 0 0 10px;
    font-size: 1rem;
    font-weight: 600;
  }
  p {
    margin: 0 0 12px;
  }
  .row,
  .conn {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .conn {
    padding: 10px 0;
  }
  .row img {
    border-radius: 50%;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .small {
    font-size: var(--small);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }
  .device {
    margin: 4px 0 10px;
    padding: 14px;
    border-radius: var(--radius);
    background: var(--papyrus-wash);
  }
  .code {
    font-family: var(--font-note);
    font-size: 1.8rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    margin: 0 0 12px;
  }
</style>
