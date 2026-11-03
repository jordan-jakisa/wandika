import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { noTouch } from "../test/lib";

// The browser stand-in and the Tauri modules are replaced, so each test sees exactly what the
// interface sends to the Rust core.
const mock = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn() }));
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), openUrl: vi.fn(), open: vi.fn() }));
vi.mock("./mock", () => mock);
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauri.openUrl }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: tauri.open }));

type Api = typeof import("./api");

/** A fresh copy of api.ts, inside Tauri or in a plain browser. */
async function load(inTauri = false): Promise<Api> {
  vi.resetModules();
  if (inTauri) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  return import("./api");
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.invoke.mockResolvedValue("ok");
  tauri.invoke.mockResolvedValue("ok");
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

const event = {
  id: "1",
  source: "google" as const,
  calendar: "Work",
  title: "Standup",
  start: "2026-11-03T09:00:00Z",
  end: "2026-11-03T09:15:00Z",
  all_day: false,
  location: null,
  url: null,
  attendees: [],
};

// Every wrapper, what it is called with, and the command and arguments the core must receive.
const calls: [string, (a: Api["api"]) => Promise<unknown>, string, Record<string, unknown> | undefined][] = [
  ["status", (a) => a.status(), "status", undefined],
  ["githubStartLogin", (a) => a.githubStartLogin(), "github_start_login", undefined],
  ["githubPollLogin", (a) => a.githubPollLogin("dev-1"), "github_poll_login", { deviceCode: "dev-1" }],
  ["githubSignOut", (a) => a.githubSignOut(), "github_sign_out", undefined],
  ["reposList", (a) => a.reposList(), "repos_list", undefined],
  ["repoCreate", (a) => a.repoCreate("notes"), "repo_create", { name: "notes" }],
  ["vaultOpen", (a) => a.vaultOpen("jordan", "notes"), "vault_open", { owner: "jordan", repo: "notes" }],
  ["vaultClose", (a) => a.vaultClose(), "vault_close", undefined],
  ["vaultCreateLocal", (a) => a.vaultCreateLocal("Mine", "/Users/j/Notes"), "vault_create_local", { name: "Mine", folder: "/Users/j/Notes" }],
  ["vaultCreateLocal without folder", (a) => a.vaultCreateLocal("Mine"), "vault_create_local", { name: "Mine", folder: undefined }],
  ["vaultSwitch", (a) => a.vaultSwitch("local/1"), "vault_switch", { id: "local/1" }],
  ["vaultForget", (a) => a.vaultForget("local/1"), "vault_forget", { id: "local/1" }],
  ["vaultConnectRemote", (a) => a.vaultConnectRemote("jordan", "notes"), "vault_connect_remote", { owner: "jordan", repo: "notes" }],
  ["vaultDisconnectRemote", (a) => a.vaultDisconnectRemote(), "vault_disconnect_remote", undefined],
  ["syncNow", (a) => a.syncNow(), "sync_now", undefined],
  ["syncHeldDeletions", (a) => a.syncHeldDeletions(true, ["a.md"]), "sync_held_deletions", { delete: true, paths: ["a.md"] }],
  ["syncCancel", (a) => a.syncCancel(), "sync_cancel", undefined],
  ["tree", (a) => a.tree(), "tree", undefined],
  ["attachmentRead", (a) => a.attachmentRead("pic.png", "Note.md"), "attachment_read", { target: "pic.png", from: "Note.md" }],
  ["newNoteFolder", (a) => a.newNoteFolder(null), "new_note_folder", { current: null }],
  ["templatesList", (a) => a.templatesList(), "templates_list", undefined],
  ["templateRender", (a) => a.templateRender("Templates/Meeting.md", "Standup"), "template_render", { path: "Templates/Meeting.md", title: "Standup" }],
  ["noteDiscardIfEmpty", (a) => a.noteDiscardIfEmpty("Untitled.md"), "note_discard_if_empty", { path: "Untitled.md" }],
  ["entryRestore", (a) => a.entryRestore("Plan.md"), "entry_restore", { path: "Plan.md" }],
  ["noteRead", (a) => a.noteRead("Plan.md"), "note_read", { path: "Plan.md" }],
  ["noteWrite", (a) => a.noteWrite("Plan.md", "# Plan"), "note_write", { path: "Plan.md", content: "# Plan" }],
  ["noteCreate", (a) => a.noteCreate("Projects", "Plan", "body"), "note_create", { folder: "Projects", title: "Plan", body: "body" }],
  ["noteCreate without body", (a) => a.noteCreate("", "Plan"), "note_create", { folder: "", title: "Plan", body: undefined }],
  ["folderCreate", (a) => a.folderCreate("Projects/New"), "folder_create", { path: "Projects/New" }],
  ["entryRename", (a) => a.entryRename("Plan.md", "Roadmap"), "entry_rename", { path: "Plan.md", name: "Roadmap" }],
  ["entryTrash", (a) => a.entryTrash("Plan.md"), "entry_trash", { path: "Plan.md" }],
  ["noteTitles", (a) => a.noteTitles(), "note_titles", undefined],
  ["search", (a) => a.search("sync"), "search", { query: "sync" }],
  ["backlinks", (a) => a.backlinks("Plan.md"), "backlinks", { path: "Plan.md" }],
  ["resolveLink", (a) => a.resolveLink("Plan"), "resolve_link", { target: "Plan" }],
  ["tasksVault", (a) => a.tasksVault(), "tasks_vault", undefined],
  ["taskToggle", (a) => a.taskToggle("Plan.md", 3, "Ship it"), "task_toggle", { path: "Plan.md", line: 3, text: "Ship it" }],
  ["taskEdit", (a) => a.taskEdit("Plan.md", 3, "Ship it", "Ship it 📌", "notes"), "task_edit", { path: "Plan.md", line: 3, expected: "Ship it", text: "Ship it 📌", details: "notes" }],
  ["taskDelete", (a) => a.taskDelete("Plan.md", 3, "Ship it"), "task_delete", { path: "Plan.md", line: 3, expected: "Ship it" }],
  ["taskRestore", (a) => a.taskRestore("Plan.md", 3, ["- [ ] Ship it"]), "task_restore", { path: "Plan.md", line: 3, lines: ["- [ ] Ship it"] }],
  ["taskArchive", (a) => a.taskArchive("Plan.md", 3, "Ship it"), "task_archive", { path: "Plan.md", line: 3, expected: "Ship it" }],
  ["taskUnarchive", (a) => a.taskUnarchive({ archive: "Archive.md", taken: ["- [ ] Ship it"], appended: "- [ ] Ship it\n" }, "Plan.md", 3), "task_unarchive", { archive: "Archive.md", appended: "- [ ] Ship it\n", path: "Plan.md", line: 3, lines: ["- [ ] Ship it"] }],
  ["taskAdd", (a) => a.taskAdd("Reply to Amina"), "task_add", { text: "Reply to Amina" }],
  ["dailyNote", (a) => a.dailyNote("2026-11-03"), "daily_note", { date: "2026-11-03" }],
  ["dailyNote for today", (a) => a.dailyNote(), "daily_note", { date: undefined }],
  ["snippetsList", (a) => a.snippetsList(), "snippets_list", undefined],
  ["snippetToggle", (a) => a.snippetToggle("wide", true), "snippet_toggle", { name: "wide", enabled: true }],
  ["encryptionSetup", (a) => a.encryptionSetup("correct horse"), "encryption_setup", { passphrase: "correct horse" }],
  ["encryptionUnlock", (a) => a.encryptionUnlock("correct horse"), "encryption_unlock", { passphrase: "correct horse" }],
  ["encryptionLock", (a) => a.encryptionLock(), "encryption_lock", undefined],
  ["setEncrypted", (a) => a.setEncrypted("Private/A.md", true), "set_encrypted", { path: "Private/A.md", encrypt: true }],
  ["connectorConnect", (a) => a.connectorConnect("google"), "connector_connect", { provider: "google" }],
  ["connectorPoll", (a) => a.connectorPoll("dev-2"), "connector_poll", { deviceCode: "dev-2" }],
  ["connectorDisconnect", (a) => a.connectorDisconnect("microsoft"), "connector_disconnect", { provider: "microsoft" }],
  ["today", (a) => a.today("2026-11-03"), "today", { date: "2026-11-03" }],
  ["today without date", (a) => a.today(), "today", { date: undefined }],
  ["remoteTaskToggle", (a) => a.remoteTaskToggle("google", "list", "t1", true), "remote_task_toggle", { source: "google", listId: "list", id: "t1", done: true }],
  ["mailToNote", (a) => a.mailToNote("google", "m1"), "mail_to_note", { source: "google", id: "m1" }],
  ["mailRead", (a) => a.mailRead("google", "m1"), "mail_read", { source: "google", id: "m1" }],
  ["externalChanges", (a) => a.externalChanges(), "external_changes", undefined],
  ["eventToNote", (a) => a.eventToNote(event), "event_to_note", { event }],
  ["agendaToDaily", (a) => a.agendaToDaily([event], "2026-11-03"), "agenda_to_daily", { events: [event], date: "2026-11-03" }],
];

describe("every wrapper sends its command", () => {
  test.each(calls)("%s", async (_name, run, cmd, args) => {
    const { api } = await load();
    expect(await run(api)).toBe("ok");
    expect(mock.invoke).toHaveBeenCalledTimes(1);
    expect(mock.invoke).toHaveBeenCalledWith(cmd, args, undefined);
  });

  test("the list covers every wrapper", async () => {
    const { api } = await load();
    const covered = new Set(calls.map(([name]) => name.split(" ")[0]));
    // attachmentSave has its own tests below: it sends bytes differently inside the app.
    expect(Object.keys(api).filter((k) => !covered.has(k))).toEqual(["attachmentSave"]);
  });

  test("inside the app the same calls go to Tauri", async () => {
    const { api } = await load(true);
    await api.noteRead("Plan.md");
    expect(tauri.invoke).toHaveBeenCalledWith("note_read", { path: "Plan.md" }, undefined);
    expect(mock.invoke).not.toHaveBeenCalled();
  });

  test("the backend loads once and is reused", async () => {
    const { api } = await load();
    await Promise.all([api.tree(), api.noteTitles()]);
    await api.status();
    expect(mock.invoke).toHaveBeenCalledTimes(3);
  });
});

describe("attachmentSave", () => {
  const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

  test("in a browser the bytes go with the names", async () => {
    const { api } = await load();
    mock.invoke.mockResolvedValue("attachments/pic.png");
    expect(await api.attachmentSave("Note.md", "pic.png", blob())).toBe("attachments/pic.png");
    const [cmd, args] = mock.invoke.mock.calls[0];
    expect(cmd).toBe("attachment_save");
    expect(args.note).toBe("Note.md");
    expect(args.name).toBe("pic.png");
    expect([...args.bytes]).toEqual([1, 2, 3]);
  });

  test("in the app the bytes are the body and the names ride in a header", async () => {
    const { api } = await load(true);
    await api.attachmentSave("Projects/Plan & ideas.md", "photo 1.png", blob());
    const [cmd, body, options] = tauri.invoke.mock.calls[0];
    expect(cmd).toBe("attachment_save");
    expect(body).toBeInstanceOf(Uint8Array);
    expect([...body]).toEqual([1, 2, 3]);
    const meta = new URLSearchParams(options.headers["x-meta"]);
    expect(meta.get("note")).toBe("Projects/Plan & ideas.md");
    expect(meta.get("name")).toBe("photo 1.png");
  });

  test("names with accents and emoji survive the header", async () => {
    const { api } = await load(true);
    await api.attachmentSave("Café/Ñote 📅.md", "日本.png", blob());
    const meta = new URLSearchParams(tauri.invoke.mock.calls[0][2].headers["x-meta"]);
    expect(meta.get("note")).toBe("Café/Ñote 📅.md");
    expect(meta.get("name")).toBe("日本.png");
  });
});

describe("errors from the core become AppError", () => {
  test("a structured error keeps its message, code and detail", async () => {
    const { api, AppError, codeOf } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock.invoke.mockRejectedValue({ code: "offline", message: "You're offline.", detail: "dns error: no route" });
    const e = await api.syncNow().catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("You're offline.");
    expect(e.code).toBe("offline");
    expect(e.detail).toBe("dns error: no route");
    expect(codeOf(e)).toBe("offline");
    // The raw text goes to the console only, tagged with the command.
    expect(warn).toHaveBeenCalledWith("[wandika] sync_now: dns error: no route");
  });

  test("detail that repeats the message, or none, is not logged", async () => {
    const { api } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mock.invoke.mockRejectedValueOnce({ code: "c", message: "Same." , detail: "Same." });
    await expect(api.tree()).rejects.toMatchObject({ code: "c", message: "Same." });
    mock.invoke.mockRejectedValueOnce({ code: "c", message: "No detail." });
    await expect(api.tree()).rejects.toMatchObject({ code: "c", detail: undefined });
    expect(warn).not.toHaveBeenCalled();
  });

  test("a plain string is the message", async () => {
    const { api, AppError, codeOf } = await load();
    mock.invoke.mockRejectedValue("That note no longer exists.");
    const e = await api.noteRead("Gone.md").catch((x) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e.message).toBe("That note no longer exists.");
    expect(e.code).toBe("message");
    expect(codeOf(e)).toBe("message");
  });

  test("an Error keeps its message", async () => {
    const { api } = await load();
    mock.invoke.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.status()).rejects.toMatchObject({ message: "Failed to fetch", code: "message" });
  });

  test("a browser exception with a number code is a plain message", async () => {
    const { api, codeOf } = await load();
    mock.invoke.mockRejectedValue(new DOMException("The operation was aborted.", "AbortError"));
    const e = await api.status().catch((x) => x);
    expect(e.message).toBe("The operation was aborted.");
    expect(codeOf(e)).toBe("message");
  });

  test("anything else is turned into text", async () => {
    const { api } = await load();
    mock.invoke.mockRejectedValueOnce(42);
    await expect(api.status()).rejects.toMatchObject({ message: "42", code: "message" });
    mock.invoke.mockRejectedValueOnce(null);
    await expect(api.status()).rejects.toMatchObject({ message: "null", code: "message" });
    mock.invoke.mockRejectedValueOnce({ message: "No code." });
    await expect(api.status()).rejects.toMatchObject({ message: "No code.", code: "message" });
    mock.invoke.mockRejectedValueOnce({ reason: "?" });
    await expect(api.status()).rejects.toMatchObject({ message: "[object Object]", code: "message" });
  });

  test("codeOf calls anything that isn't an AppError a plain message", async () => {
    const { codeOf, AppError } = await load();
    expect(codeOf(new Error("x"))).toBe("message");
    expect(codeOf("x")).toBe("message");
    expect(codeOf(undefined)).toBe("message");
    expect(codeOf({ code: "offline" })).toBe("message");
    expect(codeOf(new AppError("Busy", "sync_busy"))).toBe("sync_busy");
  });
});

