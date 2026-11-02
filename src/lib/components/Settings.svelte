<script lang="ts">
  import { duration } from "../motion";
  import {
    ChevronLeft,
    Cloud,
    FolderOpen,
    HardDrive,
    Info,
    KeyRound,
    Lock,
    Paintbrush,
    Plug,
    Type,
    UserRound,
    X,
  } from "@lucide/svelte";
  import { api, openUrl } from "../api";
  import { ago, app, type SettingsSection } from "../app.svelte";
  import { ACCENTS, FONTS, WIDTHS, prefs, type NoteFont, type Theme, type Width } from "../prefs.svelte";
  import type { AppleAccess } from "../types";
  import GitHubSignIn from "./GitHubSignIn.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import Unlock from "./Unlock.svelte";

  const SECTIONS: { id: SettingsSection; label: string; icon: typeof Cloud }[] = [
    { id: "vault", label: "Vault", icon: HardDrive },
    { id: "appearance", label: "Appearance", icon: Paintbrush },
    { id: "editor", label: "Editor", icon: Type },
    { id: "encryption", label: "Encryption", icon: KeyRound },
    { id: "connections", label: "Connections", icon: Plug },
    { id: "account", label: "Account", icon: UserRound },
    { id: "about", label: "About", icon: Info },
  ];

  let dialogEl: HTMLDialogElement;
  let width = $state(typeof window === "undefined" ? 1200 : window.innerWidth);
  const phone = $derived(width < 900);
  /** On phones the category list is its own screen; `null` shows it. */
  let phoneSection = $state<SettingsSection | null>(null);
  const section = $derived(phone ? phoneSection : app.settingsSection);

  let device = $state<{ user_code: string; verification_uri: string } | null>(null);
  let waiting = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let connecting = $state(false);
  const defaultSize = typeof window !== "undefined" && window.innerWidth < 900 ? 17 : 18;

  // Phones: each screen inside Settings is a history entry, so system back (Android) steps from a
  // page to the list and then closes, like a native settings screen.
  let depth = 0;
  function pushScreen() {
    if (!phone) return;
    history.pushState({ wandika: "settings" }, "");
    depth++;
  }

  $effect(() => {
    if (app.settingsOpen && !dialogEl.open) {
      phoneSection = app.settingsDirect ? app.settingsSection : null;
      dialogEl.showModal();
      pushScreen();
    }
    if (!app.settingsOpen && dialogEl.open) dialogEl.close();
  });

  function go(id: SettingsSection) {
    app.settingsSection = id;
    phoneSection = id;
    connecting = false;
    pushScreen();
  }

  /** The page's back button: same as system back. */
  function back() {
    if (phone && depth > 1) history.back();
    else phoneSection = null;
  }

  /**
   * Phones: Settings is a bottom sheet that slides up, drags down to dismiss, and slides away on
   * close. The same sheet on every phone.
   */
  const sheet = $derived(phone);
  let closing = $state(false);
  let dragY = $state(0);
  let dragFrom = $state<number | null>(null);
  let dragAt = 0;

  function sheetDown(e: PointerEvent) {
    if (!sheet || (e.target as HTMLElement).closest("button, input, select, a, textarea")) return;
    dragFrom = e.clientY;
    dragAt = performance.now();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function sheetMove(e: PointerEvent) {
    if (dragFrom === null) return;
    dragY = Math.max(0, e.clientY - dragFrom);
  }
  function sheetUp() {
    if (dragFrom === null) return;
    const speed = dragY / Math.max(1, performance.now() - dragAt);
    dragFrom = null;
    // A long drag or a quick flick dismisses; anything less springs back.
    if (dragY > 140 || speed > 0.6) close();
    else dragY = 0;
  }

  function closeNow() {
    clearTimeout(pollTimer);
    connecting = false;
    device = null;
    waiting = null;
    const ms = duration("--dur-base");
    if (sheet && ms && app.settingsOpen) {
      closing = true;
      setTimeout(() => {
        closing = false;
        dragY = 0;
        app.settingsOpen = false;
      }, ms);
      return;
    }
    dragY = 0;
    app.settingsOpen = false;
  }

  function close() {
    if (depth > 0) {
      const d = depth;
      depth = 0;
      history.go(-d);
    }
    closeNow();
  }

  function onPopState() {
    if (!app.settingsOpen || depth === 0) return;
    depth--;
    if (depth === 0) closeNow();
    else phoneSection = null;
  }

  /** One line under each section in the phone list, so you know what's inside before tapping. */
  const detail = (id: SettingsSection): string => {
    const st = app.status;
    switch (id) {
      case "vault":
        return app.vault?.remote ? `${app.vault.name}, syncs with GitHub` : `${app.vault?.name ?? "No vault"}, on this device`;
      case "appearance":
        return "Theme, accent colour, CSS snippets";
      case "editor":
        return "Font, text size, line width";
      case "encryption":
        return !st?.encryption?.set_up ? "Not set up" : st.encryption.unlocked ? "Unlocked on this device" : "Locked";
      case "connections": {
        const n = [st?.connectors.google, st?.connectors.microsoft].filter(Boolean).length +
          [st?.connectors.apple_calendar, st?.connectors.apple_reminders].filter((a) => a === "granted").length;
        return n ? `${n} connected` : "Mail, calendars and reminders";
      }
      case "account":
        return st?.user ? `GitHub: ${st.user.login}` : "Not signed in";
      case "about":
        return "Version 0.1.0, keyboard shortcuts";
    }
  };

  const s = $derived(app.status);
  const c = $derived(s?.connectors);
  const appleText: Record<AppleAccess, string> = {
    granted: "Allowed on this device",
    not_asked: "Not connected",
    denied: "Turned off. Allow it in System Settings, under Privacy & Security",
    unsupported: "Only on iPhone and Mac",
  };

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

  const NAMES: Record<string, string> = { google: "Google", microsoft: "Outlook", apple_calendar: "Apple Calendar", apple_reminders: "Apple Reminders" };

  async function disconnect(provider: string) {
    try {
      await api.connectorDisconnect(provider);
      await app.refreshStatus();
      app.say(`${NAMES[provider] ?? provider} is disconnected.`);
    } catch (e) {
      app.say((e as Error).message);
    }
  }

  function cancelDevice() {
    clearTimeout(pollTimer);
    device = null;
    waiting = null;
  }

  async function copyAndOpen() {
    if (!device) return;
    await navigator.clipboard?.writeText(device.user_code).catch(() => {});
    await openUrl(device.verification_uri);
  }

  async function lock() {
    try {
      await api.encryptionLock();
      await app.refreshStatus();
      await app.refreshFiles();
      if (app.current?.endsWith(".age")) app.current = null;
      app.say("Encrypted notes are locked on this device.");
    } catch (e) {
      app.say((e as Error).message);
    }
  }

  const SHORTCUTS = [
    ["⌘K", "Search or create a note"],
    ["⌘N", "New note"],
    ["⌘D", "Today's note"],
    ["⌘S", "Sync now"],
    ["⌘,", "Settings"],
    ["⌘F", "Find in note"],
    ["[[", "Link a note"],
  ];

  const label = (id: SettingsSection | null) => SECTIONS.find((x) => x.id === id)?.label ?? "Settings";
</script>

<svelte:window bind:innerWidth={width} onpopstate={onPopState} />

{#snippet google()}
  {@render connRow("Google", "Gmail, Calendar and Tasks", c?.google ?? null, "google", !!s?.configured.google, true)}
{/snippet}

{#snippet connRow(name: string, what: string, account: string | null, provider: string, configured: boolean, canDisconnect: boolean)}
  <div class="row">
    <div class="row-text">
      <span class="row-label">{name}</span>
      <span class="row-desc">
        {#if !configured}
          {provider === "google" && /Android/.test(navigator.userAgent)
            ? "Not available on Android yet. Connect Google on your Mac or iPhone."
            : "Not available in this version."}
        {:else if account}
          {account}
        {:else}
          {what}
        {/if}
      </span>
    </div>
    {#if account && canDisconnect}
      <button class="btn" onclick={() => disconnect(provider)}>Disconnect</button>
    {:else if !account && configured}
      <button class="btn" onclick={() => connect(provider)} disabled={waiting === provider}>
        {waiting === provider ? "Waiting…" : "Connect"}
      </button>
    {/if}
  </div>
{/snippet}

{#snippet appleRow(name: string, kind: "apple_calendar" | "apple_reminders")}
  {@const access = c?.[kind] ?? "unsupported"}
  <div class="row">
    <div class="row-text">
      <span class="row-label">{name}</span>
      <span class="row-desc">{appleText[access]}</span>
    </div>
    {#if access === "not_asked"}
      <button class="btn" onclick={() => connect(kind)} disabled={waiting === kind}>{waiting === kind ? "Waiting…" : "Connect"}</button>
    {/if}
  </div>
{/snippet}

<dialog
  bind:this={dialogEl}
  oncancel={(e) => {
    e.preventDefault();
    close();
  }}
  onclick={(e) => {
    // A tap on the dimmed area outside a sheet dismisses it.
    if (sheet && e.target === dialogEl) close();
  }}
  aria-labelledby="settings-title"
  class="settings"
  class:phone
  class:sheet
  class:closing
  class:dragging={dragY > 0 && dragFrom !== null}
  style={dragY ? `--drag: ${dragY}px` : undefined}
>
  {#if sheet}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="grabber-zone" onpointerdown={sheetDown} onpointermove={sheetMove} onpointerup={sheetUp} onpointercancel={sheetUp}>
      <span class="grabber"></span>
    </div>
  {/if}
  {#if !phone || section === null}
    <nav class="sections" aria-label="Settings sections">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <header class="nav-head" onpointerdown={sheetDown} onpointermove={sheetMove} onpointerup={sheetUp} onpointercancel={sheetUp}>
        <h2 id="settings-title">Settings</h2>
        {#if phone}
          <button class="done" onclick={close}>Done</button>
        {/if}
      </header>
      <ul>
        {#each SECTIONS as sec (sec.id)}
          <li>
            <button class:on={!phone && section === sec.id} aria-current={!phone && section === sec.id ? "page" : undefined} onclick={() => go(sec.id)}>
              <sec.icon size={phone ? 22 : 17} />
              <span class="sec-text">
                <span>{sec.label}</span>
                {#if phone}<span class="sec-detail">{detail(sec.id)}</span>{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  {/if}

  {#if section}
    <div class="pane">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <header class="pane-head" onpointerdown={sheetDown} onpointermove={sheetMove} onpointerup={sheetUp} onpointercancel={sheetUp}>
        {#if phone}
          <button class="back" onclick={back}><ChevronLeft size={22} />Settings</button>
        {/if}
        <h3>{label(section)}</h3>
        {#if phone}
          <button class="done" onclick={close}>Done</button>
        {:else}
          <button class="icon-btn" onclick={close} aria-label="Close settings"><X size={20} /></button>
        {/if}
      </header>

      <div class="pane-body">
        {#if section === "vault"}
          <div class="group">
            <div class="row">
              <div class="row-text">
                <span class="row-label">{app.vault?.name}</span>
                <span class="row-desc">
                  {#if app.vault?.folder}<FolderOpen size={13} /> {app.vault.folder}{:else}<HardDrive size={13} /> In Wandika's storage on this device{/if}
                </span>
              </div>
              <button class="btn" onclick={() => app.switchVault()}>Switch vault</button>
            </div>
          </div>

          <h4>Sync</h4>
          <div class="group">
            {#if connecting}
              <div class="row stack">
                {#if !s?.user}
                  <p class="row-desc">Sign in with GitHub, then choose the repository to sync this vault with.</p>
                  <GitHubSignIn />
                {:else}
                  <RepoPicker mode="connect" ondone={() => (connecting = false)} />
                {/if}
                <button class="btn" onclick={() => (connecting = false)}>Cancel</button>
              </div>
            {:else if app.vault?.remote}
              <div class="row">
                <div class="row-text">
                  <span class="row-label"><Cloud size={14} /> {app.vault.remote.owner}/{app.vault.remote.repo}</span>
                  <span class="row-desc">Synced {ago(app.lastSync)}. Changes sync about 20 seconds after you stop typing.</span>
                </div>
                <button class="btn" onclick={() => app.sync()} disabled={app.syncing}>{app.syncing ? "Syncing…" : "Sync now"}</button>
              </div>
              {#if app.syncError}<div class="row"><span class="error small">Last sync: {app.syncError.message}</span></div>{/if}
              <div class="row">
                <div class="row-text">
                  <span class="row-label">Disconnect from GitHub</span>
                  <span class="row-desc">Stops syncing. Notes stay here and on GitHub.</span>
                </div>
                <button class="btn" onclick={disconnectRemote}>Disconnect</button>
              </div>
            {:else}
              <div class="row">
                <div class="row-text">
                  <span class="row-label">Only on this device</span>
                  <span class="row-desc">Connect a GitHub repository to sync this vault to your other devices.</span>
                </div>
                <button class="btn primary" onclick={() => (connecting = true)}>Connect to GitHub</button>
              </div>
            {/if}
          </div>
        {:else if section === "appearance"}
          <h4>Colours</h4>
          <div class="group">
            <div class="row">
              <span class="row-label" id="theme-l">Theme</span>
              <div class="segmented" role="radiogroup" aria-labelledby="theme-l">
                {#each [["system", "System"], ["light", "Light"], ["dark", "Dark"]] as [id, text] (id)}
                  <button role="radio" aria-checked={prefs.value.theme === id} class:on={prefs.value.theme === id} onclick={() => prefs.set({ theme: id as Theme })}>{text}</button>
                {/each}
              </div>
            </div>
            <div class="row">
              <span class="row-label" id="accent-l">Accent</span>
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
          </div>
          <p class="note">Kept on this device, so each device can look different.</p>

          <h4>CSS snippets</h4>
          <div class="group">
            {#each app.snippets as sn (sn.name)}
              <label class="row">
                <span class="row-label">{sn.name}</span>
                <input type="checkbox" class="toggle" checked={sn.enabled} onchange={(e) => toggleSnippet(sn.name, (e.currentTarget as HTMLInputElement).checked)} />
              </label>
            {:else}
              <div class="row"><span class="row-desc">No snippets yet. Add .css files to the vault's .obsidian/snippets folder.</span></div>
            {/each}
          </div>
          <p class="note">
            Snippets live in the vault and sync with it.
            <button class="link-btn" onclick={() => app.loadSnippets()}>Reload snippets</button>
          </p>

          <div class="footer-actions">
            <button class="btn" onclick={() => prefs.reset()}>Reset appearance and editor</button>
          </div>
        {:else if section === "editor"}
          <h4>Text</h4>
          <div class="group">
            <div class="row">
              <span class="row-label" id="font-l">Font</span>
              <div class="segmented" role="radiogroup" aria-labelledby="font-l">
                {#each Object.entries(FONTS) as [id, f] (id)}
                  <button role="radio" aria-checked={prefs.value.font === id} class:on={prefs.value.font === id} style="font-family: {f.css}" onclick={() => prefs.set({ font: id as NoteFont })}>{f.label}</button>
                {/each}
              </div>
            </div>
            <div class="row">
              <label class="row-label" for="size-r">Size</label>
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
              </div>
            </div>
            <div class="row">
              <span class="row-label" id="width-l">Line width</span>
              <div class="segmented" role="radiogroup" aria-labelledby="width-l">
                {#each Object.entries(WIDTHS) as [id, w] (id)}
                  <button role="radio" aria-checked={prefs.value.width === id} class:on={prefs.value.width === id} onclick={() => prefs.set({ width: id as Width })}>{w.label}</button>
                {/each}
              </div>
            </div>
          </div>
          <p class="note">
            Kept on this device.
            {#if prefs.value.size}<button class="link-btn" onclick={() => prefs.set({ size: null })}>Use the default size</button>{/if}
          </p>
        {:else if section === "encryption"}
          {#if s?.encryption?.set_up && s.encryption.unlocked}
            <div class="group">
              <div class="row">
                <div class="row-text">
                  <span class="row-label"><Lock size={14} /> Unlocked on this device</span>
                  <span class="row-desc">
                    {#if s.encryption.folders.length}Encrypted folders: {s.encryption.folders.join(", ")}.{:else}Encrypt a note or folder from its menu.{/if}
                  </span>
                </div>
                <button class="btn" onclick={lock}>Lock</button>
              </div>
            </div>
          {:else}
            <div class="group"><div class="row stack"><Unlock context="settings" /></div></div>
          {/if}
          <p class="note">
            Encrypted notes are stored as age files on GitHub and on your devices. Only your passphrase opens them, and
            they also open with the age command-line tool.
          </p>
        {:else if section === "connections"}
          <h4>Mail and calendars</h4>
          <div class="group">
            {@render google()}
            {@render connRow("Outlook", "Outlook mail and calendar", c?.microsoft ?? null, "microsoft", !!s?.configured.microsoft, true)}
            {#if device}
              <div class="row stack device" role="status">
                <span class="row-desc">Enter this code on Microsoft's sign-in page:</span>
                <span class="code">{device.user_code}</span>
                <button class="btn primary" onclick={copyAndOpen}>Copy code and open Microsoft</button>
                <span class="row-desc">Waiting for Microsoft. This moves on by itself once you approve.</span>
                <button class="btn quiet" onclick={cancelDevice}>Cancel</button>
              </div>
            {/if}
          </div>
          <h4>On this device</h4>
          <div class="group">
            {@render appleRow("Apple Calendar", "apple_calendar")}
            {@render appleRow("Apple Reminders", "apple_reminders")}
          </div>
          <p class="note">Connected sources appear in Today. Wandika reads mail and calendars; it never sends or changes them.</p>
        {:else if section === "account"}
          <div class="group">
            {#if s?.user}
              <div class="row">
                <div class="row-text account">
                  {#if s.user.avatar_url}<img src={s.user.avatar_url} alt="" width="36" height="36" />{/if}
                  <span>
                    <span class="row-label">{s.user.name ?? s.user.login}</span>
                    <span class="row-desc">GitHub: {s.user.login}</span>
                  </span>
                </div>
                <button class="btn danger" onclick={signOut}>Sign out</button>
              </div>
            {:else}
              <div class="row stack">
                <span class="row-desc">Not signed in. Sign in to sync vaults through GitHub.</span>
                <GitHubSignIn />
              </div>
            {/if}
          </div>
        {:else if section === "about"}
          <div class="group">
            <div class="row">
              <span class="row-label">Wandika</span>
              <span class="row-desc">Version 0.1.0</span>
            </div>
            <div class="row">
              <span class="row-label">Source</span>
              <button class="link-btn" onclick={() => openUrl("https://github.com/jordan-jakisa/wandika")}>github.com/jordan-jakisa/wandika</button>
            </div>
          </div>
          <h4>Keyboard shortcuts</h4>
          <div class="group">
            {#each SHORTCUTS as [keys, what] (keys)}
              <div class="row">
                <span class="row-label">{what}</span>
                <kbd>{keys}</kbd>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</dialog>

<style>
  .settings {
    width: min(780px, calc(100vw - 32px));
    height: min(600px, calc(100dvh - 48px));
    padding: 0;
    border: 1px solid var(--rule);
    border-radius: var(--radius-lg);
    background: var(--sheet);
    color: var(--ink);
    box-shadow: var(--shadow-modal);
    overflow: hidden;
  }
  .settings[open] {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
  }
  .settings.phone[open] {
    display: flex;
    flex-direction: column;
    width: 100vw;
    max-width: 100vw;
    height: 100dvh;
    max-height: 100dvh;
    margin: 0;
    border: 0;
    border-radius: 0;
  }
  .settings[open]:not(.sheet) {
    animation: pop-in var(--dur-quick) var(--ease-out);
  }
  .settings::backdrop {
    background: var(--scrim);
  }

  /* Phone sheet: rounded top, grabber, slides up from the bottom, follows a drag down. */
  .settings.sheet[open] {
    top: auto;
    bottom: 0;
    height: calc(100dvh - var(--safe-top) - 10px);
    max-height: none;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    background: var(--sheet);
    transform: translateY(var(--drag, 0px));
    transition: transform var(--dur-base) var(--ease-sheet);
    animation: sheet-in var(--dur-slow) var(--ease-sheet);
  }
  .settings.sheet.dragging {
    transition: none;
  }
  .settings.sheet.closing {
    transform: translateY(100%);
    transition: transform var(--dur-base) var(--ease-sheet);
  }
  .settings.sheet.closing::backdrop {
    opacity: 0;
    transition: opacity var(--dur-base) var(--ease-out);
  }
  .settings.sheet::backdrop {
    background: var(--scrim);
  }
  @keyframes sheet-in {
    from {
      transform: translateY(100%);
    }
  }
  .grabber-zone {
    display: grid;
    place-items: center;
    height: 18px;
    flex: none;
    touch-action: none;
  }
  .grabber {
    width: 36px;
    height: 5px;
    border-radius: var(--radius-xs);
    background: color-mix(in srgb, var(--graphite) 45%, transparent);
  }
  .sheet .nav-head,
  .sheet .pane-head {
    touch-action: none;
  }
  .sheet .nav-head {
    padding-top: 6px;
  }
  .sheet .pane-head {
    padding-top: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .settings.sheet[open] {
      animation: none;
    }
  }

  .sections {
    background: var(--paper);
    border-right: 1px solid var(--rule);
    overflow-y: auto;
  }
  .phone .sections {
    flex: 1;
    border: 0;
    background: var(--sheet);
  }
  .nav-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 16px 10px;
  }
  .phone .nav-head {
    padding: calc(14px + var(--safe-top)) 12px 10px 20px;
  }
  .sheet .nav-head {
    padding: 6px 12px 10px 20px;
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 650;
  }
  .sections ul {
    list-style: none;
    margin: 0;
    padding: 0 8px 12px;
  }
  .sections li button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 34px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink);
    text-align: left;
  }
  /* Phone sheet: "Done" closes it; the back row is the shared .back. */
  .done {
    display: inline-flex;
    align-items: center;
    min-height: var(--target);
    padding: 0 var(--space-3);
    border: 0;
    background: none;
    color: var(--papyrus);
    font-size: var(--text-md);
    font-weight: 600;
  }
  .done:active {
    opacity: 0.5;
  }
  .sec-text {
    flex: 1;
    display: grid;
    min-width: 0;
  }
  .sec-detail {
    font-size: var(--small);
    color: var(--graphite);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (hover: hover) {
    .sections li button:hover {
      background: var(--papyrus-wash);
    }
  }
  .sections li button.on {
    background: color-mix(in srgb, var(--papyrus) 16%, transparent);
    font-weight: 600;
  }
  .phone .sections li button {
    min-height: var(--target);
    padding: 0 12px;
  }
  .sections :global(svg) {
    color: var(--graphite);
    flex: none;
  }

  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .phone .pane {
    flex: 1;
  }
  .pane-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 12px 12px 4px 24px;
  }
  .phone .pane-head {
    padding: calc(10px + var(--safe-top)) 8px 4px 4px;
  }
  .sheet .pane-head {
    padding: 2px 8px 4px 4px;
  }
  .pane-head h3 {
    flex: 1;
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 650;
  }
  .pane-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 24px calc(28px + var(--safe-bottom));
  }
  .phone .pane-body {
    padding: 8px 16px calc(28px + var(--safe-bottom));
  }
  h4 {
    margin: 20px 0 8px 2px;
    font-size: var(--small);
    font-weight: 600;
    color: var(--graphite);
  }
  .pane-body > .group:first-child {
    margin-top: 10px;
  }

  /* One level of grouping: rows separated by hairlines inside a quiet container. */
  .group {
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    background: var(--sheet);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 52px;
    padding: 10px 14px;
  }
  .row + .row {
    border-top: 1px solid var(--rule);
  }
  .row.stack {
    flex-direction: column;
    align-items: flex-start;
  }
  .row.stack > :global(.picker),
  .row.stack > :global(.unlock) {
    width: 100%;
  }
  .row-text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .row-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
  }
  .row-desc {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--small);
    color: var(--graphite);
    overflow-wrap: anywhere;
  }
  .account {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .account img {
    border-radius: 50%;
  }
  .account > span {
    display: grid;
  }
  .note {
    margin: 8px 2px 0;
    font-size: var(--small);
    color: var(--graphite);
  }
  .footer-actions {
    margin-top: 24px;
  }
  .small {
    font-size: var(--small);
  }
  .swatches {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 10px;
  }
  .swatch {
    position: relative;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid var(--sheet);
    background: var(--swatch);
    box-shadow: 0 0 0 1px var(--rule);
  }
  .swatch.on {
    box-shadow: 0 0 0 2px var(--ink);
  }
  @media (pointer: coarse) {
    .swatches {
      gap: var(--space-4);
    }
    .swatch::after {
      content: "";
      position: absolute;
      inset: -9px;
    }
  }
  .size {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .size input {
    width: 180px;
    accent-color: var(--papyrus);
  }
  .size-value {
    font-size: var(--small);
    font-variant-numeric: tabular-nums;
    min-width: 3.5em;
    text-align: right;
  }
  .toggle {
    width: 18px;
    height: 18px;
    accent-color: var(--papyrus);
  }
  label.row {
    cursor: pointer;
  }
  kbd {
    font: inherit;
    font-size: var(--small);
    padding: 2px 8px;
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    background: var(--paper);
    color: var(--graphite);
  }
  .device .code {
    font-family: var(--font-note);
    font-size: var(--text-2xl);
    font-weight: 600;
    letter-spacing: 0.08em;
  }
  @media (max-width: 520px) {
    .row {
      flex-wrap: wrap;
    }
  }
</style>
