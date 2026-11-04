import { api, codeOf, listen, openUrl } from "./api";
import { mailRef, type MailRef } from "./mailLinks";
import { forgetImages } from "./attachments";
import { forgetNoteEmbeds } from "./editor/embeds";
import { TEMPLATE } from "./kanban";
import { parseTask } from "./taskText";
import type { Entry, NoteMeta, Snippet, Status, SyncReport, Today, VaultTask } from "./types";

export type Tab = "notes" | "today" | "tasks" | "projects" | "graph" | "search" | "settings";
const TABS: Tab[] = ["notes", "today", "tasks", "projects", "graph", "search"];

export type SettingsSection = "vault" | "appearance" | "editor" | "encryption" | "connections" | "account" | "about";
const SECTIONS: SettingsSection[] = ["vault", "appearance", "editor", "encryption", "connections", "account", "about"];

export interface Ask {
  title: string;
  message?: string;
  confirm: string;
  /** The button that keeps things as they are; "Cancel" unless that would mean the opposite. */
  cancel?: string;
  danger?: boolean;
  input?: { label: string; value: string };
  /** A list to pick from instead of a confirm button; resolves with the picked value. */
  choices?: { label: string; value: string }[];
  resolve: (value: string | null) => void;
}

const SYNC_AFTER_EDIT_MS = 20_000;
/** A task's name as people read it in a message, without its markers; long ones are cut. */
const taskName = (text: string) => {
  const name = parseTask(text).name;
  return name.length > 40 ? `${name.slice(0, 39).trimEnd()}…` : name;
};
const SESSION_KEY = "wandika.session";
const SYNC_EVERY_MS = 3 * 60_000;
/** How often the app looks for notes changed by Claude Code. */
const OUTSIDE_EVERY_MS = 3_000;
/** Mail and calendars are fetched at most this often unless asked; vault tasks are always fresh. */
const TODAY_TTL_MS = 2 * 60_000;
/** A Today load that hasn't answered by then is given up, so one hung call can't hold Today and Tasks. */
const TODAY_WAIT_MS = 30_000;

