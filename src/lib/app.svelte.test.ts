import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { settle } from "../test/lib";
import type { SyncReport } from "./types";

// The app state runs against the browser mock of the Rust core. `faults` makes one command fail,
// and `heard` keeps the event listeners the app registers, so a test can play an event.
const faults = vi.hoisted(() => new Map<string, unknown>());
const heard = vi.hoisted(() => new Map<string, (p: unknown) => void>());
// Mocked modules survive vi.resetModules, so this stand-in forwards to a fresh real mock per test.
const real = vi.hoisted(() => ({ mock: null as null | typeof import("./mock") }));
const tried = vi.hoisted(() => new Map<string, number>());
/** Commands that never answer, like a request stuck on a dead connection. */
const hangs = vi.hoisted(() => new Set<string>());
vi.mock("./mock", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    tried.set(cmd, (tried.get(cmd) ?? 0) + 1);
    if (hangs.has(cmd)) return new Promise(() => {});
    return faults.has(cmd) ? Promise.reject(faults.get(cmd)) : real.mock!.invoke(cmd, args);
  },
  on: (event: string, fn: (p: unknown) => void) => (heard.set(event, fn), real.mock!.on(event, fn)),
}));
const embeds = vi.hoisted(() => ({ forgetNoteEmbeds: vi.fn() }));
vi.mock("./editor/embeds", () => embeds);
const tips = vi.hoisted(() => ({ tip: vi.fn(), touch: true }));
vi.mock("./tips", () => tips);

type App = typeof import("./app.svelte");

/** A fresh app and mock core; `?mock=vault` starts inside a GitHub vault. */
async function fresh(search = "?mock=vault") {
  history.replaceState(null, "", "/" + search);
  vi.resetModules();
  real.mock = await vi.importActual<typeof import("./mock")>("./mock");
  const mod: App = await import("./app.svelte");
  const { api } = await import("./api");
  // The runtime the fresh app was built with, to run its effects now.
  const { flushSync } = await import("svelte");
  return { ...mod, api, flushSync };
}

/** Starts the app and lets its first sync finish. */
async function started(search = "?mock=vault") {
  const f = await fresh(search);
  await settle(f.app.init());
  await vi.advanceTimersByTimeAsync(2000);
  return f;
}

/** How many times the app called `cmd`, failed calls included. */
const calls = (cmd: string) => tried.get(cmd) ?? 0;

const report = (over: Partial<SyncReport> = {}): SyncReport => ({
  pulled: [],
  pushed: [],
  removed: [],
  merged: [],
  conflicts: [],
  too_big: [],
  held_deletions: [],
  vault_bytes: 0,
  head: "abc",
  at: Date.now(),
  ...over,
});

/** Answers the open dialog. */
function answer(app: App["app"], value: string | null) {
  expect(app.dialog).not.toBeNull();
  app.dialog!.resolve(value);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 3, 10, 0));
  localStorage.clear();
  faults.clear();
  hangs.clear();
  heard.clear();
  embeds.forgetNoteEmbeds.mockClear();
  tips.tip.mockClear();
  tried.clear();
});

