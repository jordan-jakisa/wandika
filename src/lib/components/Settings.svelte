<script lang="ts">
  /** Beta feedback goes to the same address as the privacy policy's contact. */
  const FEEDBACK = "mailto:jordan.timutic@gmail.com?subject=Wandika%20beta%20feedback";
  /** The store rules want the privacy policy reachable inside the app. */
  const PRIVACY = "https://github.com/jordan-jakisa/wandika/blob/main/PRIVACY.md";
  import {
    ChevronLeft,
    ChevronRight,
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
  import { untrack } from "svelte";
  import { push } from "../transitions";
  import { closeSheet } from "../motion";
  import { api, listen, openUrl } from "../api";
  import { ago, app, type SettingsSection } from "../app.svelte";
  import { ACCENTS, FONTS, WIDTHS, prefs, type NoteFont, type Theme, type Width } from "../prefs.svelte";
  import { touch } from "../tips";
  import { isIOS, isMac } from "../platform";
  import type { AppleAccess, NewNoteLocation } from "../types";
  import GitHubSignIn from "./GitHubSignIn.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import Unlock from "./Unlock.svelte";

  /** `embedded`: the phone's Settings tab, a page in place instead of a sheet over the app. */
  let { embedded = false }: { embedded?: boolean } = $props();

  const SECTIONS: { id: SettingsSection; label: string; icon: typeof Cloud }[] = [
    { id: "vault", label: "Vault", icon: HardDrive },
    { id: "appearance", label: "Appearance", icon: Paintbrush },
    { id: "editor", label: "Editor", icon: Type },
    { id: "encryption", label: "Encryption", icon: KeyRound },
    { id: "connections", label: "Connections", icon: Plug },
    { id: "account", label: "Account", icon: UserRound },
    { id: "about", label: "About", icon: Info },
  ];

  let dialogEl = $state<HTMLDialogElement>()!;
  /** Phones show Settings as a tab (`embedded`): the list of sections, then one page at a time.
   *  The desktop shows a dialog with the list beside the page. */
  const phone = $derived(embedded);
  const section = $derived(embedded ? app.settingsPage : app.settingsSection);

  let device = $state<{ user_code: string; verification_uri: string } | null>(null);
  let waiting = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let connecting = $state(false);
  const defaultSize = typeof window !== "undefined" && window.innerWidth < 900 ? 17 : 18;

  // Where new notes go: Obsidian's own setting in the vault, so Obsidian and other devices agree.
  let newNotes = $state<NewNoteLocation | null>(null);
  const folders = $derived(app.tree.filter((e) => e.kind === "folder").map((e) => e.path));
  const placeValue = $derived(newNotes ? (newNotes.location === "folder" ? `folder:${newNotes.folder}` : newNotes.location) : "");
  $effect(() => {
    if (section !== "vault") return;
    void app.vault?.id;
    untrack(() => {
      api.newNoteLocation().then((l) => (newNotes = l)).catch(() => (newNotes = null));
    });
  });
  async function setPlace(value: string) {
    const [location, folder] = value.startsWith("folder:") ? (["folder", value.slice(7)] as const) : ([value as NewNoteLocation["location"], ""] as const);
    try {
      await api.newNoteLocationSet(location, folder);
      newNotes = { location, folder: location === "folder" ? folder : (newNotes?.folder ?? "") };
      app.edited();
    } catch (e) {
      app.say((e as Error).message);
    }
  }

  $effect(() => {
    if (embedded) return;
    if (app.settingsOpen && !dialogEl.open) dialogEl.showModal();
    if (!app.settingsOpen && dialogEl.open && !dialogEl.classList.contains("closing")) closeSheet(dialogEl);
  });

  function go(id: SettingsSection) {
    if (embedded) app.settingsPage = id;
    app.settingsSection = id;
    connecting = false;
  }

  /** The page's back button. The workspace keeps the history entry, so system back does the same. */
  function back() {
    app.settingsPage = null;
  }

  function close() {
    clearTimeout(pollTimer);
    connecting = false;
    device = null;
    waiting = null;
    app.settingsOpen = false;
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
        const cfg = st?.configured;
        if (n) return `${n} connected`;
        if (cfg && !cfg.google && !cfg.microsoft && !cfg.apple) return isMac ? "Claude Code" : "Nothing to connect yet";
        return isMac ? "Mail, calendars, reminders and Claude Code" : "Mail, calendars and reminders";
      }
      case "account":
        return st?.user ? `GitHub: ${st.user.login}` : "Not signed in";
      case "about":
        return phone ? "Version 0.1.0 beta, feedback" : "Version 0.1.0 beta, feedback, keyboard shortcuts";
    }
  };

  const s = $derived(app.status);
  const c = $derived(s?.connectors);
  const appleText: Record<AppleAccess, string> = {
    granted: "Allowed on this device",
    not_asked: "Not connected",
    denied: isIOS
      ? "Turned off. Allow it in Settings, under Privacy & Security"
      : "Turned off. Allow it in System Settings, under Privacy & Security",
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
    try {
      await app.flush();
      await api.vaultDisconnectRemote();
      await app.enterVault();
      app.say("This vault is now only on this device.");
    } catch (e) {
      app.say((e as Error).message);
    }
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
    await app.signOut().catch((e) => app.say((e as Error).message));
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

  // A sign-in in the browser that failed or was cancelled ends the wait too, so Connect works again.
  $effect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    void listen<{ provider: string }>("connectors-changed", (p) => {
      if (waiting === p.provider) waiting = null;
    }).then((unlisten) => (gone ? unlisten() : (stop = unlisten)));
    return () => {
      gone = true;
      stop?.();
    };
  });

  const NAMES: Record<string, string> = { google: "Google", microsoft: "Outlook", apple_calendar: "Apple Calendar", apple_reminders: "Apple Reminders" };

  /** Copies the Terminal line that connects Claude Code, run once on this Mac. */
  async function copyClaude() {
    try {
      const line = await api.claudeSetupCommand();
      await navigator.clipboard.writeText(line);
      app.say("Copied. Paste it in Terminal and press Return, then restart Claude Code.");
    } catch (e) {
      app.say((e as Error).message);
    }
  }

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
    ["⌘K or ⌘O", "Search or create a note"],
    ["⌘⇧P", "Every command"],
    ["⌘1, ⌘2, ⌘3", "Go to the file list, the note or Today"],
    ["F6 and ⇧F6", "Move between the file list, the note and Today"],
    ["⌘Return", "Open the link under the cursor"],
    ["⇧F10", "Open the menu of a file or task"],
    ["⌘N", "New note"],
    ["⌥⌘N", "New voice note"],
    ["⌘D", "Today's note"],
    ["⌘S", "Sync now"],
    ["⌘,", "Settings"],
    ["⌘\\", "Show or hide the sidebar"],
    ["⌥⌘T", "Show or hide Today"],
    ["⌘[ and ⌘]", "Back and forward between notes"],
    ["⌘F", "Find in note"],
    ["⌥-click", "Add a cursor"],
    ["⌥⌘↑ and ⌥⌘↓", "Add a cursor above or below"],
    ["⌘P", "Export the note as a PDF"],
    ["⌘B, ⌘I", "Bold, italic"],
    ["⌘L", "Checklist"],
    ["⌘⇧8, ⌘⇧7", "Bulleted list, numbered list"],
    ["[[", "Link a note"],
  ];

  const label = (id: SettingsSection | null) => SECTIONS.find((x) => x.id === id)?.label ?? "Settings";
