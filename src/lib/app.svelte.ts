import { api, codeOf, listen } from "./api";
import { forgetImages } from "./attachments";
import { TEMPLATE } from "./kanban";
import type { Entry, NoteMeta, Snippet, Status, SyncReport, Today } from "./types";

export type Tab = "notes" | "today" | "tasks" | "projects" | "graph" | "search";

export type SettingsSection = "vault" | "appearance" | "editor" | "encryption" | "connections" | "account" | "about";

export interface Ask {
  title: string;
  message?: string;
  confirm: string;
  danger?: boolean;
  input?: { label: string; value: string };
  /** A list to pick from instead of a confirm button; resolves with the picked value. */
  choices?: { label: string; value: string }[];
  resolve: (value: string | null) => void;
}

const SYNC_AFTER_EDIT_MS = 20_000;
const SYNC_EVERY_MS = 3 * 60_000;
/** Mail and calendars are fetched at most this often unless asked; vault tasks are always fresh. */
const TODAY_TTL_MS = 2 * 60_000;

class AppState {
  status = $state<Status | null>(null);
  bootError = $state<string | null>(null);
  tree = $state<Entry[]>([]);
  titles = $state<NoteMeta[]>([]);
  current = $state<string | null>(null);
  tab = $state<Tab>("notes");
  showToday = $state(true);
  switcherOpen = $state(false);
  /** Vault path of the image open in the viewer. */
  viewing = $state<string | null>(null);
  settingsOpen = $state(false);
  settingsSection = $state<SettingsSection>("vault");
  /** True when Settings was opened for one section, so phones skip the section list. */
  settingsDirect = $state(false);
  syncing = $state(false);
  /** The last sync failure, in plain words; `code` "offline" is shown as offline, not failed. */
  syncError = $state<{ code: string; message: string } | null>(null);
  lastSync = $state<number | null>(null);
  conflicts = $state<string[]>([]);
  tooBig = $state<string[]>([]);
  /** Paths changed on disk by the last sync, so an open editor can reload them. */
  changed = $state<{ paths: string[]; at: number }>({ paths: [], at: 0 });
  toast = $state<string | null>(null);
  dialog = $state<Ask | null>(null);
  /** Tag picked in the tag browser, on a card or in a note. */
  tagFilter = $state<string | null>(null);
  /** The note "Around this note" centres on: the last note opened. */
  graphFocus = $state<string | null>(null);
  today = $state<Today | null>(null);
  snippets = $state<Snippet[]>([]);
  /** Counts for the open note, shown in the status bar. `cards` is set for boards. */
  noteStats = $state({ words: 0, chars: 0, cards: null as number | null, backlinks: 0, encrypted: false });
  #todayAt = 0;
  #todayLoading: Promise<void> | null = null;

  /** Set by the editor so pending typing is saved before a sync reads the files. */
  flush: () => Promise<void> = async () => {};

  #editTimer: ReturnType<typeof setTimeout> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;

  get vault() {
    return this.status?.vault ?? null;
  }

  /** True when the open vault syncs with a GitHub repository. */
  get synced() {
    return !!this.status?.vault?.remote;
  }

  get vaultName() {
    const v = this.status?.vault;
    if (!v) return "";
    return v.remote ? `${v.remote.owner}/${v.remote.repo}` : v.name;
  }

  #started = false;

  async init() {
    // The page can mount twice (dev reloads, a remount); one start, one listener, one sync.
    if (this.#started) return;
    this.#started = true;
    try {
      const status = await api.status();
      this.lastSync = status.last_sync;
      // Load the files before showing the workspace so it never flashes an empty vault.
      if (status.vault) await this.refreshFiles();
      this.status = status;
      if (status.vault) void this.loadSnippets();
      if (status.vault?.remote) {
        this.startAutoSync();
        void this.sync();
      }
    } catch (e) {
      this.bootError = (e as Error).message;
    }
    listen<{ provider: string; error: string | null }>("connectors-changed", async (p) => {
      this.status = await api.status();
      this.say(p.error ?? `${p.provider === "google" ? "Google" : p.provider} is connected.`);
    });
  }

  async refreshStatus() {
    this.status = await api.status();
  }

  /** Shows a vault just opened, created or connected; GitHub vaults then keep syncing. */
  async enterVault(report?: SyncReport) {
    if (report) this.apply(report);
    const before = this.status?.vault?.id;
    await this.refreshFiles();
    await this.refreshStatus();
    // Connecting or disconnecting GitHub keeps the open note; a different vault starts fresh.
    if (this.status?.vault?.id !== before) {
      this.current = null;
      forgetImages();
    }
    void this.loadSnippets();
    this.stopAutoSync();
    if (this.synced) this.startAutoSync();
  }

  /** CSS snippets from the vault's .obsidian/snippets folder; the enabled ones are applied. */
  async loadSnippets() {
    this.snippets = this.status?.vault || this.vault ? await api.snippetsList().catch(() => []) : [];
    let el = document.getElementById("wandika-snippets");
    if (!el) {
      el = document.createElement("style");
      el.id = "wandika-snippets";
      document.head.appendChild(el);
    }
    el.textContent = this.snippets.filter((s) => s.enabled).map((s) => `/* ${s.name} */\n${s.css}`).join("\n");
  }

  async refreshFiles() {
    const [tree, titles] = await Promise.all([api.tree(), api.noteTitles()]);
    this.tree = tree;
    this.titles = titles;
  }

  startAutoSync() {
    clearInterval(this.#interval);
    this.#interval = setInterval(() => {
      if (document.visibilityState === "visible") void this.sync();
    }, SYNC_EVERY_MS);
  }