afterEach(() => {
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("pure helpers", () => {
  test("titleOf drops folders and note extensions", async () => {
    const { titleOf } = await fresh();
    expect(titleOf("Projects/Plan.md")).toBe("Plan");
    expect(titleOf("Private/Bank.md.age")).toBe("Bank");
    expect(titleOf("Plan.md")).toBe("Plan");
    expect(titleOf("a/b/photo.png")).toBe("photo.png");
    expect(titleOf("Café/日本.md")).toBe("日本");
    expect(titleOf("")).toBe("");
  });

  test("ago reads like a person would say it", async () => {
    const { ago } = await fresh();
    const now = new Date(2026, 10, 3, 12, 0).getTime();
    expect(ago(null, now)).toBe("not yet");
    expect(ago(0, now)).toBe("not yet");
    expect(ago(now, now)).toBe("just now");
    expect(ago(now - 44_000, now)).toBe("just now");
    expect(ago(now + 60_000, now)).toBe("just now");
    expect(ago(now - 45_000, now)).toBe("1 min ago");
    expect(ago(now - 59 * 60_000, now)).toBe("59 min ago");
    expect(ago(now - 60 * 60_000, now)).toBe("1 h ago");
    expect(ago(now - 23 * 3_600_000, now)).toBe("23 h ago");
    const old = now - 3 * 86_400_000;
    expect(ago(old, now)).toBe(new Date(old).toLocaleDateString(undefined, { day: "numeric", month: "short" }));
  });

  test("progressText says what a sync is doing", async () => {
    const { progressText } = await fresh();
    expect(progressText(null)).toBe("Comparing your notes with GitHub…");
    expect(progressText({ phase: "checking", done: 0, total: 0 })).toBe("Comparing your notes with GitHub…");
    expect(progressText({ phase: "saving", done: 0, total: 0 })).toBe("Saving to GitHub…");
    expect(progressText({ phase: "uploading", done: 312, total: 2597 })).toBe(`Uploading 312 of ${(2597).toLocaleString()} files`);
    expect(progressText({ phase: "downloading", done: 1, total: 2 })).toBe("Downloading 1 of 2 files");
    expect(progressText({ phase: "downloading", done: 0, total: 0 })).toBe("Downloading your notes…");
  });

  test("syncSummary counts each note once", async () => {
    const { syncSummary } = await fresh();
    expect(syncSummary(report())).toBe("Everything is up to date.");
    expect(syncSummary(report({ pushed: ["a.md"] }))).toBe("Your changes are on GitHub.");
    expect(syncSummary(report({ pulled: ["a.md"] }))).toBe("1 note updated.");
    expect(syncSummary(report({ pulled: ["a.md"], merged: ["a.md"], removed: ["b.md"] }))).toBe("2 notes updated.");
    expect(syncSummary(report({ pulled: ["a.md"], pushed: ["c.md"] }))).toBe("1 note updated, and your changes are on GitHub.");
  });
});

describe("start", () => {
  test("without a vault it shows the start screen", async () => {
    const { app } = await started("");
    expect(app.status?.vault).toBeNull();
    expect(app.vault).toBeNull();
    expect(app.synced).toBe(false);
    expect(app.vaultName).toBe("");
    expect(app.tree).toEqual([]);
    expect(app.bootError).toBeNull();
  });

  test("inside a GitHub vault it loads the files and syncs once", async () => {
    const { app } = await started();
    expect(app.vault?.id).toBe("github/jordan-jakisa/notes");
    expect(app.synced).toBe(true);
    expect(app.vaultName).toBe("jordan-jakisa/notes");
    expect(app.tree.some((e) => e.path === "Welcome.md")).toBe(true);
    expect(app.titles.some((t) => t.path === "Welcome.md")).toBe(true);
    expect(app.snippets.map((s) => s.name)).toEqual(["wide-tables", "rounded-cards"]);
    expect(calls("sync_now")).toBe(1);
    expect(app.lastSync).not.toBeNull();
    expect(app.toast).toBe("Your notes are on GitHub. Every device you sign in on gets them.");
  });

  test("starting twice starts once", async () => {
    const { app } = await fresh();
    await settle(Promise.all([app.init(), app.init()]));
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls("status")).toBe(1);
    expect(calls("sync_now")).toBe(1);
  });

  test("a failed start is shown as a boot error", async () => {
    faults.set("status", "The vault folder is gone.");
    const { app } = await started();
    expect(app.bootError).toBe("The vault folder is gone.");
    expect(app.status).toBeNull();
  });

  test("a connection change refreshes the status and says so", async () => {
    const { app } = await started("");
    heard.get("connectors-changed")!({ provider: "google", error: null });
    await settle(Promise.resolve());
    await vi.advanceTimersByTimeAsync(100);
    expect(app.toast).toBe("Google is connected.");
    heard.get("connectors-changed")!({ provider: "google", error: "Google sign-in was cancelled." });
    await vi.advanceTimersByTimeAsync(100);
    expect(app.toast).toBe("Google sign-in was cancelled.");
  });

  test("the message still shows when the status can't be read", async () => {
    const { app } = await started("");
    faults.set("status", "offline");
    heard.get("connectors-changed")!({ provider: "google", error: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(app.toast).toBe("Google is connected.");
  });

  test("sync progress events are shown while syncing", async () => {
    const { app } = await started();
    heard.get("sync-progress")!({ phase: "uploading", done: 3, total: 10 });
    expect(app.syncProgress).toEqual({ phase: "uploading", done: 3, total: 10 });
  });
});

describe("where you were", () => {
  test("the open note, tab, Today column and Settings section are kept per vault", async () => {
    const first = await started();
    first.app.open("Projects/Wandika.md");
    first.app.showToday = false;
    first.app.openSettings("appearance");
    first.flushSync();
    const saved = JSON.parse(localStorage.getItem("wandika.session:github/jordan-jakisa/notes")!);
    expect(saved).toEqual({ current: "Projects/Wandika.md", tab: "notes", showToday: false, settingsSection: "appearance" });

    const again = await started();
    expect(again.app.current).toBe("Projects/Wandika.md");
    expect(again.app.showToday).toBe(false);
    expect(again.app.settingsSection).toBe("appearance");
    expect(again.app.openCount).toBe(1);
  });

  test("a note that no longer exists is not reopened", async () => {
    localStorage.setItem("wandika.session:github/jordan-jakisa/notes", JSON.stringify({ current: "Gone.md", tab: "today" }));
    const { app } = await started();
    expect(app.current).toBeNull();
    expect(app.tab).toBe("today");
  });

  test.each([["not json"], ["null"], ["42"], ['"notes"'], ["[]"]])("a damaged session (%s) is ignored", async (raw) => {
    localStorage.setItem("wandika.session:github/jordan-jakisa/notes", raw);
    const { app } = await started();
    expect(app.bootError).toBeNull();
    expect(app.tab).toBe("notes");
    expect(app.current).toBeNull();
  });

  test("values from an older version are ignored one by one", async () => {
    localStorage.setItem(
      "wandika.session:github/jordan-jakisa/notes",
      JSON.stringify({ current: 7, tab: "inbox", showToday: "no", settingsSection: "billing" }),
    );
    const { app } = await started();
    expect(app.current).toBeNull();
    expect(app.tab).toBe("notes");
    expect(app.showToday).toBe(true);
    expect(app.settingsSection).toBe("vault");
  });

  test("storage that refuses writes breaks nothing", async () => {
    const { app, flushSync } = await started();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    app.open("Welcome.md");
    expect(() => flushSync()).not.toThrow();
    set.mockRestore();
  });
});

describe("vaults", () => {
  test("opening a GitHub vault from the start screen shows it and keeps syncing", async () => {
    const { app, api } = await started("");
    await settle(api.githubPollLogin("d"));
    const r = await settle(api.vaultOpen("jordan-jakisa", "notes"));
    await settle(app.enterVault(r));
    expect(app.vault?.remote?.repo).toBe("notes");
    expect(app.tree.length).toBeGreaterThan(0);
    expect(app.lastSync).toBe(r.at);
    expect(app.toast).toBe("Your notes are on GitHub. Every device you sign in on gets them.");
    const before = calls("sync_now");
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1000);
    expect(calls("sync_now")).toBe(before + 1);
  });

  test("a local vault doesn't sync", async () => {
    const { app, api } = await started("");
    await settle(api.vaultCreateLocal("Mine"));
    await settle(app.enterVault());
    expect(app.vaultName).toBe("Mine");
    expect(app.synced).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls("sync_now")).toBe(0);
  });

  test("connecting GitHub keeps the open note", async () => {
    const { app, api } = await started("");
    await settle(api.vaultCreateLocal("Mine"));
    await settle(app.enterVault());
    app.open("Welcome.md");
    const r = await settle(api.vaultConnectRemote("jordan-jakisa", "mine"));
    await settle(app.enterVault(r));
    expect(app.current).toBe("Welcome.md");
    expect(app.synced).toBe(true);
  });

  test("a different vault starts fresh, with nothing from the last one", async () => {
    const { app, api } = await started();
    app.open("Welcome.md");
    app.apply(report({ conflicts: ["Welcome (conflict).md"], held_deletions: ["Old.md"], too_big: ["big.zip"], vault_bytes: 9 }));
    app.syncError = { code: "offline", message: "You're offline." };
    app.showTag("idea");
    await settle(app.loadToday());
    await settle(api.vaultCreateLocal("Other"));
    await settle(app.enterVault());
    expect(app.vaultName).toBe("Other");
    expect(app.current).toBeNull();
    expect(app.conflicts).toEqual([]);
    expect(app.heldDeletions).toEqual([]);
    expect(app.tooBig).toEqual([]);
    expect(app.vaultBytes).toBe(0);
    expect(app.syncError).toBeNull();
    expect(app.tagFilter).toBeNull();
    expect(app.today).toBeNull();
  });

  test("each vault's session is its own when moving between them", async () => {
    const { app, api, flushSync } = await started();
    app.open("Welcome.md");
    app.tab = "graph";
    flushSync();
    await settle(app.switchVault());
    flushSync();
    // The vault left still remembers its note and tab.
    expect(JSON.parse(localStorage.getItem("wandika.session:github/jordan-jakisa/notes")!)).toMatchObject({ current: "Welcome.md", tab: "graph" });
    await settle(api.vaultCreateLocal("Other"));
    await settle(app.enterVault());
    flushSync();
    const other = app.vault!.id;
    // The new vault doesn't inherit the old one's tab.
    expect(JSON.parse(localStorage.getItem(`wandika.session:${other}`)!)).toMatchObject({ current: null });
    app.tab = "today";
    flushSync();
    await settle(app.switchVault());
    await settle(api.vaultSwitch("github/jordan-jakisa/notes"));
    await settle(app.enterVault());
    expect(app.current).toBe("Welcome.md");
    expect(app.tab).toBe("graph");
  });

  test("switching vault closes this one and clears the screen", async () => {
    const { app } = await started();
    app.open("Welcome.md");
    app.openSettings();
    await settle(app.switchVault());
    expect(app.status?.vault).toBeNull();
    expect(app.current).toBeNull();
    expect(app.tree).toEqual([]);
    expect(app.titles).toEqual([]);
    expect(app.settingsOpen).toBe(false);
    const before = calls("sync_now");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls("sync_now")).toBe(before);
  });

  test("signing out closes a GitHub vault", async () => {
    const { app } = await started();
    const flush = vi.fn(async () => {});
    app.flush = flush;
    app.open("Welcome.md");
    await settle(app.signOut());
    expect(flush).toHaveBeenCalled();
    expect(app.status?.user).toBeNull();
    expect(app.status?.vault).toBeNull();
    expect(app.current).toBeNull();
  });

  test("signing out keeps a local vault and its open note", async () => {
    const { app, api } = await started("");
    await settle(api.githubPollLogin("d"));
    await settle(api.vaultCreateLocal("Mine"));
    await settle(app.enterVault());
    app.open("Welcome.md");
    app.openSettings("account");
    await settle(app.signOut());
    expect(app.vaultName).toBe("Mine");
    expect(app.current).toBe("Welcome.md");
    expect(app.settingsOpen).toBe(false);
  });

  test("enabled CSS snippets are applied to the page", async () => {
    const { app, api } = await started();
    const style = document.getElementById("wandika-snippets")!;
    expect(style.textContent).toBe("/* rounded-cards */\n.card { border-radius: 14px; }");
    await settle(api.snippetToggle("wide-tables", true));
    await settle(app.loadSnippets());
    expect(document.querySelectorAll("#wandika-snippets")).toHaveLength(1);
    expect(style.textContent).toContain("/* wide-tables */");
  });

  test("no vault, no snippets", async () => {
    const { app } = await started("");
    await settle(app.loadSnippets());
    expect(app.snippets).toEqual([]);
    expect(document.getElementById("wandika-snippets")!.textContent).toBe("");
  });
});