/** `p`, or a rejection with `message` once `ms` have passed without an answer. */
function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

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
  /** The drawing open on the pad: a new one for `note`, or one to change, found the way the embed
   *  `target` in note `from` is. `saved` hears where a new drawing went, so the note can embed it. */
  drawing = $state<{ note: string; edit: { target: string; from: string } | null; saved?: (path: string) => void } | null>(null);
  /** The voice sheet: open while it listens; `done` hears the words when you tap Done. */
  voice = $state<{ title: string; done: (text: string) => void | Promise<void> } | null>(null);
  /** The email open in the reader; `url` opens it in the mail app on the web. */
  reading = $state<(MailRef & { url: string | null }) | null>(null);
  /** The task open in the task editor. */
  editingTask = $state<VaultTask | null>(null);
  /** Mac: Today fills the window, for a while of working only from it. */
  todayFull = $state(false);
  settingsOpen = $state(false);
  /** The page open in the phone's Settings tab; `null` shows the list of sections. */
  settingsPage = $state<SettingsSection | null>(null);
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
  /** Why Today couldn't load, while there's nothing loaded to show instead. */
  todayError = $state<string | null>(null);
  /** The vault's tasks as last listed, so Tasks shows them at once and refreshes behind. */
  vaultTasks = $state<VaultTask[] | null>(null);
  snippets = $state<Snippet[]>([]);
  /** Counts for the open note, shown in the status bar. `cards` is set for boards. */
  noteStats = $state({ words: 0, chars: 0, cards: null as number | null, backlinks: 0, encrypted: false });
  #todayAt = 0;
  #todayLoading: Promise<void> | null = null;
  #todayFull = false;

  /** Set by the editor so pending typing is saved before a sync reads the files. */
  flush: () => Promise<void> = async () => {};

  #editTimer: ReturnType<typeof setTimeout> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #watch: ReturnType<typeof setInterval> | undefined;
  /** Changes made outside the app up to this time are already shown. */
  #outsideSeen = Date.now();
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
    let s: { current?: unknown; tab?: unknown; showToday?: unknown; settingsSection?: unknown };
    try {
      s = JSON.parse(localStorage.getItem(`${SESSION_KEY}:${vaultId}`) ?? "{}");
    } catch {
      return;
    }
    // Saved by an older version, edited by hand or cut short: take only what is still valid.
    if (!s || typeof s !== "object") return;
    if (TABS.includes(s.tab as Tab)) this.tab = s.tab as Tab;
    if (typeof s.showToday === "boolean") this.showToday = s.showToday;
    if (SECTIONS.includes(s.settingsSection as SettingsSection)) this.settingsSection = s.settingsSection as SettingsSection;
    if (typeof s.current === "string" && this.tree.some((e) => e.path === s.current)) {
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
      this.#watchOutside();
      if (status.vault?.remote) {
        this.startAutoSync();
        void this.sync();
      }
    } catch (e) {
      this.bootError = (e as Error).message;
    }
    listen<SyncProgress>("sync-progress", (p) => (this.syncProgress = p));
    listen<{ provider: string; error: string | null }>("connectors-changed", async (p) => {
      await this.refreshStatus().catch(() => {});
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
    this.vaultTasks = null;
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

  /** Claude Code can change notes through `wandika mcp` while the app is open; every few seconds the
   *  app looks for those changes, so an open note and the file list show them. */
  #watchOutside() {
    clearInterval(this.#watch);
    this.#watch = setInterval(() => {
      if (document.visibilityState === "visible" && this.status?.vault) void this.checkOutside();
    }, OUTSIDE_EVERY_MS);
  }

  async checkOutside() {
    const list = await api.externalChanges().catch(() => []);
    const fresh = list.filter((c) => c.at > this.#outsideSeen);
    if (!fresh.length) return;
    this.#outsideSeen = Math.max(...fresh.map((c) => c.at));
    const paths = [...new Set(fresh.map((c) => c.path))];
    await this.refreshFiles();
    this.changed = { paths, at: Date.now() };
    this.edited();
    // The open note changing under you says who changed it.
    if (this.current && paths.includes(this.current)) this.say(`Claude Code changed “${titleOf(this.current)}”.`);
    else if (paths.length) this.say(paths.length === 1 ? `Claude Code changed “${titleOf(paths[0])}”.` : `Claude Code changed ${paths.length} notes.`);
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
      this.#failures = 0;
      this.#retryAt = 0;
      if (first) this.say("Your notes are on GitHub. Every device you sign in on gets them.");
      else if (manual) this.say(syncSummary(report));
    } catch (e) {
      const code = codeOf(e);
      if (code !== "sync_busy" && code !== "cancelled") {
        this.syncError = { code, message: (e as Error).message };
        this.#failures++;
        this.#retryAt = Date.now() + Math.min(16, 2 ** (this.#failures - 1)) * SYNC_EVERY_MS;
        // A sync you asked for says why it failed, wherever you asked from.
        if (manual) this.say((e as Error).message, { label: "Try again", run: () => void this.sync(true) });
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

  /** Notes opened this session; after a few, the Notes list teaches its long-press menu. */
  notesOpened = 0;

  /** Notes left behind and gone back from, for ⌘[ and ⌘]. */
  #back: string[] = [];
  #forward: string[] = [];

  open(path: string, viaHistory = false) {
    if (!viaHistory && this.current && path !== this.current) {
      this.#back.push(this.current);
      this.#forward = [];
    }
    if (path !== this.current) this.openCount++;
    this.notesOpened++;
    // A note opened from full-screen Today shows, instead of opening behind it.
    this.todayFull = false;
    this.current = path;
    this.graphFocus = path;
    this.switcherOpen = false;
    this.tab = "notes";
  }

  /** ⌘[: the note before this one. */
  goBack() {
    const prev = this.#back.pop();
    if (!prev) return;
    if (this.current) this.#forward.push(this.current);
    this.open(prev, true);
  }

  /** ⌘]: the note gone back from. */
  goForward() {
    const next = this.#forward.pop();
    if (!next) return;
    if (this.current) this.#back.push(this.current);
    this.open(next, true);
  }

  /** All tasks, in the main column: leaves the open note and full-screen Today. */
  showTasks() {
    this.current = null;
    this.todayFull = false;
    this.tab = "tasks";
  }

  async openDaily() {
    try {
      const path = await api.dailyNote();
      await this.refreshFiles();
      this.open(path);
    } catch (e) {
      this.say((e as Error).message);
    }
  }

  /** Asks for a name, creates the folder under `parent` and starts a note in it. */
  async newFolder(parent = "") {
    const name = await this.ask({ title: "New folder", confirm: "Create folder", input: { label: "Folder name", value: "" } });
    if (!name?.trim()) return null;
    const path = parent ? `${parent}/${name.trim()}` : name.trim();
    try {
      await api.folderCreate(path);
      await this.newNote(path);
      // An empty folder has nothing to sync, so say what makes it travel.
      this.say(this.synced ? `Made “${name.trim()}”. It reaches your other devices once a note is in it.` : `Made “${name.trim()}”.`);
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
        title: paths.length === 1 ? "Delete 1 file everywhere?" : `Delete ${paths.length} files everywhere?`,
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
        this.say(paths.length === 1 ? "1 file is back." : `${paths.length} files are back.`);
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
    try {
      return await this.#create(folder ?? (await this.newNoteFolder()), "Untitled");
    } catch (e) {
      this.say((e as Error).message);
      return null;
    }
  }

  /** A note that starts as a drawing: the pad opens, and Done makes a note holding the drawing. */
  async newDrawing() {
    const folder = await this.newNoteFolder();
    this.drawing = {
      // Where the note will be, so the drawing goes where its attachments would.
      note: folder ? `${folder}/Drawing.md` : "Drawing.md",
      edit: null,
      saved: async (rel) => {
        const name = rel.split("/").pop()!;
        try {
          await this.#create(folder, name.replace(/\.svg$/i, ""), `![[${name}]]\n`);
        } catch (e) {
          this.say((e as Error).message);
        }
      },
    };
  }

  /** A note made by speaking: its first words name it. */
  newVoiceNote() {
    this.voice = {
      title: "New voice note",
      done: async (text) => {
        try {
          await this.#create(await this.newNoteFolder(), voiceTitle(text), `${text.trim()}\n`);
        } catch (e) {
          this.say((e as Error).message);
        }
      },
    };
  }

  /** iPhone: voice notes made from the Lock Screen or Control Center go into their daily notes. */
  async importCaptures() {
    try {
      const paths = await api.capturesImport();
      if (!paths.length) return;
      await this.refreshFiles();
      this.changed = { paths, at: Date.now() };
      this.say(paths.length === 1 ? `Your voice notes are in ${titleOf(paths[0])}.` : `Your voice notes are in ${paths.length} daily notes.`, {
        label: "Open",
        run: () => this.open(paths[paths.length - 1]),
      });
    } catch (e) {
      this.say((e as Error).message);
    }
  }

  async newBoard() {
    const name = await this.ask({ title: "New board", confirm: "Create board", input: { label: "Board name", value: "" } });
    if (!name?.trim()) return;
    try {
      await this.#create("Projects", name.trim(), TEMPLATE);
    } catch (e) {
      this.say((e as Error).message);
    }
  }

  /** Creates a note and opens it. Buttons call the actions above without waiting, so they say failures. */
  async #create(folder: string, title: string, body?: string) {
    const path = await api.noteCreate(folder, title, body);
    await this.refreshFiles();
    this.open(path);
    this.edited();
    return path;
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
    try {
      const found = await api.resolveLink(clean);
      if (found) return this.open(found);
      const slash = clean.lastIndexOf("/");
      const folder = slash >= 0 ? clean.slice(0, slash) : await this.newNoteFolder();
      await this.#create(folder, clean.slice(slash + 1));
    } catch (e) {
      this.say((e as Error).message);
    }
  }

  /**
   * Today's events, mail and tasks. Network sources are reused for two minutes; within that
   * window only the vault's own tasks are re-read, which costs no network.
   */
  async loadToday(force = false): Promise<void> {
    // A refresh you asked for waits for a tasks-only one in flight, then fetches everything.
    if (this.#todayLoading) return force && !this.#todayFull ? this.#todayLoading.then(() => this.loadToday(true)) : this.#todayLoading;
    const fresh = Date.now() - this.#todayAt < TODAY_TTL_MS;
    this.#todayFull = force || !fresh || !this.today;
    this.todayError = null;
    this.#todayLoading = (async () => {
      try {
        const slow = "Today is taking too long to load. Try again in a moment.";
        if (!this.#todayFull) {
          const tasks = await within(api.tasksVault(), TODAY_WAIT_MS, slow);
          // Left alone when the vault changed meanwhile and Today was cleared.
          if (this.today) this.today = { ...this.today, tasks: tasks.filter((t) => !t.done) };
        } else {
          this.today = await within(api.today(), TODAY_WAIT_MS, slow);
          this.#todayAt = Date.now();
        }
      } catch (e) {
        // With nothing to show, Today keeps the failure on screen with a way to try again.
        if (this.today) this.say((e as Error).message);
        else this.todayError = (e as Error).message;
      } finally {
        this.#todayLoading = null;
      }
    })();
    return this.#todayLoading;
  }

  /** Opens Settings, optionally at one section (e.g. Connections from Today). */
  openSettings(section?: SettingsSection) {
    // Phones keep Settings as a tab; a link to a section opens that page in it.
    if (typeof window !== "undefined" && window.innerWidth < 900) {
      this.current = null;
      this.tab = "settings";
      this.settingsPage = section ?? null;
      if (section) this.settingsSection = section;
      return;
    }
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
  /** A link from a note or Today: an email from a connected mailbox opens in Wandika, the rest in the browser. */
  openLink(url: string) {
    const ref = mailRef(url);
    const c = this.status?.connectors;
    if (ref && c && (ref.source === "google" ? c.google : c.microsoft)) {
      this.reading = { ...ref, url };
      return;
    }
    void openUrl(url);
  }

  /** Opens the task sheet empty: Save adds the task to today's daily note, with its tag. */
  newTask() {
    this.editingTask = { path: "", title: "", line: -1, text: "", done: false, due: null, details: "" };
  }

  /** Adds a task to today's note and says where it went. */
  async addTask(text: string) {
    try {
      const path = await api.taskAdd(text);
      this.edited();
      this.changed = { paths: [path], at: Date.now() };
      this.say("Added to today's note.", { label: "Open", run: () => this.open(path) });
    } catch (e) {
      this.say((e as Error).message);
    }
  }

  /** Deletes a task and its notes from their note, with Undo. */
  async deleteTask(t: VaultTask): Promise<boolean> {
    try {
      const taken = await api.taskDelete(t.path, t.line, t.text);
      this.#taskChanged(t.path);
      this.say(`Deleted “${taskName(t.text)}”.`, {
        label: "Undo",
        run: () => void this.#undoTask(t.path, () => api.taskRestore(t.path, t.line, taken)),
      });
      return true;
    } catch (e) {
      this.taskFailed(e, t.path);
      return false;
    }
  }

  /** Moves a task and its notes to the vault's archive note, with Undo. */
  async archiveTask(t: VaultTask): Promise<boolean> {
    try {
      const done = await api.taskArchive(t.path, t.line, t.text);
      this.#taskChanged(t.path, done.archive);
      this.say(`Archived “${taskName(t.text)}”.`, {
        label: "Undo",
        run: () => void this.#undoTask(t.path, () => api.taskUnarchive(done, t.path, t.line), done.archive),
      });
      return true;
    } catch (e) {
      this.taskFailed(e, t.path);
      return false;
    }
  }

  /** Says why a task action failed; a task that changed in its note reloads the lists first, so
   *  the next try works on what the note now says. */
  taskFailed(e: unknown, path?: string, what?: string) {
    if (codeOf(e) === "stale_task") {
      this.changed = { paths: path ? [path] : [], at: Date.now() };
      return this.say((e as Error).message);
    }
    this.say(what ? `${what} ${(e as Error).message}` : (e as Error).message);
  }

  #taskChanged(...paths: string[]) {
    this.edited();
    this.changed = { paths, at: Date.now() };
  }

  async #undoTask(path: string, undo: () => Promise<void>, archive?: string) {
    try {
      await undo();
      this.#taskChanged(path, ...(archive ? [archive] : []));
    } catch (e) {
      this.say((e as Error).message);
    }
  }

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

/** A note name from what was said: the first words, up to about 60 characters, without the
 *  characters a file name can't hold. An empty or unusable start gets the date and time. */
export function voiceTitle(text: string, now = new Date()) {
  const first = text.trim().split("\n")[0].replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
  if (first.length >= 2) {
    if (first.length <= 60) return first.replace(/[.!?,;]+$/, "");
    const cut = first.slice(0, 60);
    return (cut.slice(0, cut.lastIndexOf(" ")) || cut).replace(/[.!?,;]+$/, "");
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Voice note ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
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
