<script lang="ts">
  import { X } from "@lucide/svelte";
  import { api, openUrl } from "../api";
  import { ago, app } from "../app.svelte";
  import type { AppleAccess } from "../types";
  import GitHubSignIn from "./GitHubSignIn.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import Unlock from "./Unlock.svelte";
  import { ACCENTS, FONTS, WIDTHS, prefs, type NoteFont, type Theme, type Width } from "../prefs.svelte";

  let dialogEl: HTMLDialogElement;
  let device = $state<{ user_code: string; verification_uri: string } | null>(null);
  let waiting = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (app.settingsOpen && !dialogEl.open) dialogEl.showModal();
    if (!app.settingsOpen && dialogEl.open) dialogEl.close();
  });

  let connecting = $state(false);
  const defaultSize = typeof window !== "undefined" && window.innerWidth < 900 ? 17 : 18;

  async function toggleSnippet(name: string, enabled: boolean) {
    try {
      await api.snippetToggle(name, enabled);
      await app.loadSnippets();
      app.edited();
    } catch (e) {
      app.say((e as Error).message);
    }
  }

  async function disconnectRemote() {
    const r = app.vault?.remote;
    const ok = await app.ask({
      title: `Stop syncing with ${r?.owner}/${r?.repo}?`,
      message: "Your notes stay on this device and on GitHub. You can connect again later.",
      confirm: "Disconnect",
    });
    if (ok === null) return;
    await app.flush();
    await api.vaultDisconnectRemote();
    await app.enterVault();
    app.say("This vault is now only on this device.");
  }

  async function signOut() {
    const synced = !!app.vault?.remote;
    const ok = await app.ask({
      title: "Sign out of GitHub?",
      message: synced
        ? "This vault syncs with GitHub, so it closes. Your notes stay on this device and on GitHub."
        : "Your vault stays open on this device.",
      confirm: "Sign out",
    });
    if (ok === null) return;
    await app.signOut();
  }

  function close() {
    clearTimeout(pollTimer);
    connecting = false;
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
        <div class="grow">
          <div>{app.vault?.name}</div>
          <div class="muted small">
            {#if app.vault?.remote}
              Syncs with {app.vault.remote.owner}/{app.vault.remote.repo}. Synced {ago(app.lastSync)}.
            {:else if app.vault?.folder}
              Only on this device, in {app.vault.folder}.
            {:else}
              Only on this device.
            {/if}
          </div>
        </div>
      </div>

      {#if connecting}
        <div class="connect">
          {#if !s?.user}
            <p>Sign in with GitHub, then choose the repository to sync this vault with.</p>
            <GitHubSignIn />
          {:else}
            <RepoPicker mode="connect" ondone={() => (connecting = false)} />
          {/if}
          <button class="btn" onclick={() => (connecting = false)}>Cancel</button>
        </div>
      {:else}
        <div class="buttons">
          {#if app.vault?.remote}
            <button class="btn" onclick={() => app.sync()} disabled={app.syncing}>{app.syncing ? "Syncing…" : "Sync now"}</button>
            <button class="btn" onclick={disconnectRemote}>Disconnect from GitHub</button>
          {:else}
            <button class="btn primary" onclick={() => (connecting = true)}>Connect to GitHub</button>
          {/if}
          <button class="btn" onclick={() => app.switchVault()}>Switch vault</button>
        </div>
      {/if}
      {#if app.syncError && app.vault?.remote}<p class="error small">Last sync: {app.syncError}</p>{/if}
    </section>

    <section aria-labelledby="look-h">
      <h3 id="look-h">Appearance</h3>
      <p class="muted small">These choices are kept on this device.</p>

      <div class="pref">
        <span class="pref-label" id="theme-l">Theme</span>
        <div class="segmented" role="radiogroup" aria-labelledby="theme-l">
          {#each [["system", "System"], ["light", "Light"], ["dark", "Dark"]] as [id, label] (id)}
            <button role="radio" aria-checked={prefs.value.theme === id} class:on={prefs.value.theme === id} onclick={() => prefs.set({ theme: id as Theme })}>{label}</button>
          {/each}
        </div>
      </div>

      <div class="pref">
        <span class="pref-label" id="accent-l">Accent</span>
        <div class="swatches" role="radiogroup" aria-labelledby="accent-l">
          {#each ACCENTS as a (a.id)}
            <button
              role="radio"
              aria-checked={prefs.value.accent === a.id}
              aria-label={a.label}
              title={a.label}
              class="swatch"
              class:on={prefs.value.accent === a.id}
              style="--swatch: {prefs.mode === 'dark' ? a.dark : a.light}"
              onclick={() => prefs.set({ accent: a.id })}
            ></button>
          {/each}
        </div>
      </div>

      <div class="pref">
        <span class="pref-label" id="font-l">Note font</span>
        <div class="segmented" role="radiogroup" aria-labelledby="font-l">
          {#each Object.entries(FONTS) as [id, f] (id)}
            <button role="radio" aria-checked={prefs.value.font === id} class:on={prefs.value.font === id} style="font-family: {f.css}" onclick={() => prefs.set({ font: id as NoteFont })}>{f.label}</button>
          {/each}
        </div>
      </div>

      <div class="pref">
        <label class="pref-label" for="size-r">Text size</label>
        <div class="size">
          <input
            id="size-r"
            type="range"
            min="14"
            max="24"
            step="1"
            value={prefs.value.size ?? defaultSize}
            oninput={(e) => prefs.set({ size: Number((e.currentTarget as HTMLInputElement).value) })}
          />
          <span class="size-value">{prefs.value.size ?? defaultSize} px</span>
          {#if prefs.value.size}<button class="link-btn" onclick={() => prefs.set({ size: null })}>Default</button>{/if}
        </div>
      </div>

      <div class="pref">
        <span class="pref-label" id="width-l">Line width</span>
        <div class="segmented" role="radiogroup" aria-labelledby="width-l">
          {#each Object.entries(WIDTHS) as [id, w] (id)}
            <button role="radio" aria-checked={prefs.value.width === id} class:on={prefs.value.width === id} onclick={() => prefs.set({ width: id as Width })}>{w.label}</button>
          {/each}
        </div>
      </div>

      <div class="pref snippets">
        <span class="pref-label">CSS snippets</span>
        {#if app.snippets.length}
          <ul>
            {#each app.snippets as sn (sn.name)}
              <li>
                <label><input type="checkbox" checked={sn.enabled} onchange={(e) => toggleSnippet(sn.name, (e.currentTarget as HTMLInputElement).checked)} /> {sn.name}</label>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="muted small">Put .css files in the vault's .obsidian/snippets folder, then reload. They sync with the vault.</p>
        {/if}
        <button class="link-btn" onclick={() => app.loadSnippets()}>Reload snippets</button>
      </div>

      <button class="btn" onclick={() => prefs.reset()}>Reset appearance</button>
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
        <Unlock context="settings" />
      {/if}
    </section>

    <section aria-labelledby="conn-h">
      <h3 id="conn-h">Connections</h3>
      <p class="muted">Your calendar, inbox and task lists appear in Today. Wandika reads mail and calendars; it never sends or changes them.</p>

      {#snippet connection(name: string, detail: string, connected: boolean, provider: string, configured: boolean, canDisconnect = true)}
        <div class="conn">
          <div class="grow">
            <div>{name}</div>
            <div class="muted small">{configured ? detail : provider === "google" && /Android/.test(navigator.userAgent) ? "Not available on Android yet. Connect Google on your Mac or iPhone." : "Not set up in this build. See docs/setup.md."}</div>
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
    {#if s?.user}
      <section aria-labelledby="gh-h">
        <h3 id="gh-h">GitHub</h3>
        <div class="row">
          {#if s.user.avatar_url}<img src={s.user.avatar_url} alt="" width="36" height="36" />{/if}
          <div class="grow">Signed in as {s.user.login}</div>
          <button class="btn danger" onclick={signOut}>Sign out</button>
        </div>
      </section>
    {/if}
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
  .pref {
    display: grid;
    grid-template-columns: 110px 1fr;
    align-items: center;
    gap: 8px 14px;
    margin-bottom: 14px;
  }
  @media (max-width: 480px) {
    .pref {
      grid-template-columns: 1fr;
    }
  }
  .pref-label {
    font-size: var(--small);
    color: var(--graphite);
  }
  .segmented {
    display: inline-flex;
    justify-self: start;
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .segmented button {
    min-height: 34px;
    padding: 0 12px;
    border: 0;
    background: var(--sheet);
    color: var(--ink);
    font-size: var(--small);
  }
  .segmented button + button {
    border-left: 1px solid var(--rule);
  }
  .segmented button.on {
    background: var(--papyrus);
    color: var(--on-papyrus);
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .swatch {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid var(--sheet);
    background: var(--swatch);
    box-shadow: 0 0 0 1px var(--rule);
  }
  .swatch.on {
    box-shadow: 0 0 0 2px var(--ink);
  }
  .size {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .size input {
    flex: 1;
    max-width: 220px;
    accent-color: var(--papyrus);
  }
  .size-value {
    font-size: var(--small);
    font-variant-numeric: tabular-nums;
    min-width: 3.5em;
  }
  .link-btn {
    border: 0;
    background: none;
    padding: 0;
    color: var(--papyrus);
    font-size: var(--small);
    justify-self: start;
  }
  .snippets {
    align-items: start;
  }
  .snippets ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .snippets label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .snippets input {
    accent-color: var(--papyrus);
  }
  .snippets .link-btn {
    grid-column: 2;
  }
  @media (max-width: 480px) {
    .snippets .link-btn {
      grid-column: 1;
    }
  }
  .connect {
    display: grid;
    gap: 12px;
    justify-items: start;
  }
  .connect > :global(.picker) {
    width: 100%;
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