describe("sync", () => {
  test("a sync you start says what happened", async () => {
    const { app } = await started();
    const flush = vi.fn(async () => {});
    app.flush = flush;
    await settle(app.sync(true));
    expect(flush).toHaveBeenCalled();
    expect(app.toast).toBe("Everything is up to date.");
    expect(app.syncing).toBe(false);
    expect(app.syncProgress).toBeNull();
  });

  test("only one sync runs at a time, and none without GitHub", async () => {
    const { app } = await started();
    const before = calls("sync_now");
    await settle(Promise.all([app.sync(true), app.sync(true)]));
    expect(calls("sync_now")).toBe(before + 1);

    app.stopAutoSync();
    const local = await started("");
    const now = calls("sync_now");
    await settle(local.app.sync(true));
    expect(calls("sync_now")).toBe(now);
  });

  test("a sync you asked for says why it failed, with Try again; an automatic one stays quiet", async () => {
    const { app } = await started();
    faults.set("sync_now", { code: "offline", message: "You're offline." });
    await settle(app.sync());
    expect(app.toast).not.toBe("You're offline.");
    await settle(app.sync(true));
    expect(app.toast).toBe("You're offline.");
    expect(app.toastAction?.label).toBe("Try again");
  });

  test("a failure is kept in plain words, and automatic syncs back off", async () => {
    const { app } = await started();
    faults.set("sync_now", { code: "offline", message: "You're offline." });
    await settle(app.sync());
    expect(app.syncError).toEqual({ code: "offline", message: "You're offline." });
    const before = calls("sync_now");
    // Within the first wait (3 minutes) an automatic sync doesn't try.
    vi.advanceTimersByTime(2 * 60_000);
    await settle(app.sync());
    expect(calls("sync_now")).toBe(before);
    // Asking always tries.
    await settle(app.sync(true));
    expect(calls("sync_now")).toBe(before + 1);
    // The second failure waits twice as long.
    vi.advanceTimersByTime(4 * 60_000);
    await settle(app.sync());
    expect(calls("sync_now")).toBe(before + 1);
    vi.advanceTimersByTime(3 * 60_000);
    await settle(app.sync());
    expect(calls("sync_now")).toBe(before + 2);
  });

  test("the wait between retries stops growing at 48 minutes", async () => {
    const { app } = await started();
    faults.set("sync_now", { code: "offline", message: "You're offline." });
    for (let i = 0; i < 8; i++) await settle(app.sync(true));
    const before = calls("sync_now");
    vi.advanceTimersByTime(47 * 60_000);
    await settle(app.sync());
    expect(calls("sync_now")).toBe(before);
    vi.advanceTimersByTime(2 * 60_000);
    await settle(app.sync());
    expect(calls("sync_now")).toBe(before + 1);
  });

  test("a sync that works clears the error and the wait", async () => {
    const { app } = await started();
    faults.set("sync_now", { code: "offline", message: "You're offline." });
    await settle(app.sync());
    faults.clear();
    await settle(app.sync(true));
    expect(app.syncError).toBeNull();
    const before = calls("sync_now");
    await settle(app.sync());
    expect(calls("sync_now")).toBe(before + 1);
  });

  test("a busy or cancelled sync is not an error", async () => {
    const { app } = await started();
    for (const code of ["sync_busy", "cancelled"]) {
      faults.set("sync_now", { code, message: "x" });
      await settle(app.sync());
      expect(app.syncError).toBeNull();
    }
    faults.clear();
    const before = calls("sync_now");
    await settle(app.sync());
    expect(calls("sync_now")).toBe(before + 1);
  });

  test("automatic syncs run every three minutes while the app is in front", async () => {
    const { app } = await started();
    const before = calls("sync_now");
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1000);
    expect(calls("sync_now")).toBe(before + 1);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(calls("sync_now")).toBe(before + 1);
    hidden.mockRestore();
    app.stopAutoSync();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls("sync_now")).toBe(before + 1);
  });

  test("an edit syncs once typing has paused for 20 seconds", async () => {
    const { app } = await started();
    const before = calls("sync_now");
    app.edited();
    await vi.advanceTimersByTimeAsync(15_000);
    app.edited();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls("sync_now")).toBe(before);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls("sync_now")).toBe(before + 1);
    expect(embeds.forgetNoteEmbeds).toHaveBeenCalled();
  });

  test("an edit in a local vault never syncs", async () => {
    const { app, api } = await started("");
    await settle(api.vaultCreateLocal("Mine"));
    await settle(app.enterVault());
    app.edited();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls("sync_now")).toBe(0);
    expect(embeds.forgetNoteEmbeds).toHaveBeenCalled();
  });

  test("a sync report updates conflicts, sizes and what changed", async () => {
    const { app } = await started();
    const titles = calls("note_titles");
    app.apply(report({ conflicts: ["a (conflict).md"], at: 5 }));
    app.apply(report({ conflicts: ["a (conflict).md", "b (conflict).md"], pulled: ["x.md"], removed: ["y.md"], too_big: ["v.mov"], held_deletions: ["z.md"], vault_bytes: 1234 }));
    expect(app.conflicts).toEqual(["a (conflict).md", "b (conflict).md"]);
    expect(app.tooBig).toEqual(["v.mov"]);
    expect(app.heldDeletions).toEqual(["z.md"]);
    expect(app.vaultBytes).toBe(1234);
    expect(app.changed.paths).toEqual(["x.md", "y.md"]);
    expect(embeds.forgetNoteEmbeds).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls("note_titles")).toBeGreaterThan(titles);
  });

  test("a report with nothing new reloads nothing", async () => {
    const { app } = await started();
    const titles = calls("note_titles");
    const changed = app.changed;
    app.apply(report({ pushed: ["a.md"] }));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls("note_titles")).toBe(titles);
    expect(app.changed).toBe(changed);
    expect(embeds.forgetNoteEmbeds).not.toHaveBeenCalled();
  });

  test("older reports without held deletions or size still apply", async () => {
    const { app } = await started();
    const old = { ...report(), held_deletions: undefined, vault_bytes: undefined } as unknown as SyncReport;
    app.apply(old);
    expect(app.heldDeletions).toEqual([]);
    expect(app.vaultBytes).toBe(0);
  });

  test("changes to Obsidian settings reload the snippets", async () => {
    const { app } = await started();
    const before = calls("snippets_list");
    app.apply(report({ pulled: [".obsidian/snippets/wide.css"] }));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls("snippets_list")).toBe(before + 1);
  });
});