</script>


{#snippet google()}
  {@render connRow("Google", s?.configured.gmail === false ? "Calendar and Tasks" : "Gmail, Calendar and Tasks", c?.google ?? null, "google", !!s?.configured.google, true)}
{/snippet}

{#snippet connRow(name: string, what: string, account: string | null, provider: string, configured: boolean, canDisconnect: boolean)}
  <div class="row">
    <div class="row-text">
      <span class="row-label">{name}</span>
      <span class="row-desc">
        {#if account}
          {account}
        {:else if !configured}
          Not available in this version.
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

{#snippet body()}
  {#if !phone || section === null}
    <nav class="sections" aria-label="Settings sections">
      <header class="nav-head">
        <h2 id="settings-title" class:large={embedded}>Settings</h2>
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
              {#if phone && isIOS}<span class="chev" aria-hidden="true"><ChevronRight size={18} /></span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  {/if}

  {#if section}
    {#key section}
    <div class="pane" in:push|global={{ enabled: embedded }}>
      <header class="pane-head">
        {#if phone}
          <button class="back" onclick={back}><ChevronLeft size={22} />Settings</button>
        {/if}
        <h3>{label(section)}</h3>
        {#if phone}
          <span></span>
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

          {#if newNotes}
            <h4>New notes</h4>
            <div class="group">
              <label class="row">
                <span class="row-label">New notes go in</span>
                <select class="field place" value={placeValue} onchange={(e) => setPlace(e.currentTarget.value)}>
                  <option value="root">The top of the vault</option>
                  <option value="current">The open note's folder</option>
                  {#each newNotes.location === "folder" && !folders.includes(newNotes.folder) ? [newNotes.folder, ...folders] : folders as f (f)}
                    <option value={`folder:${f}`}>{f}</option>
                  {/each}
                </select>
              </label>
            </div>
            <p class="note">Kept in the vault's Obsidian settings, so Obsidian and your other devices use it too.</p>
          {/if}

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
                {#if !app.syncing}
                  <button class="btn" onclick={() => (connecting = false)}>Cancel</button>
                {/if}
              </div>
            {:else if app.vault?.remote}
              <div class="row">
                <div class="row-text">
                  <span class="row-label"><Cloud size={14} /> {app.vault.remote.owner}/{app.vault.remote.repo}</span>
                  <span class="row-desc">Synced {ago(app.lastSync)}. Changes sync about 20 seconds after you stop typing.</span>
                </div>
                <button class="btn" onclick={() => app.sync(true)} disabled={app.syncing}>{app.syncing ? "Syncing…" : "Sync now"}</button>
              </div>
              {#if app.syncError}<div class="row"><span class="error small">Last sync: {app.syncError.message}</span></div>{/if}
              {#if app.vaultBytes}
                <div class="row">
                  <span class="row-desc" class:error={app.vaultBytes > 1e9}>
                    {(app.vaultBytes / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })} MB synced.
                    {app.vaultBytes > 1e9
                      ? "GitHub recommends keeping a repository under 1 GB: list big folders, such as videos, in the vault's .gitignore."
                      : "Files over 50 MB stay on the device they were added on."}
                  </span>
                </div>
              {/if}
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
          {#if !touch}
            <h4>Keys</h4>
            <div class="group">
              <label class="row">
                <span class="row-text">
                  <span class="row-label">Vim keys</span>
                  <span class="row-desc">Normal, insert and visual modes, and : commands. :w saves the note.</span>
                </span>
                <input type="checkbox" class="toggle" checked={prefs.value.vim} onchange={(e) => prefs.set({ vim: (e.currentTarget as HTMLInputElement).checked })} />
              </label>
              <div class="row">
                <span class="row-text">
                  <span class="row-label">Several cursors</span>
                  <span class="row-desc">⌥-click adds a cursor, ⌥-drag selects a column, ⌥⌘↑ or ⌥⌘↓ adds one above or below, Esc goes back to one.</span>
                </span>
              </div>
            </div>
          {/if}
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
          <!-- Only what this build can connect (or is connected, so it can be disconnected): no dead rows. -->
          {@const showGoogle = !!s?.configured.google || !!c?.google}
          {@const showOutlook = !!s?.configured.microsoft || !!c?.microsoft}
          {@const mail = showOutlook || (showGoogle && s?.configured.gmail !== false)}
          {#if showGoogle || showOutlook}
          <h4>Mail and calendars</h4>
          <div class="group">
            {#if showGoogle}{@render google()}{/if}
            {#if showOutlook}{@render connRow("Outlook", "Outlook mail and calendar", c?.microsoft ?? null, "microsoft", !!s?.configured.microsoft, true)}{/if}
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
          {/if}
          {#if s?.configured.apple}
          <h4>On this device</h4>
          <div class="group">
            {@render appleRow("Apple Calendar", "apple_calendar")}
            {@render appleRow("Apple Reminders", "apple_reminders")}
          </div>
          {/if}
          {#if isMac}
          <h4>On this Mac</h4>
          <div class="group">
            <div class="row">
              <div class="row-text">
                <span class="row-label">Claude Code</span>
                <span class="row-desc">Lets Claude search, read and edit this vault's notes and tasks.</span>
              </div>
              <button class="btn" onclick={copyClaude}>Copy setup command</button>
            </div>
          </div>
          {/if}
          {#if !showGoogle && !showOutlook && !s?.configured.apple}
            {#if !isMac}<p class="note">There's nothing to connect in this version yet.</p>{/if}
          {:else}
            <!-- What connecting means, kept last and quiet: the rows above are the page. -->
            <footer class="about">
              <Info size={16} aria-hidden="true" />
              <p>
                {mail ? "Mail, calendars and tasks" : "Calendars and tasks"} you connect appear in Today. Wandika only
                reads them, except when you tick off a task.
              </p>
            </footer>
          {/if}
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
              <span class="row-desc">Version 0.1.0 beta</span>
            </div>
            <div class="row">
              <div class="row-text">
                <span class="row-label">This is a beta</span>
                <span class="row-desc">Some things may not work yet. Your notes stay plain Markdown files, on this device and on GitHub.</span>
              </div>
              <button class="btn" onclick={() => openUrl(FEEDBACK)}>Send feedback</button>
            </div>
            <div class="row">
              <span class="row-label">Privacy</span>
              <button class="link-btn" onclick={() => openUrl(PRIVACY)}>Privacy policy</button>
            </div>
            <div class="row">
              <span class="row-label">Source</span>
              <button class="link-btn" onclick={() => openUrl("https://github.com/jordan-jakisa/wandika")}>github.com/jordan-jakisa/wandika</button>
            </div>
          </div>
          {#if !phone}
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
        {/if}
      </div>
    </div>
    {/key}
  {/if}
{/snippet}

{#if embedded}
  <section class="settings phone embedded" aria-labelledby="settings-title">
    {@render body()}
  </section>
{:else}
<dialog
  bind:this={dialogEl}
  oncancel={(e) => {
    e.preventDefault();
    close();
  }}
  aria-labelledby="settings-title"
  class="settings"
>
  {@render body()}
</dialog>
{/if}

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
    animation: pop-in var(--dur-quick) var(--ease-out);
  }
  .settings::backdrop {
    background: var(--scrim);
  }
  /* The phone's Settings tab: a page like Notes, with the tab's large title. */
  .settings.embedded {
    display: flex;
    flex-direction: column;
    width: auto;
    height: auto;
    min-height: 100%;
    border: 0;
    border-radius: 0;
    background: var(--paper);
    box-shadow: none;
    overflow: visible;
  }
  /* The tab's page scrolls with the phone body, like the other tabs. */
  /* The phone body already leaves room for the bar below. */
  .settings.embedded .pane-body {
    overflow: visible;
    padding-bottom: var(--space-6);
  }
  .settings.embedded .nav-head {
    padding: 12px 20px 6px;
  }
  .settings.embedded .pane-head {
    padding-top: 4px;
  }
  h2.large {
    font-size: var(--view-title-size);
    font-weight: var(--view-title-weight);
    letter-spacing: var(--view-title-tracking);
    line-height: var(--view-title-line);
  }

  .sections {
    background: var(--paper);
    border-right: 1px solid var(--rule);
    overflow-y: auto;
  }
  .phone .sections {
    flex: 1;
    border: 0;
    background: none;
  }
  .nav-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 16px 10px;
  }
  .phone .nav-head {
    padding: 12px 12px 10px 20px;
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
    background: var(--papyrus-selected);
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
    padding: 4px 8px 4px 4px;
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
    border-top: 1px solid var(--hairline);
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
  .place {
    max-width: 55%;
    min-width: 0;
  }
  /* Connections: what the rows mean, as the footer under them, left aligned with their text. */
  .about {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    margin: 8px 2px 0;
    color: var(--graphite);
  }
  .about :global(svg) {
    flex: none;
    width: 1.15em;
    height: 1.15em;
    margin-top: 0.1em;
  }
  .about p {
    margin: 0;
    font-size: var(--small);
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
