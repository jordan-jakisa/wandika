import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { settle } from "../test/lib";
import type { Entry, NoteMeta, SearchHit, Status, VaultTask } from "./types";

// The mock stands in for the Rust core whenever the interface runs in a browser, so screens are
// designed against it. These tests hold it to the core's rules.

type Mock = typeof import("./mock");

/** A fresh mock (its notes reset) and a `run` that waits out its pauses under fake timers. */
async function fresh(search = "") {
  history.replaceState(null, "", "/" + search);
  vi.resetModules();
  const m: Mock = await import("./mock");
  const run = <T = unknown>(cmd: string, args?: Record<string, unknown>) => settle(m.invoke(cmd, args) as Promise<T>);
  return { ...m, run };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 3, 10, 0));
});

afterEach(() => {
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("commands", () => {
  test("an unknown command is refused", async () => {
    const { run } = await fresh();
    await expect(run("no_such_thing")).rejects.toBe("Mock has no command no_such_thing");
  });

  test("calls are counted, so a screen can catch a loop", async () => {
    const { run } = await fresh();
    const calls = (globalThis as { __mockCalls?: Record<string, number> }).__mockCalls!;
    const before = calls.tree ?? 0;
    await run("tree");
    await run("tree");
    expect(calls.tree).toBe(before + 2);
  });

  test("every reply waits a moment, like a real call", async () => {
    const { invoke } = await fresh();
    let done = false;
    void invoke("status").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(30);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(done).toBe(true);
  });

  test("on adds a listener and returns its removal", async () => {
    const { on } = await fresh();
    const off = on("sync-progress", () => {});
    expect(off()).toBe(true);
    expect(off()).toBe(false);
  });
});

describe("accounts and vaults", () => {
  test("starts signed out with no vault", async () => {
    const { run } = await fresh();
    const s = await run<Status>("status");
    expect(s.user).toBeNull();
    expect(s.vault).toBeNull();
    expect(s.known).toEqual([]);
    expect(s.encryption).toBeNull();
    expect(s.last_sync).toBeNull();
  });

  test("?mock=vault opens straight into a GitHub vault", async () => {
    const { run } = await fresh("?mock=vault");
    const s = await run<Status>("status");
    expect(s.user?.login).toBe("jordan-jakisa");
    expect(s.vault?.remote).toEqual({ owner: "jordan-jakisa", repo: "notes", branch: "main" });
    expect(s.encryption).toEqual({ set_up: true, unlocked: false, folders: ["Private"] });
  });

  test("GitHub sign-in succeeds on the third poll", async () => {
    const { run } = await fresh();
    const code = await run<{ user_code: string; interval: number }>("github_start_login");
    expect(code.user_code).toBe("WDKA-2611");
    expect(await run("github_poll_login", { deviceCode: "d" })).toBeNull();
    expect(await run("github_poll_login", { deviceCode: "d" })).toBeNull();
    expect(await run("github_poll_login", { deviceCode: "d" })).toEqual({ user: expect.objectContaining({ login: "jordan-jakisa" }) });
    expect((await run<Status>("status")).user?.name).toBe("Jordan");
  });

  test("signing out closes a GitHub vault but keeps a local one open", async () => {
    const gh = await fresh("?mock=vault");
    await gh.run("github_sign_out");
    const s = await gh.run<Status>("status");
    expect(s.user).toBeNull();
    expect(s.vault).toBeNull();

    const local = await fresh();
    await local.run("vault_create_local", { name: "Mine" });
    await local.run("github_sign_out");
    expect((await local.run<Status>("status")).vault?.name).toBe("Mine");
  });

  test("repositories can be listed and created", async () => {
    const { run } = await fresh();
    const repos = await run<{ full_name: string }[]>("repos_list");
    expect(repos.map((r) => r.full_name)).toEqual(["jordan-jakisa/notes", "jordan-jakisa/wandika", "jordan-jakisa/rowpin"]);
    expect(await run("repo_create", { name: "journal" })).toMatchObject({ full_name: "jordan-jakisa/journal", private: true, pushed_at: null });
  });

  test("opening a GitHub vault pulls every note and remembers it", async () => {
    const { run } = await fresh();
    const start = Date.now();
    const report = await run<{ pulled: string[]; at: number }>("vault_open", { owner: "jordan-jakisa", repo: "notes" });
    expect(report.pulled).toContain("Welcome.md");
    expect(report.at).toBeGreaterThanOrEqual(start + 900);
    expect(report.at).toBeLessThanOrEqual(Date.now());
    const s = await run<Status>("status");
    expect(s.vault?.id).toBe("github/jordan-jakisa/notes");
    expect(s.known.map((k) => k.id)).toEqual(["github/jordan-jakisa/notes"]);
    expect(s.last_sync).toBe(report.at);
    // Opening it again doesn't remember it twice.
    await run("vault_open", { owner: "jordan-jakisa", repo: "notes" });
    expect((await run<Status>("status")).known).toHaveLength(1);
  });

  test("a local vault is named, or named after its folder", async () => {
    const { run } = await fresh();
    await run("vault_create_local", { name: "Mine" });
    expect((await run<Status>("status")).vault).toMatchObject({ name: "Mine", folder: null, remote: null });
    vi.advanceTimersByTime(1);
    await run("vault_create_local", { name: "", folder: "/Users/j/Obsidian Vault" });
    const s = await run<Status>("status");
    expect(s.vault).toMatchObject({ name: "Obsidian Vault", folder: "/Users/j/Obsidian Vault" });
    expect(s.known).toHaveLength(2);
  });

  test("switching, closing and forgetting vaults", async () => {
    const { run } = await fresh();
    await run("vault_create_local", { name: "One" });
    vi.advanceTimersByTime(1);
    await run("vault_create_local", { name: "Two" });
    const [one, two] = (await run<Status>("status")).known;
    await run("vault_switch", { id: one.id });
    expect((await run<Status>("status")).vault?.name).toBe("One");
    await run("vault_close");
    expect((await run<Status>("status")).vault).toBeNull();
    await run("vault_switch", { id: "nope" });
    expect((await run<Status>("status")).vault).toBeNull();

    // Forgetting an unknown vault leaves the others alone.
    await run("vault_forget", { id: "nope" });
    expect((await run<Status>("status")).known).toHaveLength(2);
    await run("vault_switch", { id: two.id });
    await run("vault_forget", { id: two.id });
    const s = await run<Status>("status");
    expect(s.vault).toBeNull();
    expect(s.known.map((k) => k.name)).toEqual(["One"]);
  });

  test("a local vault can be connected to GitHub and back", async () => {
    const { run } = await fresh();
    await run("vault_create_local", { name: "Mine" });
    const report = await run<{ pushed: string[] }>("vault_connect_remote", { owner: "j", repo: "mine" });
    expect(report.pushed).toContain("Welcome.md");
    let s = await run<Status>("status");
    expect(s.vault?.remote).toEqual({ owner: "j", repo: "mine", branch: "main" });
    expect(s.known[0].remote?.repo).toBe("mine");
    await run("vault_disconnect_remote");
    s = await run<Status>("status");
    expect(s.vault?.remote).toBeNull();
    expect(s.known[0].remote).toBeNull();
  });

  test("a sync moves the last sync time on", async () => {
    const { run } = await fresh("?mock=vault");
    const first = await run<{ at: number }>("sync_now");
    vi.advanceTimersByTime(60_000);
    const second = await run<{ at: number }>("sync_now");
    expect(second.at).toBeGreaterThan(first.at);
    expect((await run<Status>("status")).last_sync).toBe(second.at);
    expect(await run("sync_cancel")).toBeUndefined();
    expect(await run("sync_held_deletions", { delete: true, paths: [] })).toBeUndefined();
  });
});

describe("notes", () => {
  test("the tree lists folders, notes and files, sorted", async () => {
    const { run } = await fresh();
    const tree = await run<Entry[]>("tree");
    const paths = tree.map((e) => e.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(tree.find((e) => e.path === "Projects")).toMatchObject({ kind: "folder", name: "Projects" });
    expect(tree.find((e) => e.path === "Projects/Wandika.md")).toMatchObject({ kind: "note", name: "Wandika" });
    expect(tree.find((e) => e.path === "Private/Passport renewal.md.age")).toMatchObject({ kind: "note", encrypted: true, name: "Passport renewal" });
    expect(tree.find((e) => e.path === "attachments/Sync sketch.svg")).toMatchObject({ kind: "file", name: "Sync sketch.svg" });
  });

  test("?big adds a vault's worth of linked notes", async () => {
    const small = (await (await fresh()).run<Entry[]>("tree")).length;
    const { run } = await fresh("?big");
    const titles = await run<NoteMeta[]>("note_titles");
    expect(titles.filter((n) => /\/Note \d+\.md$/.test(n.path))).toHaveLength(300);
    expect((await run<Entry[]>("tree")).length).toBeGreaterThan(small + 300);
  });

  test("new notes get a free name", async () => {
    const { run } = await fresh();
    expect(await run("note_create", { folder: "", title: "Untitled" })).toBe("Untitled.md");
    expect(await run("note_create", { folder: "", title: "Untitled" })).toBe("Untitled 2.md");
    expect(await run("note_create", { folder: "Projects", title: "Untitled" })).toBe("Projects/Untitled.md");
    expect(await run("note_create", { folder: "/Projects/", title: "Plan", body: "# Plan" })).toBe("Projects/Plan.md");
    expect(await run("note_read", { path: "Projects/Plan.md" })).toBe("# Plan");
    expect(await run("note_read", { path: "Untitled.md" })).toBe("");
  });

  test("new notes in an encrypted folder are encrypted", async () => {
    const { run } = await fresh();
    expect(await run("note_create", { folder: "Private", title: "Bank" })).toBe("Private/Bank.md.age");
    expect(await run("note_create", { folder: "Private/Old", title: "Bank" })).toBe("Private/Old/Bank.md.age");
    expect(await run("note_create", { folder: "Privateer", title: "Bank" })).toBe("Privateer/Bank.md");
  });

  test("note names are cleaned like file names, and need a name", async () => {
    const { run } = await fresh();
    expect(await run("note_create", { folder: "", title: "  a/b: c?  " })).toBe("a-b- c-.md");
    expect(await run("note_create", { folder: "", title: "..hidden" })).toBe("hidden.md");
    expect(await run("note_create", { folder: "", title: "Café 日本 📅" })).toBe("Café 日本 📅.md");
    await expect(run("note_create", { folder: "", title: "   " })).rejects.toBe("Give the note a name.");
  });

  test("notes are read and written", async () => {
    const { run } = await fresh();
    await run("note_write", { path: "Welcome.md", content: "Changed ✓" });
    expect(await run("note_read", { path: "Welcome.md" })).toBe("Changed ✓");
    await expect(run("note_read", { path: "Gone.md" })).rejects.toBe("That note no longer exists.");
  });

  test("encrypted notes are locked until unlocked", async () => {
    const { run } = await fresh();
    const path = "Private/Passport renewal.md.age";
    // Thrown as the core sends it: code "locked" is what brings up the passphrase form.
    await expect(run("note_read", { path })).rejects.toMatchObject({ code: "locked", message: expect.stringMatching(/locked/) });
    await expect(run("note_write", { path, content: "x" })).rejects.toMatchObject({ code: "locked" });
    await expect(run("encryption_unlock", { passphrase: "short" })).rejects.toMatch(/Wrong passphrase/);
    expect(await run("encryption_unlock", { passphrase: "long enough" })).toMatchObject({ unlocked: true });
    expect(await run("note_read", { path })).toMatch(/^# Passport renewal/);
    expect(await run("encryption_lock")).toMatchObject({ unlocked: false });
    await expect(run("note_read", { path })).rejects.toMatchObject({ code: "locked" });
    expect(await run("encryption_setup", { passphrase: "new one" })).toEqual({ set_up: true, unlocked: true, folders: ["Private"] });
  });

  test("a note can be encrypted and decrypted", async () => {
    const { run } = await fresh();
    expect(await run("set_encrypted", { path: "Welcome.md", encrypt: true })).toBe("Welcome.md.age");
    expect(await run("set_encrypted", { path: "Welcome.md.age", encrypt: false })).toBe("Welcome.md");
    expect(await run("note_read", { path: "Welcome.md" })).toMatch(/^# Welcome to Wandika/);
  });

  test("only an empty note still called Untitled is discarded", async () => {
    const { run } = await fresh();
    await run("note_create", { folder: "", title: "Untitled" });
    await run("note_create", { folder: "", title: "Untitled", body: " \n\t" });
    await run("note_create", { folder: "", title: "Untitled", body: "Buy milk" });
    await run("note_create", { folder: "", title: "Plan" });
    await run("note_create", { folder: "", title: "Untitled draft" });
    expect(await run("note_discard_if_empty", { path: "Untitled.md" })).toBe(true);
    expect(await run("note_discard_if_empty", { path: "Untitled 2.md" })).toBe(true);
    expect(await run("note_discard_if_empty", { path: "Untitled 3.md" })).toBe(false);
    expect(await run("note_discard_if_empty", { path: "Plan.md" })).toBe(false);
    expect(await run("note_discard_if_empty", { path: "Untitled draft.md" })).toBe(false);
    expect(await run("note_discard_if_empty", { path: "Untitled.md" })).toBe(false);
    const paths = (await run<Entry[]>("tree")).map((e) => e.path);
    expect(paths).not.toContain("Untitled.md");
    expect(paths).toContain("Untitled 3.md");
    expect(paths).toContain("Plan.md");
  });

  test("new notes go next to the open one", async () => {
    const { run } = await fresh();
    expect(await run("new_note_folder", { current: "Projects/Sub/Plan.md" })).toBe("Projects/Sub");
    expect(await run("new_note_folder", { current: "Welcome.md" })).toBe("");
    expect(await run("new_note_folder", { current: null })).toBe("");
  });

  test("folder_create succeeds", async () => {
    const { run } = await fresh();
    expect(await run("folder_create", { path: "New" })).toBeUndefined();
  });
});

describe("rename", () => {
  test("a note is renamed and links to it follow", async () => {
    const { run } = await fresh();
    expect(await run("entry_rename", { path: "Projects/Wandika.md", name: "Wandika app" })).toBe("Projects/Wandika app.md");
    await expect(run("note_read", { path: "Projects/Wandika.md" })).rejects.toBeDefined();
    expect(await run("note_read", { path: "Projects/Wandika app.md" })).toMatch(/^# Wandika/);
    const welcome = await run<string>("note_read", { path: "Welcome.md" });
    expect(welcome).toContain("[[Projects/Wandika app]]");
    expect(welcome).toContain("[[Reading list]]");
    const reading = await run<string>("note_read", { path: "Reading list.md" });
    // Folder, heading and embeds are kept as written.
    expect(reading).toContain("![[Projects/Wandika app#Next]]");
    expect(reading).not.toMatch(/\[\[Projects\/Wandika[\]#|]/);
  });

  test("aliases and bare names follow too, other links stay", async () => {
    const { run } = await fresh();
    await run("note_create", { folder: "", title: "Plan" });
    await run("note_create", { folder: "", title: "Links", body: "[[plan|the plan]] [[Plan]] [[Planner]] [[Other/Plan#Goals]]" });
    await run("entry_rename", { path: "Plan.md", name: "Roadmap" });
    expect(await run("note_read", { path: "Links.md" })).toBe("[[Roadmap|the plan]] [[Roadmap]] [[Planner]] [[Other/Roadmap#Goals]]");
  });

  test("renaming to the same name keeps the note", async () => {
    const { run } = await fresh();
    expect(await run("entry_rename", { path: "Welcome.md", name: "Welcome" })).toBe("Welcome.md");
    expect(await run("note_read", { path: "Welcome.md" })).toMatch(/^# Welcome/);
  });

  test("a name already taken is refused, a change of case is not", async () => {
    const { run } = await fresh();
    await expect(run("entry_rename", { path: "Welcome.md", name: "Reading list" })).rejects.toBe("“Reading list” already exists here.");
    expect(await run("note_read", { path: "Reading list.md" })).toMatch(/^---/);
    expect(await run("entry_rename", { path: "Welcome.md", name: "welcome" })).toBe("welcome.md");
    expect(await run("note_read", { path: "welcome.md" })).toMatch(/^# Welcome/);
  });

  test("names are cleaned and required", async () => {
    const { run } = await fresh();
    expect(await run("entry_rename", { path: "Welcome.md", name: " Hi/there " })).toBe("Hi-there.md");
    await expect(run("entry_rename", { path: "Hi-there.md", name: "" })).rejects.toBe("Give the note a name.");
  });

  test("an encrypted note stays encrypted", async () => {
    const { run } = await fresh();
    expect(await run("entry_rename", { path: "Private/Passport renewal.md.age", name: "Passport" })).toBe("Private/Passport.md.age");
  });

  test("an image keeps its type", async () => {
    const { run } = await fresh();
    expect(await run("entry_rename", { path: "attachments/Sync sketch.svg", name: "Sketch" })).toBe("attachments/Sketch.svg");
    expect(await run("entry_rename", { path: "attachments/Sketch.svg", name: "Diagram.SVG" })).toBe("attachments/Diagram.SVG");
    const tree = await run<Entry[]>("tree");
    expect(tree.find((e) => e.path === "attachments/Diagram.SVG")?.kind).toBe("file");
    expect(tree.some((e) => e.path.endsWith(".svg.md") || e.path === "attachments/Sketch.md")).toBe(false);
  });

  test("a folder moves with everything in it", async () => {
    const { run } = await fresh();
    expect(await run("entry_rename", { path: "Projects", name: "Work" })).toBe("Work");
    const paths = (await run<Entry[]>("tree")).map((e) => e.path);
    expect(paths).toContain("Work/Wandika.md");
    expect(paths).toContain("Work/Sync design.md");
    expect(paths.some((p) => p.startsWith("Projects"))).toBe(false);
  });

  test("an encrypted folder keeps encrypting new notes after a rename", async () => {
    const { run } = await fresh();
    await run("entry_rename", { path: "Private", name: "Secret" });
    expect(await run("note_create", { folder: "Secret", title: "Bank" })).toBe("Secret/Bank.md.age");
  });

  test("something that isn't there can't be renamed", async () => {
    const { run } = await fresh();
    await expect(run("entry_rename", { path: "Nope", name: "Still nope" })).rejects.toBe("That note no longer exists.");
  });
});

describe("trash", () => {
  test("a trashed note comes back on restore", async () => {
    const { run } = await fresh();
    const text = await run("note_read", { path: "Welcome.md" });
    await run("entry_trash", { path: "Welcome.md" });
    await expect(run("note_read", { path: "Welcome.md" })).rejects.toBe("That note no longer exists.");
    await run("entry_restore", { path: "Welcome.md" });
    expect(await run("note_read", { path: "Welcome.md" })).toBe(text);
    await expect(run("entry_restore", { path: "Welcome.md" })).rejects.toBe("It isn't in the trash any more.");
  });

  test("a folder goes with its notes and files", async () => {
    const { run } = await fresh();
    await run("entry_trash", { path: "attachments" });
    await run("entry_trash", { path: "Projects" });
    let paths = (await run<Entry[]>("tree")).map((e) => e.path);
    expect(paths.some((p) => p.startsWith("Projects") || p.startsWith("attachments"))).toBe(false);
    // A folder with a similar name is left alone.
    expect(paths).toContain("Welcome.md");
    await run("entry_restore", { path: "Projects" });
    await run("entry_restore", { path: "attachments" });
    paths = (await run<Entry[]>("tree")).map((e) => e.path);
    expect(paths).toContain("Projects/Wandika.md");
    expect(paths).toContain("attachments/Sync sketch.svg");
  });

  test("restore refuses when the place has been taken", async () => {
    const { run } = await fresh();
    await run("entry_trash", { path: "Welcome.md" });
    await run("note_create", { folder: "", title: "Welcome", body: "new" });
    await expect(run("entry_restore", { path: "Welcome.md" })).rejects.toMatch(/same name/);
    expect(await run("note_read", { path: "Welcome.md" })).toBe("new");
  });

  test("trashing an encrypted folder stops new notes there being encrypted", async () => {
    const { run } = await fresh();
    await run("entry_trash", { path: "Private" });
    expect(await run("note_create", { folder: "Private", title: "Bank" })).toBe("Private/Bank.md");
  });
});

describe("index", () => {
  test("note titles carry links, tags, boards and locks", async () => {
    const { run } = await fresh();
    await run("note_create", { folder: "", title: "Tags", body: "#café #日本 is not, #a1/b-c yes, not#this, #1no" });
    const titles = await run<NoteMeta[]>("note_titles");
    const by = (p: string) => titles.find((t) => t.path === p)!;
    expect(by("Welcome.md").links).toEqual(["Reading list", "Projects/Wandika"]);
    expect(by("Welcome.md").tags).toEqual(["idea"]);
    expect(by("Tags.md").tags).toEqual(["café", "a1/b-c"]);
    expect(by("Projects/Wandika launch.md").board).toBe(true);
    expect(by("Welcome.md").board).toBe(false);
    expect(by("Private/Passport renewal.md.age")).toMatchObject({ encrypted: true, locked: true, title: "Passport renewal" });
  });

  test("an empty search finds nothing", async () => {
    const { run } = await fresh();
    expect(await run("search", { query: "" })).toEqual([]);
    expect(await run("search", { query: "   " })).toEqual([]);
  });

  test("search needs every word, in any order, and ranks titles first", async () => {
    const { run } = await fresh();
    const hits = await run<SearchHit[]>("search", { query: "sync github" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      const text = (await run<string>("note_read", { path: h.path })).toLowerCase() + h.path.toLowerCase();
      expect(text).toContain("sync");
      expect(text).toContain("github");
    }
    const wandika = await run<SearchHit[]>("search", { query: "WANDIKA" });
    expect(wandika[0].path).toBe("Projects/Wandika.md");
    expect(wandika[0].title).toBe("Wandika");
  });

  test("search snippets show the text around the match", async () => {
    const { run } = await fresh();
    await run("note_create", { folder: "", title: "Long", body: "x".repeat(100) + "\nneedle in a haystack\nmore" });
    const [hit] = await run<SearchHit[]>("search", { query: "needle" });
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet).toContain("needle in a haystack more");
    expect(hit.snippet).not.toContain("\n");
  });

  test("locked notes are found by name, never by their text", async () => {
    const { run } = await fresh();
    expect(await run("search", { query: "appointment" })).toEqual([]);
    const [hit] = await run<SearchHit[]>("search", { query: "passport" });
    expect(hit).toMatchObject({ path: "Private/Passport renewal.md.age", encrypted: true, snippet: "" });
    await run("encryption_unlock", { passphrase: "long enough" });
    expect((await run<SearchHit[]>("search", { query: "appointment" })).map((h) => h.path)).toEqual(["Private/Passport renewal.md.age"]);
  });

  test("backlinks list the notes linking here", async () => {
    const { run } = await fresh();
    const hits = await run<SearchHit[]>("backlinks", { path: "Projects/Wandika.md" });
    expect(hits.map((h) => h.path).sort()).toEqual(["Projects/Wandika launch.md", "Reading list.md", "Welcome.md"]);
    expect(hits.find((h) => h.path === "Welcome.md")!.snippet).toContain("[[Projects/Wandika]]");
  });

  test("links resolve like the core: exact name or path, shortest first", async () => {
    const { run } = await fresh();
    expect(await run("resolve_link", { target: "Wandika" })).toBe("Projects/Wandika.md");
    expect(await run("resolve_link", { target: "projects/wandika" })).toBe("Projects/Wandika.md");
    expect(await run("resolve_link", { target: "Reading list.md" })).toBe("Reading list.md");
    expect(await run("resolve_link", { target: " Passport renewal " })).toBe("Private/Passport renewal.md.age");
    // Part of a name is not a match.
    expect(await run("resolve_link", { target: "list" })).toBeNull();
    expect(await run("resolve_link", { target: "jects/Wandika" })).toBeNull();
    await run("note_create", { folder: "", title: "Wandika" });
    expect(await run("resolve_link", { target: "Wandika" })).toBe("Wandika.md");
  });
});

describe("tasks", () => {
  test("vault tasks skip templates and locked notes, and read due dates", async () => {
    const { run } = await fresh();
    const tasks = await run<VaultTask[]>("tasks_vault");
    expect(tasks.some((t) => t.path.startsWith("Templates/"))).toBe(false);
    expect(tasks.some((t) => t.path.endsWith(".age"))).toBe(false);
    expect(tasks.find((t) => t.text === "Pick a repository")).toMatchObject({ done: true, path: "Welcome.md", title: "Welcome" });
    expect(tasks.find((t) => t.text.startsWith("Connect a calendar"))!.due).toBe("2026-11-03");
    expect(tasks.find((t) => t.text === "Write your first note")!.due).toBeNull();
  });

  test("ticking a task marks it done with today's date, unticking takes it off", async () => {
    const { run } = await fresh();
    const task = (await run<VaultTask[]>("tasks_vault")).find((t) => t.text === "Write your first note")!;
    expect(await run("task_toggle", { path: task.path, line: task.line, text: task.text })).toBe(true);
    let line = (await run<string>("note_read", { path: task.path })).split("\n")[task.line];
    expect(line).toBe("- [x] Write your first note ✅ 2026-11-03");
    expect(await run("task_toggle", { path: task.path, line: task.line, text: "Write your first note ✅ 2026-11-03" })).toBe(false);
    line = (await run<string>("note_read", { path: task.path })).split("\n")[task.line];
    expect(line).toBe("- [ ] Write your first note");
  });

  test("a task that changed or moved is not toggled", async () => {
    const { run } = await fresh();
    const task = (await run<VaultTask[]>("tasks_vault")).find((t) => t.text === "Write your first note")!;
    const before = await run("note_read", { path: task.path });
    await expect(run("task_toggle", { path: task.path, line: task.line, text: "Something else" })).rejects.toMatch(/changed/);
    await expect(run("task_toggle", { path: task.path, line: 0, text: task.text })).rejects.toMatch(/moved/);
    await expect(run("task_toggle", { path: task.path, line: 999, text: task.text })).rejects.toMatch(/moved/);
    await expect(run("task_toggle", { path: "Gone.md", line: 0, text: "x" })).rejects.toMatch(/moved/);
    expect(await run("note_read", { path: task.path })).toBe(before);
  });
});

describe("daily notes", () => {
  test("today's note exists from the start", async () => {
    const { run } = await fresh();
    expect(await run("daily_note")).toBe("Daily/2026-11-03.md");
    expect(await run("note_read", { path: "Daily/2026-11-03.md" })).toMatch(/^# Tuesday 3 November 2026\n/);
  });

  test("another day's note is created on first open", async () => {
    const { run } = await fresh();
    expect(await run("daily_note", { date: "2026-02-28" })).toBe("Daily/2026-02-28.md");
    expect(await run("note_read", { path: "Daily/2026-02-28.md" })).toBe("# Saturday 28 February 2026\n\n## Agenda\n\n## Notes\n\n## Tasks\n\n");
    expect(await run("daily_note", { date: "2028-02-29" })).toBe("Daily/2028-02-29.md");
    expect(await run("daily_note", { date: "2026-12-31" })).toBe("Daily/2026-12-31.md");
  });

  test("an existing daily note is kept as it is", async () => {
    const { run } = await fresh();
    await run("note_write", { path: "Daily/2026-11-03.md", content: "Mine" });
    await run("daily_note", { date: "2026-11-03" });
    expect(await run("note_read", { path: "Daily/2026-11-03.md" })).toBe("Mine");
  });

  test("dates that don't exist are refused", async () => {
    const { run } = await fresh();
    for (const date of ["2026-02-29", "2026-02-30", "2026-13-01", "3 Nov", "2026-11-3"]) {
      await expect(run("daily_note", { date })).rejects.toBe("Dates look like 2026-11-02.");
    }
  });

  test("after midnight today's note is the new day's", async () => {
    vi.setSystemTime(new Date(2026, 10, 30, 23, 59, 50));
    const { run } = await fresh();
    expect(await run("daily_note")).toBe("Daily/2026-11-30.md");
    vi.setSystemTime(new Date(2026, 11, 1, 0, 0, 5));
    expect(await run("daily_note")).toBe("Daily/2026-12-01.md");
    expect(await run("note_read", { path: "Daily/2026-12-01.md" })).toMatch(/^# Tuesday 1 December 2026/);
  });

  test("the agenda goes into the daily note", async () => {
    const { run } = await fresh();
    expect(await run("agenda_to_daily", { events: [] })).toBe("Daily/2026-11-03.md");
    expect(await run("agenda_to_daily", { events: [], date: "2026-11-04" })).toBe("Daily/2026-11-04.md");
  });
});

describe("templates and attachments", () => {
  test("templates are listed and filled in", async () => {
    const { run } = await fresh();
    expect(await run("templates_list")).toEqual(["Templates/Meeting.md"]);
    const text = await run<string>("template_render", { path: "Templates/Meeting.md", title: "Standup" });
    expect(text).toMatch(/^## Standup\n\n2026-11-03, 10:00\n/);
    expect(text).not.toContain("{{");
    expect(await run("template_render", { path: "Templates/Nope.md", title: "x" })).toBe("");
  });

  test("attachments are saved under a free name and read back by name", async () => {
    const { run } = await fresh();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await run("attachment_save", { note: "Welcome.md", name: "pic.png", bytes })).toBe("attachments/pic.png");
    expect(await run("attachment_save", { note: "Welcome.md", name: "pic.png", bytes })).toBe("attachments/pic 1.png");
    expect(await run("attachment_save", { note: "Welcome.md", name: "README", bytes })).toBe("attachments/README");
    expect(await run("attachment_save", { note: "Welcome.md", name: "README", bytes })).toBe("attachments/README 1");
    const buf = await run<ArrayBuffer>("attachment_read", { target: "PIC.png", from: "Welcome.md" });
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3]);
    expect(new Uint8Array(await run<ArrayBuffer>("attachment_read", { target: "attachments/pic 1.png", from: "x" })).length).toBe(3);
    await expect(run("attachment_read", { target: "missing.png", from: "Welcome.md" })).rejects.toBe("missing.png isn't in this vault.");
  });

  test("a read gives a copy, so the stored file can't be changed through it", async () => {
    const { run } = await fresh();
    const a = new Uint8Array(await run<ArrayBuffer>("attachment_read", { target: "Sync sketch.svg", from: "x" }));
    a[0] = 0;
    const b = new Uint8Array(await run<ArrayBuffer>("attachment_read", { target: "Sync sketch.svg", from: "x" }));
    expect(b[0]).toBe("<".charCodeAt(0));
  });
});

describe("appearance and connections", () => {
  test("snippets can be turned on and off", async () => {
    const { run } = await fresh();
    await run("snippet_toggle", { name: "wide-tables", enabled: true });
    await run("snippet_toggle", { name: "missing", enabled: true });
    const list = await run<{ name: string; enabled: boolean }[]>("snippets_list");
    expect(list.map((s) => [s.name, s.enabled])).toEqual([
      ["wide-tables", true],
      ["rounded-cards", true],
    ]);
  });

  test("each provider connects its own way", async () => {
    const { run } = await fresh();
    expect(await run("connector_connect", { provider: "google" })).toEqual({ kind: "browser" });
    expect(await run("connector_connect", { provider: "microsoft" })).toMatchObject({ kind: "device", user_code: "F4K3C0DE" });
    expect(await run("connector_connect", { provider: "apple_calendar" })).toEqual({ kind: "done", access: "granted" });
    expect(await run("connector_poll", { deviceCode: "m" })).toBe(false);
    expect(await run("connector_disconnect", { provider: "google" })).toBeUndefined();
    expect(await run("remote_task_toggle", { source: "google", listId: "l", id: "r1", done: true })).toBeUndefined();
  });

  test("Today has events, mail, open tasks and per-source errors", async () => {
    const { run } = await fresh();
    const today = await run<import("./types").Today>("today");
    expect(today.events.map((e) => e.title)).toEqual(["Gym", "Product standup", "Call with the landlord", "Design review: Today panel"]);
    expect(new Date(today.events[1].start).getHours()).toBe(9);
    expect(today.mail).toHaveLength(2);
    expect(today.tasks.length).toBeGreaterThan(0);
    expect(today.tasks.every((t) => !t.done)).toBe(true);
    expect(today.remote_tasks[0]).toMatchObject({ title: "Renew domain", due: "2026-11-03" });
    expect(Object.keys(today.errors)).toEqual(["Outlook Mail", "Outlook Calendar"]);
    expect(today.errors["Outlook Mail"].code).toBe("provider_auth");
  });

  test("mail and events become notes", async () => {
    const { run } = await fresh();
    expect(await run("mail_to_note", { source: "google", id: "a" })).toBe("Mail/Your flight to Nairobi is confirmed.md");
    expect(await run("mail_to_note", { source: "google", id: "b" })).toBe("Mail/Re Wandika sync design.md");
    const event = { title: "Standup" };
    expect(await run("event_to_note", { event })).toBe("Meetings/2026-11-03 Standup.md");
    expect(await run("event_to_note", { event })).toBe("Meetings/2026-11-03 Standup 2.md");
    expect(await run("note_read", { path: "Meetings/2026-11-03 Standup.md" })).toBe("# Standup\n\n## Notes\n\n");
  });
});