describe("notes", () => {
  test("opening a note", async () => {
    const { app } = await started();
    app.switcherOpen = true;
    app.tab = "graph";
    const count = app.openCount;
    app.open("Welcome.md");
    expect(app.current).toBe("Welcome.md");
    expect(app.graphFocus).toBe("Welcome.md");
    expect(app.switcherOpen).toBe(false);
    expect(app.tab).toBe("notes");
    expect(app.openCount).toBe(count + 1);
    // The same note again doesn't remount the editor.
    app.open("Welcome.md");
    expect(app.openCount).toBe(count + 1);
  });

  test("opening notes counts them, so the Notes list can teach its long-press menu later", async () => {
    const { app } = await started();
    app.open("a.md");
    app.open("b.md");
    app.open("c.md");
    expect(app.notesOpened).toBe(3);
    expect(tips.tip).not.toHaveBeenCalled();
  });

  test("today's note opens", async () => {
    const { app } = await started();
    await settle(app.openDaily());
    expect(app.current).toBe("Daily/2026-11-03.md");
  });

  test("a new note is Untitled, next to the open one, and syncs later", async () => {
    const { app } = await started();
    app.open("Projects/Wandika.md");
    const path = await settle(app.newNote());
    expect(path).toBe("Projects/Untitled.md");
    expect(app.current).toBe(path);
    expect(app.tree.some((e) => e.path === path)).toBe(true);
    expect(await settle(app.newNote(""))).toBe("Untitled.md");
    expect(await settle(app.newNote())).toBe("Untitled 2.md");
  });

  test("an empty Untitled note left behind is deleted, one with text is kept", async () => {
    const { app, api } = await started();
    const empty = (await settle(app.newNote("")))!;
    const kept = (await settle(app.newNote("")))!;
    await settle(api.noteWrite(kept, "Buy milk"));
    expect(await settle(api.noteDiscardIfEmpty(empty))).toBe(true);
    expect(await settle(api.noteDiscardIfEmpty(kept))).toBe(false);
    await settle(app.refreshFiles());
    expect(app.tree.some((e) => e.path === empty)).toBe(false);
    expect(app.tree.some((e) => e.path === kept)).toBe(true);
  });

  test("a note that can't be created says why", async () => {
    const { app } = await started();
    faults.set("note_create", "Unlock encryption first.");
    const current = app.current;
    expect(await settle(app.newNote("Private"))).toBeNull();
    expect(app.toast).toBe("Unlock encryption first.");
    expect(app.current).toBe(current);
  });

  test("the new note folder falls back to the vault root", async () => {
    const { app } = await started();
    faults.set("new_note_folder", "no settings");
    expect(await settle(app.newNoteFolder())).toBe("");
  });

  test("a new folder asks for a name and starts a note in it", async () => {
    const { app } = await started();
    const made = app.newFolder("Projects");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.dialog?.title).toBe("New folder");
    answer(app, "  Ideas ");
    expect(await settle(made)).toBe("Projects/Ideas");
    expect(app.current).toBe("Projects/Ideas/Untitled.md");
  });

  test("a new folder at the top, or cancelled", async () => {
    const { app } = await started();
    let made = app.newFolder();
    answer(app, "Inbox");
    expect(await settle(made)).toBe("Inbox");
    made = app.newFolder();
    answer(app, null);
    expect(await settle(made)).toBeNull();
    made = app.newFolder();
    answer(app, "   ");
    expect(await settle(made)).toBeNull();
  });

  test("a folder that can't be made says why", async () => {
    const { app } = await started();
    faults.set("folder_create", "That name is taken.");
    const made = app.newFolder();
    answer(app, "Inbox");
    expect(await settle(made)).toBeNull();
    expect(app.toast).toBe("That name is taken.");
  });

  test("a new board goes in Projects with the board template", async () => {
    const { app, api } = await started();
    const made = app.newBoard();
    expect(app.dialog?.title).toBe("New board");
    answer(app, " Launch ");
    await settle(made);
    expect(app.current).toBe("Projects/Launch.md");
    const { TEMPLATE } = await import("./kanban");
    expect(await settle(api.noteRead("Projects/Launch.md"))).toBe(TEMPLATE);
    expect(app.titles.find((t) => t.path === "Projects/Launch.md")?.board).toBe(true);
  });

  test("a cancelled board makes nothing, a failed one says why", async () => {
    const { app } = await started();
    let made = app.newBoard();
    answer(app, "");
    await settle(made);
    expect(calls("note_create")).toBe(0);
    faults.set("note_create", "Disk full.");
    made = app.newBoard();
    answer(app, "Launch");
    await settle(made);
    expect(app.toast).toBe("Disk full.");
  });
});

