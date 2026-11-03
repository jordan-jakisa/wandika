import { api, codeOf, listen } from "./api";
import { forgetImages } from "./attachments";
import { forgetNoteEmbeds } from "./editor/embeds";
import { tip, touch } from "./tips";
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
const SESSION_KEY = "wandika.session";
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
  /** Goes up each time a different note is opened; the editor is keyed on it, so a rename doesn't remount. */
  openCount = $state(0);
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
  /** How far the running sync is, from the Rust core's "sync-progress" events. */
  syncProgress = $state<SyncProgress | null>(null);
  conflicts = $state<string[]>([]);
  tooBig = $state<string[]>([]);
  /** Files missing here that sync kept on GitHub, waiting for a decision. */
  heldDeletions = $state<string[]>([]);
  vaultBytes = $state(0);
  /** Paths changed on disk by the last sync, so an open editor can reload them. */
  changed = $state<{ paths: string[]; at: number }>({ paths: [], at: 0 });
  toast = $state<string | null>(null);
  toastAction = $state<{ label: string; run: () => void } | null>(null);
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
  #failures = 0;
  #retryAt = 0;

  // Where you were, per vault: the open note, the tab, the Today column and the Settings section.
  constructor() {
    if (typeof window === "undefined") return;
    $effect.root(() => {
      $effect(() => {
        const id = this.status?.vault?.id;
        if (!id) return;
        const session = { current: this.current, tab: this.tab, showToday: this.showToday, settingsSection: this.settingsSection };
        try {
          localStorage.setItem(`${SESSION_KEY}:${id}`, JSON.stringify(session));
        } catch {
          // Private mode or full storage: nothing is remembered, nothing breaks.
        }
      });
    });
  }

  #restore(vaultId: string) {
    let s: { current?: string | null; tab?: Tab; showToday?: boolean; settingsSection?: SettingsSection } = {};
    try {
      s = JSON.parse(localStorage.getItem(`${SESSION_KEY}:${vaultId}`) ?? "{}");
    } catch {
      return;
    }
    if (s.tab) this.tab = s.tab;
    if (typeof s.showToday === "boolean") this.showToday = s.showToday;
    if (s.settingsSection) this.settingsSection = s.settingsSection;
    if (s.current && this.tree.some((e) => e.path === s.current)) {
      this.openCount++;
      this.current = s.current;
    }
  }

  async init() {
    // The page can mount twice (dev reloads, a remount); one start, one listener, one sync.
    if (this.#started) return;
    this.#started = true;
    try {
      const status = await api.status();
      this.lastSync = status.last_sync;
      // Load the files before showing the workspace so it never flashes an empty vault.
      if (status.vault) {
        await this.refreshFiles();
        this.#restore(status.vault.id);
      }
      this.status = status;
      if (status.vault) void this.loadSnippets();
      if (status.vault?.remote) {
        this.startAutoSync();
        void this.sync();
      }
    } catch (e) {
      this.bootError = (e as Error).message;
    }
    listen<SyncProgress>("sync-progress", (p) => (this.syncProgress = p));
    listen<{ provider: string; error: string | null }>("connectors-changed", async (p) => {
      this.status = await api.status();
      this.say(p.error ?? `${p.provider === "google" ? "Google" : p.provider} is connected.`);
    });
  }

  async refreshStatus() {
    this.status = await api.status();
  }

  /**
   * Forgets what belonged to the vault being left: its sync results, held deletions, Today and
   * filters, so none of it shows in (or acts on) the next vault.
   */
  #leave(next: Status) {
    this.current = null;
    this.viewing = null;
    this.graphFocus = null;
    this.tagFilter = null;
    this.conflicts = [];
    this.tooBig = [];
    this.heldDeletions = [];
    this.vaultBytes = 0;
    this.syncError = null;
    this.syncProgress = null;
    this.lastSync = next.last_sync;
    this.today = null;
    this.#todayAt = 0;
    this.#failures = 0;
    this.#retryAt = 0;
    forgetImages();
  }

  /** Shows a vault just opened, created or connected; GitHub vaults then keep syncing. */
  async enterVault(report?: SyncReport) {
    const first = this.lastSync === null;
    const before = this.status?.vault?.id;
    await this.refreshFiles();
    const status = await api.status();
    // Connecting or disconnecting GitHub keeps the open note; a different vault starts fresh.
    // Everything changes before `status` does, so the session saved for the new vault is its own.
    if (status.vault?.id !== before) {
      this.#leave(status);
      if (status.vault) this.#restore(status.vault.id);
    }
    this.status = status;
    if (report) {
      this.apply(report);
      this.#failures = 0;
      this.#retryAt = 0;
      if (first) this.say("Your notes are on GitHub. Every device you sign in on gets them.");
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
    forgetNoteEmbeds();
    clearTimeout(this.#editTimer);
    if (!this.synced) return;
    this.#editTimer = setTimeout(() => void this.sync(), SYNC_AFTER_EDIT_MS);
  }

  /** `manual`: you asked for it (button, pull, ⌘S), so it says what happened. */
  async sync(manual = false) {
    if (this.syncing || !this.status?.vault?.remote) return;
    // After failures, automatic syncs wait longer each time (3, 6, 12 … up to 48 minutes), so a
    // problem on GitHub's side isn't met with a steady stream of retries. Asking always tries.
    if (!manual && Date.now() < this.#retryAt) return;
    this.syncing = true;
    clearTimeout(this.#editTimer);
    try {
      await this.flush();
      const report: SyncReport = await api.syncNow();
      const first = this.lastSync === null;
      this.apply(report);
      this.syncError = null;
      if (first) this.say("Your notes are on GitHub. Every device you sign in on gets them.");
      else if (manual) this.say(syncSummary(report));
    } catch (e) {
      const code = codeOf(e);
      if (code !== "sync_busy" && code !== "cancelled") {
        this.syncError = { code, message: (e as Error).message };
        this.#failures++;
        this.#retryAt = Date.now() + Math.min(16, 2 ** (this.#failures - 1)) * SYNC_EVERY_MS;
      }
    } finally {
      this.syncing = false;
      this.syncProgress = null;
    }
  }

  apply(report: SyncReport) {
    this.lastSync = report.at;
    if (report.conflicts.length) this.conflicts = [...new Set([...this.conflicts, ...report.conflicts])];
    this.tooBig = report.too_big;
    this.heldDeletions = report.held_deletions ?? [];
    this.vaultBytes = report.vault_bytes ?? 0;
    const touched = [...report.pulled, ...report.merged, ...report.removed];
    if (touched.length) forgetNoteEmbeds();
    if (touched.length || report.conflicts.length) {
      this.changed = { paths: touched, at: Date.now() };
      void this.refreshFiles();
      if (touched.some((p) => p.startsWith(".obsidian/"))) void this.loadSnippets();
    }
  }

  #opened = 0;

  open(path: string) {
    if (path !== this.current) this.openCount++;
    if (touch && ++this.#opened === 3) {
      tip("long-press", "Tip: press and hold a note in the list for rename, encrypt and more.", (t) => this.say(t));
    }
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

  /** Asks for a name, creates the folder under `parent` and starts a note in it. */
  async newFolder(parent = "") {
    const name = await this.ask({ title: "New folder", confirm: "Create folder", input: { label: "Folder name", value: "" } });
    if (!name?.trim()) return null;
    const path = parent ? `${parent}/${name.trim()}` : name.trim();
    try {
      await api.folderCreate(path);
      await this.newNote(path);
      return path;
    } catch (e) {
      this.say((e as Error).message);
      return null;
    }
  }

  /** Held deletions: `true` deletes them on GitHub and every device; `false` brings them back. */
  async resolveHeld(del: boolean) {
    const paths = this.heldDeletions;
    if (del) {
      const ok = await this.ask({
        title: `Delete ${paths.length} files everywhere?`,
        message: "They go from GitHub and from every device on its next sync. GitHub's history still has them.",
        confirm: "Delete everywhere",
        danger: true,
      });
      if (ok === null) return;
    }
    try {
      await api.syncHeldDeletions(del, paths);
      this.heldDeletions = [];
      if (del) await this.sync(true);
      else {
        await this.refreshFiles();
        this.say(`${paths.length} files are back.`);
      }
    } catch (e) {
      this.say((e as Error).message);
    }
  }

  /** Confirms, then moves a note, file or folder to the vault's .trash folder. */
  async trash(path: string, name: string, folder = false) {
    const what = folder ? `the folder “${name}” and everything in it` : `“${name}”`;
    const ok = await this.ask({
      title: `Move ${what} to the trash?`,
      message: "It goes to the vault's .trash folder, where you can restore it.",
      confirm: "Move to trash",
      danger: true,
    });
    if (ok === null) return false;
    try {
      await api.entryTrash(path);
    } catch (e) {
      this.say((e as Error).message);
      return false;
    }
    if (this.current === path || this.current?.startsWith(path + "/")) this.current = null;
    await this.refreshFiles();
    this.edited();
    this.say(`Moved “${name}” to the trash.`, {
      label: "Undo",
      run: async () => {
        try {
          await api.entryRestore(path);
          await this.refreshFiles();
          this.edited();
          if (!folder) this.open(path);
        } catch (e) {
          this.say((e as Error).message);
        }
      },
    });
    return true;
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

  /** A short message at the bottom. With `action`, it carries one button (Undo) and stays longer. */
  say(message: string, action?: { label: string; run: () => void }) {
    this.toast = message;
    this.toastAction = action ?? null;
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => {
      this.toast = null;
      this.toastAction = null;
    }, action ? 6000 : 4000);
  }

  async switchVault() {
    await this.flush();
    this.stopAutoSync();
    await api.vaultClose();
    // Read before changing anything, so the vault left keeps its open note for next time.
    const status = await api.status();
    this.#leave(status);
    this.tree = [];
    this.titles = [];
    this.settingsOpen = false;
    this.status = status;
  }

  /** Local vaults stay open; a GitHub vault closes with the sign-in. */
  async signOut() {
    await this.flush();
    const closes = this.synced;
    this.stopAutoSync();
    await api.githubSignOut();
    const status = await api.status();
    if (closes) {
      this.#leave(status);
      this.tree = [];
      this.titles = [];
    }
    this.settingsOpen = false;
    this.status = status;
  }
}

export const app = new AppState();

export interface SyncProgress {
  phase: "checking" | "downloading" | "uploading" | "saving";
  done: number;
  total: number;
}

/** A running sync in a few words: "Uploading 312 of 2,597 files". */
export function progressText(p: SyncProgress | null) {
  const n = (x: number) => x.toLocaleString();
  if (!p || p.phase === "checking") return "Comparing your notes with GitHub…";
  if (p.phase === "saving") return "Saving to GitHub…";
  const verb = p.phase === "downloading" ? "Downloading" : "Uploading";
  return p.total ? `${verb} ${n(p.done)} of ${n(p.total)} files` : `${verb} your notes…`;
}

/** One line for a sync you started yourself. */
export function syncSummary(r: SyncReport) {
  const came = new Set([...r.pulled, ...r.merged, ...r.removed]).size;
  const notes = (n: number) => `${n} ${n === 1 ? "note" : "notes"}`;
  if (came && r.pushed.length) return `${notes(came)} updated, and your changes are on GitHub.`;
  if (came) return `${notes(came)} updated.`;
  if (r.pushed.length) return "Your changes are on GitHub.";
  return "Everything is up to date.";
}

export function titleOf(path: string) {
  return path.split("/").pop()!.replace(/\.age$/, "").replace(/\.md$/, "");
}

export function ago(ms: number | null, now = Date.now()) {
  if (!ms) return "not yet";
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