  stopAutoSync() {
    clearInterval(this.#interval);
    clearTimeout(this.#editTimer);
  }

  /** Called after every local save: sync once typing has paused for a while. */
  edited() {
    clearTimeout(this.#editTimer);
    if (!this.synced) return;
    this.#editTimer = setTimeout(() => void this.sync(), SYNC_AFTER_EDIT_MS);
  }

  async sync() {
    if (this.syncing || !this.status?.vault?.remote) return;
    this.syncing = true;
    clearTimeout(this.#editTimer);
    try {
      await this.flush();
      const report: SyncReport = await api.syncNow();
      this.apply(report);
      this.syncError = null;
    } catch (e) {
      const code = codeOf(e);
      if (code !== "sync_busy") this.syncError = { code, message: (e as Error).message };
    } finally {
      this.syncing = false;
    }
  }

  apply(report: SyncReport) {
    this.lastSync = report.at;
    if (report.conflicts.length) this.conflicts = [...new Set([...this.conflicts, ...report.conflicts])];
    this.tooBig = report.too_big;
    const touched = [...report.pulled, ...report.merged, ...report.removed];
    if (touched.length || report.conflicts.length) {
      this.changed = { paths: touched, at: Date.now() };
      void this.refreshFiles();
      if (touched.some((p) => p.startsWith(".obsidian/"))) void this.loadSnippets();
    }
  }

  open(path: string) {
    this.current = path;
    this.graphFocus = path;
    this.switcherOpen = false;
    this.tab = "notes";
  }

  async openDaily() {
    const path = await api.dailyNote();
    await this.refreshFiles();
    this.open(path);
  }

  /** A note in `folder`, or where Obsidian's settings put new notes. */
  async newNote(folder?: string) {
    folder ??= await this.newNoteFolder();
    const path = await api.noteCreate(folder, "Untitled");
    await this.refreshFiles();
    this.open(path);
    this.edited();
    return path;
  }

  async newBoard() {
    const name = await this.ask({ title: "New board", confirm: "Create board", input: { label: "Board name", value: "" } });
    if (!name?.trim()) return;
    const path = await api.noteCreate("Projects", name.trim(), TEMPLATE);
    await this.refreshFiles();
    this.open(path);
    this.edited();
  }

  /** The graph; `local` centres it on the open note. */
  showGraph(local = false) {
    if (this.current) this.graphFocus = this.current;
    this.graphLocal = local;
    this.current = null;
    this.tab = "graph";
  }
  graphLocal = $state(false);

  /** Shows every note with this tag. */
  showTag(tag: string) {
    this.tagFilter = tag;
    this.current = null;
    this.tab = "projects";
  }

  newNoteFolder() {
    return api.newNoteFolder(this.current).catch(() => "");
  }

  /** Follows a [[wikilink]], creating the note when it doesn't exist yet. */
  async follow(target: string) {
    const clean = target.split("|")[0].split("#")[0].trim();
    if (!clean) return;
    const found = await api.resolveLink(clean);
    if (found) return this.open(found);
    const slash = clean.lastIndexOf("/");
    const folder = slash >= 0 ? clean.slice(0, slash) : await this.newNoteFolder();
    const path = await api.noteCreate(folder, clean.slice(slash + 1));
    await this.refreshFiles();
    this.open(path);
    this.edited();
  }

  /**
   * Today's events, mail and tasks. Network sources are reused for two minutes; within that
   * window only the vault's own tasks are re-read, which costs no network.
   */
  async loadToday(force = false) {
    if (this.#todayLoading) return this.#todayLoading;
    const fresh = Date.now() - this.#todayAt < TODAY_TTL_MS;
    this.#todayLoading = (async () => {
      try {
        if (!force && fresh && this.today) {
          const tasks = await api.tasksVault();
          this.today = { ...this.today, tasks: tasks.filter((t) => !t.done) };
        } else {
          this.today = await api.today();
          this.#todayAt = Date.now();
        }
      } catch (e) {
        this.say((e as Error).message);
      } finally {
        this.#todayLoading = null;
      }
    })();
    return this.#todayLoading;
  }

  /** Opens Settings, optionally at one section (e.g. Connections from Today). */
  openSettings(section?: SettingsSection) {
    if (section) this.settingsSection = section;
    this.settingsDirect = !!section;
    this.settingsOpen = true;
  }

  /** In-app replacement for confirm()/prompt(), which mobile web views don't reliably show. */
  ask(opts: Omit<Ask, "resolve">): Promise<string | null> {
    this.dialog?.resolve(null);
    return new Promise((resolve) => {
      this.dialog = {
        ...opts,
        resolve: (v) => {
          this.dialog = null;
          resolve(v);
        },
      };
    });
  }

  say(message: string) {
    this.toast = message;
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => (this.toast = null), 4000);
  }

  async switchVault() {
    await this.flush();
    this.stopAutoSync();
    await api.vaultClose();
    this.current = null;
    this.tree = [];
    this.titles = [];
    this.settingsOpen = false;
    await this.refreshStatus();
  }

  /** Local vaults stay open; a GitHub vault closes with the sign-in. */
  async signOut() {
    await this.flush();
    const closes = this.synced;
    this.stopAutoSync();
    await api.githubSignOut();
    if (closes) this.current = null;
    this.settingsOpen = false;
    await this.refreshStatus();
  }
}

export const app = new AppState();

export function titleOf(path: string) {
  return path.split("/").pop()!.replace(/\.age$/, "").replace(/\.md$/, "");
}

export function ago(ms: number | null, now = Date.now()) {
  if (!ms) return "never";
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