describe("links", () => {
  test("a link to an existing note opens it", async () => {
    const { app } = await started();
    await settle(app.follow("Wandika"));
    expect(app.current).toBe("Projects/Wandika.md");
    await settle(app.follow("Reading list|my list"));
    expect(app.current).toBe("Reading list.md");
    await settle(app.follow("Projects/Wandika#Next"));
    expect(app.current).toBe("Projects/Wandika.md");
  });

  test("a link to a missing note creates it", async () => {
    const { app } = await started();
    app.open("Projects/Wandika.md");
    await settle(app.follow("Roadmap"));
    expect(app.current).toBe("Projects/Roadmap.md");
    await settle(app.follow("Areas/Health/Sleep"));
    expect(app.current).toBe("Areas/Health/Sleep.md");
    expect(app.tree.some((e) => e.path === "Areas/Health/Sleep.md")).toBe(true);
  });

  test("an empty link does nothing", async () => {
    const { app } = await started();
    await settle(app.follow("  |alias"));
    await settle(app.follow("#Heading"));
    expect(app.current).toBeNull();
    expect(calls("resolve_link")).toBe(0);
  });

  test("a link that can't be followed says why", async () => {
    const { app } = await started();
    await settle(app.follow("Projects/"));
    expect(app.toast).toBe("Give the note a name.");
  });
});