describe("outside the core", () => {
  test("native is false in a browser and true inside Tauri", async () => {
    expect((await load()).native).toBe(false);
    expect((await load(true)).native).toBe(true);
  });

  test("openUrl opens a new tab in a browser", async () => {
    const { openUrl } = await load();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openUrl("https://github.com/login/device");
    expect(open).toHaveBeenCalledWith("https://github.com/login/device", "_blank", "noopener");
  });

  test("openUrl uses the system browser in the app", async () => {
    const { openUrl } = await load(true);
    await openUrl("https://github.com");
    expect(tauri.openUrl).toHaveBeenCalledWith("https://github.com");
  });

  test("pickFolder gives a sample folder in a browser", async () => {
    const { pickFolder } = await load();
    expect(await pickFolder()).toBe("/Users/jordan/Documents/Obsidian");
  });

  test("pickFolder returns the chosen folder, or null when cancelled", async () => {
    const { pickFolder } = await load(true);
    tauri.open.mockResolvedValueOnce("/Users/j/Notes");
    expect(await pickFolder()).toBe("/Users/j/Notes");
    expect(tauri.open).toHaveBeenCalledWith({ directory: true, multiple: false, title: "Choose a folder for your notes" });
    tauri.open.mockResolvedValueOnce(null);
    expect(await pickFolder()).toBeNull();
    tauri.open.mockResolvedValueOnce(["/a", "/b"]);
    expect(await pickFolder()).toBeNull();
  });

  test("canPickFolder only on a Mac without touch", async () => {
    const platform = vi.spyOn(navigator, "platform", "get");
    const restore = noTouch();
    try {
      platform.mockReturnValue("MacIntel");
      expect((await load()).canPickFolder).toBe(true);
      platform.mockReturnValue("Linux x86_64");
      expect((await load()).canPickFolder).toBe(false);
    } finally {
      restore();
    }
    // An iPad says MacIntel too, but has touch.
    platform.mockReturnValue("MacIntel");
    expect((await load()).canPickFolder).toBe(false);
  });

  test("listen subscribes to the mock in a browser", async () => {
    const off = vi.fn();
    mock.on.mockReturnValue(off);
    const { listen } = await load();
    const handler = vi.fn();
    expect(await listen("sync-progress", handler)).toBe(off);
    expect(mock.on).toHaveBeenCalledWith("sync-progress", handler);
  });

  test("listen hands the handler only the payload in the app", async () => {
    const off = vi.fn();
    tauri.listen.mockResolvedValue(off);
    const { listen } = await load(true);
    const handler = vi.fn();
    expect(await listen("sync-progress", handler)).toBe(off);
    const [name, wrapped] = tauri.listen.mock.calls[0];
    expect(name).toBe("sync-progress");
    wrapped({ event: "sync-progress", id: 1, payload: { done: 2 } });
    expect(handler).toHaveBeenCalledWith({ done: 2 });
  });
});