describe("trash", () => {
  test("asks first, and nothing happens when cancelled", async () => {
    const { app } = await started();
    const done = app.trash("Welcome.md", "Welcome");
    expect(app.dialog).toMatchObject({ title: "Move “Welcome” to the trash?", confirm: "Move to trash", danger: true });
    answer(app, null);
    expect(await settle(done)).toBe(false);
    expect(app.tree.some((e) => e.path === "Welcome.md")).toBe(true);
  });

  test("moves the note away, and Undo brings it back and opens it", async () => {
    const { app } = await started();
    app.open("Welcome.md");
    const done = app.trash("Welcome.md", "Welcome");
    answer(app, "");
    expect(await settle(done)).toBe(true);
    expect(app.current).toBeNull();
    expect(app.tree.some((e) => e.path === "Welcome.md")).toBe(false);
    expect(app.toast).toBe("Moved “Welcome” to the trash.");
    expect(app.toastAction?.label).toBe("Undo");
    app.toastAction!.run();
    await vi.advanceTimersByTimeAsync(500);
    expect(app.tree.some((e) => e.path === "Welcome.md")).toBe(true);
    expect(app.current).toBe("Welcome.md");
  });

  test("a folder goes with everything in it, and the open note inside it closes", async () => {
    const { app } = await started();
    app.open("Projects/Wandika.md");
    const done = app.trash("Projects", "Projects", true);
    expect(app.dialog?.title).toBe("Move the folder “Projects” and everything in it to the trash?");
    answer(app, "");
    await settle(done);
    expect(app.current).toBeNull();
    expect(app.tree.some((e) => e.path.startsWith("Projects"))).toBe(false);
    app.toastAction!.run();
    await vi.advanceTimersByTimeAsync(500);
    expect(app.tree.some((e) => e.path === "Projects/Wandika.md")).toBe(true);
    // A folder isn't opened as a note.
    expect(app.current).toBeNull();
  });

  test("a note with a similar name stays open", async () => {
    const { app, api } = await started();
    await settle(api.noteCreate("", "Projects2"));
    app.open("Projects2.md");
    const done = app.trash("Projects", "Projects", true);
    answer(app, "");
    await settle(done);
    expect(app.current).toBe("Projects2.md");
  });

  test("failures say why", async () => {
    const { app } = await started();
    faults.set("entry_trash", "It's open elsewhere.");
    let done = app.trash("Welcome.md", "Welcome");
    answer(app, "");
    expect(await settle(done)).toBe(false);
    expect(app.toast).toBe("It's open elsewhere.");
    faults.clear();
    done = app.trash("Welcome.md", "Welcome");
    answer(app, "");
    await settle(done);
    faults.set("entry_restore", "Something new has the same name there now, so it stays in the trash.");
    app.toastAction!.run();
    await vi.advanceTimersByTimeAsync(500);
    expect(app.toast).toBe("Something new has the same name there now, so it stays in the trash.");
  });
});

describe("held deletions", () => {
  test("bringing them back says how many", async () => {
    const { app } = await started();
    app.apply(report({ held_deletions: ["a.md", "b.md"] }));
    await settle(app.resolveHeld(false));
    expect(app.heldDeletions).toEqual([]);
    expect(app.toast).toBe("2 files are back.");
    expect(app.dialog).toBeNull();
  });

  test("one file reads as one file", async () => {
    const { app } = await started();
    app.apply(report({ held_deletions: ["a.md"] }));
    const done = app.resolveHeld(true);
    expect(app.dialog).toMatchObject({ title: "Delete 1 file everywhere?" });
    answer(app, null);
    await settle(done);
    await settle(app.resolveHeld(false));
    expect(app.toast).toBe("1 file is back.");
  });

  test("deleting them everywhere asks first, then syncs", async () => {
    const { app } = await started();
    app.apply(report({ held_deletions: ["a.md", "b.md", "c.md"] }));
    let done = app.resolveHeld(true);
    expect(app.dialog).toMatchObject({ title: "Delete 3 files everywhere?", confirm: "Delete everywhere", danger: true });
    answer(app, null);
    await settle(done);
    expect(app.heldDeletions).toHaveLength(3);
    const before = calls("sync_now");
    done = app.resolveHeld(true);
    answer(app, "");
    await settle(done);
    expect(app.heldDeletions).toEqual([]);
    expect(calls("sync_now")).toBe(before + 1);
  });

  test("a failure keeps them and says why", async () => {
    const { app } = await started();
    app.apply(report({ held_deletions: ["a.md"] }));
    faults.set("sync_held_deletions", "You're offline.");
    await settle(app.resolveHeld(false));
    expect(app.heldDeletions).toEqual(["a.md"]);
    expect(app.toast).toBe("You're offline.");
  });
});

describe("views and dialogs", () => {
  test("the graph centres on the open note", async () => {
    const { app } = await started();
    app.open("Welcome.md");
    app.showGraph(true);
    expect(app.tab).toBe("graph");
    expect(app.graphLocal).toBe(true);
    expect(app.graphFocus).toBe("Welcome.md");
    expect(app.current).toBeNull();
    app.showGraph();
    expect(app.graphLocal).toBe(false);
    expect(app.graphFocus).toBe("Welcome.md");
  });

  test("a tag shows every note with it", async () => {
    const { app } = await started();
    app.open("Welcome.md");
    app.showTag("idea");
    expect(app.tagFilter).toBe("idea");
    expect(app.tab).toBe("projects");
    expect(app.current).toBeNull();
  });

  test("Settings opens at a section, or where it was", async () => {
    const { app } = await started();
    app.openSettings("connections");
    expect(app).toMatchObject({ settingsOpen: true, settingsSection: "connections", settingsDirect: true });
    app.settingsOpen = false;
    app.openSettings();
    expect(app).toMatchObject({ settingsOpen: true, settingsSection: "connections", settingsDirect: false });
  });

  test("ask resolves with the answer and closes", async () => {
    const { app } = await started();
    const asked = app.ask({ title: "Name?", confirm: "OK", input: { label: "Name", value: "x" } });
    expect(app.dialog?.input?.value).toBe("x");
    answer(app, "Jordan");
    expect(await asked).toBe("Jordan");
    expect(app.dialog).toBeNull();
  });

  test("a second question cancels the first", async () => {
    const { app } = await started();
    const first = app.ask({ title: "One", confirm: "OK" });
    const second = app.ask({ title: "Two", confirm: "OK", choices: [{ label: "A", value: "a" }] });
    expect(await first).toBeNull();
    expect(app.dialog?.title).toBe("Two");
    answer(app, "a");
    expect(await second).toBe("a");
  });

  test("a message goes after 4 seconds, one with Undo after 6", async () => {
    const { app } = await started();
    app.say("Saved.");
    vi.advanceTimersByTime(3999);
    expect(app.toast).toBe("Saved.");
    vi.advanceTimersByTime(1);
    expect(app.toast).toBeNull();
    const run = vi.fn();
    app.say("Deleted.", { label: "Undo", run });
    vi.advanceTimersByTime(5999);
    expect(app.toastAction?.label).toBe("Undo");
    vi.advanceTimersByTime(1);
    expect(app.toast).toBeNull();
    expect(app.toastAction).toBeNull();
  });

  test("a new message replaces the last and restarts its time", async () => {
    const { app } = await started();
    app.say("One.", { label: "Undo", run: () => {} });
    vi.advanceTimersByTime(3000);
    app.say("Two.");
    expect(app.toastAction).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(app.toast).toBe("Two.");
    vi.advanceTimersByTime(1000);
    expect(app.toast).toBeNull();
  });
});

describe("Today", () => {
  test("loads events, mail and open tasks", async () => {
    const { app } = await started();
    await settle(app.loadToday());
    expect(app.today?.events).toHaveLength(4);
    expect(app.today?.mail).toHaveLength(2);
    expect(app.today?.tasks.every((t) => !t.done)).toBe(true);
  });

  test("within two minutes only the vault's tasks are read again", async () => {
    const { app, api } = await started();
    await settle(app.loadToday());
    const task = app.today!.tasks.find((t) => t.text === "Write your first note")!;
    await settle(api.taskToggle(task.path, task.line, task.text));
    vi.advanceTimersByTime(60_000);
    await settle(app.loadToday());
    expect(calls("today")).toBe(1);
    expect(calls("tasks_vault")).toBe(1);
    expect(app.today!.tasks.some((t) => t.text === "Write your first note")).toBe(false);
    vi.advanceTimersByTime(2 * 60_000);
    await settle(app.loadToday());
    expect(calls("today")).toBe(2);
  });

  test("a refresh you ask for always fetches everything", async () => {
    const { app } = await started();
    await settle(app.loadToday());
    await settle(app.loadToday(true));
    expect(calls("today")).toBe(2);
  });

  test("loads at the same time share one fetch", async () => {
    const { app } = await started();
    await settle(Promise.all([app.loadToday(), app.loadToday(), app.loadToday(true)]));
    expect(calls("today")).toBe(1);
  });

  test("a refresh asked for during a quick one still fetches everything", async () => {
    const { app } = await started();
    await settle(app.loadToday());
    await settle(Promise.all([app.loadToday(), app.loadToday(true)]));
    expect(calls("tasks_vault")).toBe(1);
    expect(calls("today")).toBe(2);
  });

  test("a load that never answers is given up after 30 seconds, and the next one works", async () => {
    const { app } = await started();
    hangs.add("today");
    const stuck = app.loadToday();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(app.todayError).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    await stuck;
    // Nothing to show yet, so the failure stays on Today's screen instead of a passing toast.
    expect(app.todayError).toBe("Today is taking too long to load. Try again in a moment.");
    expect(app.today).toBeNull();
    hangs.clear();
    await settle(app.loadToday());
    expect(app.today?.events).toHaveLength(4);
    expect(app.todayError).toBeNull();
  });

  test("a stuck tasks-only refresh doesn't hold the next refresh", async () => {
    const { app } = await started();
    await settle(app.loadToday());
    hangs.add("tasks_vault");
    const stuck = app.loadToday();
    await vi.advanceTimersByTimeAsync(30_000);
    await stuck;
    hangs.clear();
    await settle(app.loadToday());
    expect(calls("tasks_vault")).toBe(2);
    await settle(app.loadToday(true));
    expect(calls("today")).toBe(2);
  });

  test("a load that answers in time says nothing later", async () => {
    const { app } = await started();
    await settle(app.loadToday());
    app.toast = null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(app.toast).toBeNull();
  });

  test("a failure says why and keeps what was there", async () => {
    const { app } = await started();
    await settle(app.loadToday());
    const before = app.today;
    faults.set("today", "You're offline.");
    await settle(app.loadToday(true));
    expect(app.toast).toBe("You're offline.");
    expect(app.today).toStrictEqual(before);
    // The next one tries again.
    faults.clear();
    await settle(app.loadToday(true));
    expect(calls("today")).toBe(3);
    expect(app.today).not.toBe(before);
  });
});

describe("links and tasks from Today", () => {
  test("an email link from a connected mailbox opens in the reader; other links go to the browser", async () => {
    const { app } = await started();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    app.openLink("https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3");
    expect(app.reading).toEqual({ source: "google", id: "18c2f0a1b2c3", url: "https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3" });
    expect(open).not.toHaveBeenCalled();
    app.reading = null;
    // Outlook isn't connected in the mock, so its link stays a web link.
    app.openLink("https://outlook.office365.com/owa/?ItemID=AAMk&viewmodel=ReadMessageItem");
    app.openLink("https://example.com");
    await vi.advanceTimersByTimeAsync(0);
    expect(app.reading).toBeNull();
    expect(open.mock.calls.map((c) => c[0])).toEqual(["https://outlook.office365.com/owa/?ItemID=AAMk&viewmodel=ReadMessageItem", "https://example.com"]);
    open.mockRestore();
  });

  test("adding a task puts it in today's note and offers to open it", async () => {
    const { app, api } = await started();
    await settle(app.addTask("Reply to Amina"));
    expect(app.toast).toBe("Added to today's note.");
    const path = (await settle(api.dailyNote())) as string;
    expect(await settle(api.noteRead(path))).toContain("- [ ] Reply to Amina");
    expect(app.changed.paths).toEqual([path]);
    app.toastAction!.run();
    expect(app.current).toBe(path);
    faults.set("task_add", "Give the task a name.");
    await settle(app.addTask(" "));
    expect(app.toast).toBe("Give the task a name.");
  });
});

describe("drawings", () => {
  test("New drawing opens the pad; Done makes a note holding the drawing and opens it", async () => {
    const { app, api } = await started();
    await settle(app.newDrawing());
    expect(app.drawing).toMatchObject({ edit: null });
    expect(app.drawing!.note.endsWith("Drawing.md")).toBe(true);
    await settle(app.drawing!.saved!("attachments/Drawing 2026-11-03 0900.svg") as unknown as Promise<void>);
    expect(app.current).toMatch(/Drawing 2026-11-03 0900\.md$/);
    expect(await settle(api.noteRead(app.current!))).toBe("![[Drawing 2026-11-03 0900.svg]]\n");
  });
});

describe("deleting and archiving tasks", () => {
  test("deleting a task removes it and its notes; Undo puts them back", async () => {
    const { app, api } = await started();
    await settle(api.noteWrite("Plan.md", "# Plan\n- [ ] Call Amina\n  about the lease\n- [ ] Next\n"));
    const task = { path: "Plan.md", title: "Plan", line: 1, text: "Call Amina", done: false, due: null, details: "about the lease" };
    await settle(app.deleteTask(task));
    expect(await settle(api.noteRead("Plan.md"))).toBe("# Plan\n- [ ] Next\n");
    expect(app.toast).toBe("Deleted “Call Amina”.");
    expect(app.changed.paths).toEqual(["Plan.md"]);
    app.toastAction!.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(await settle(api.noteRead("Plan.md"))).toBe("# Plan\n- [ ] Call Amina\n  about the lease\n- [ ] Next\n");
    await settle(app.deleteTask({ ...task, text: "Something else" }));
    expect(app.toast).toBe("That task changed in its note, so the list is updated. Try again.");
    expect(app.changed.paths).toEqual(["Plan.md"]);
  });

  test("archiving moves a task to Archive and out of the lists; Undo brings it back", async () => {
    const { app, api } = await started();
    await settle(api.noteWrite("Plan.md", "# Plan\n- [ ] Call Amina\n- [ ] Next\n"));
    const task = { path: "Plan.md", title: "Plan", line: 1, text: "Call Amina", done: false, due: null, details: "" };
    await settle(app.archiveTask(task));
    expect(app.toast).toBe("Archived “Call Amina”.");
    expect(app.changed.paths).toEqual(["Plan.md", "Archive.md"]);
    expect(await settle(api.noteRead("Archive.md"))).toMatch(/^# Archive\n- \[ \] Call Amina\n  From \[\[Plan\]\], archived \d{4}-\d{2}-\d{2}\n$/);
    const listed = (await settle(api.tasksVault())) as { text: string }[];
    expect(listed.map((t) => t.text)).not.toContain("Call Amina");
    app.toastAction!.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(await settle(api.noteRead("Plan.md"))).toBe("# Plan\n- [ ] Call Amina\n- [ ] Next\n");
    expect(await settle(api.noteRead("Archive.md"))).toBe("# Archive\n");
  });
});

describe("full-screen Today on the Mac", () => {
  test("opening a note or all tasks leaves full-screen Today, so what you opened shows", async () => {
    const { app } = await started();
    app.todayFull = true;
    app.open("Welcome.md");
    expect(app.todayFull).toBe(false);
    app.todayFull = true;
    app.showTasks();
    expect([app.todayFull, app.current, app.tab]).toEqual([false, null, "tasks"]);
  });
});

describe("notes changed by Claude Code", () => {
  test("a change made outside reloads the file list and the open note, once", async () => {
    const { app } = await started();
    const before = app.changed.at;
    await settle(app.checkOutside());
    expect(app.changed.at).toBe(before);
    const { changeOutside } = real.mock!;
    await vi.advanceTimersByTimeAsync(10);
    changeOutside("Welcome.md", "# Welcome\n\nClaude was here.\n");
    changeOutside("Claude.md", "# Claude\n");
    await settle(app.checkOutside());
    expect(app.changed.paths).toEqual(["Welcome.md", "Claude.md"]);
    expect(app.tree.some((e) => e.path === "Claude.md")).toBe(true);
    const seen = app.changed.at;
    await settle(app.checkOutside());
    expect(app.changed.at).toBe(seen);
    expect(app.toast).toBe("Claude Code changed 2 notes.");
  });

  test("the open note changing says Claude Code changed it", async () => {
    const { app } = await started();
    app.open("Welcome.md");
    const { changeOutside } = real.mock!;
    await vi.advanceTimersByTimeAsync(10);
    changeOutside("Welcome.md", "# Welcome\n\nClaude was here.\n");
    await settle(app.checkOutside());
    expect(app.toast).toBe("Claude Code changed “Welcome”.");
  });

  test("the app looks every few seconds while it's in front", async () => {
    const { app } = await started();
    const { changeOutside } = real.mock!;
    await vi.advanceTimersByTimeAsync(10);
    changeOutside("Welcome.md", "# Welcome\n\nAgain.\n");
    await vi.advanceTimersByTimeAsync(3_500);
    expect(app.changed.paths).toEqual(["Welcome.md"]);
  });
});
