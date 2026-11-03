import type {
  Archived,
  CalEvent,
  ConnectStart,
  CryptoStatus,
  DeviceCode,
  Entry,
  MailBody,
  NoteMeta,
  Repo,
  SearchHit,
  Status,
  SyncReport,
  Snippet,
  Today,
  User,
  VaultTask,
} from "./types";

type Args = Record<string, unknown>;

/** True inside the Tauri app; false when the interface is opened in a plain browser for design work. */
export const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Invoke = (cmd: string, args?: Args | Uint8Array, options?: { headers: Record<string, string> }) => Promise<unknown>;
let backend: Promise<Invoke> | null = null;

function load() {
  backend ??= native
    ? import("@tauri-apps/api/core").then((m) => m.invoke)
    : import("./mock").then((m) => m.invoke as Invoke);
  return backend;
}

/**
 * An error from the Rust core: `message` is the plain sentence for people, `code` is for the
 * interface to act on, and `detail` (the raw service or system text) only goes to the console.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export const codeOf = (e: unknown) => (e instanceof AppError ? e.code : "message");

async function call<T>(cmd: string, args?: Args | Uint8Array, options?: { headers: Record<string, string> }): Promise<T> {
  const invoke = await load();
  try {
    return (await invoke(cmd, args, options)) as T;
  } catch (e) {
    // The core's errors carry a text code; a DOMException's number code is not one of them.
    if (e && typeof e === "object" && "code" in e && "message" in e && typeof e.code === "string") {
      const { code, message, detail } = e as { code: string; message: string; detail?: string };
      if (detail && detail !== message) console.warn(`[wandika] ${cmd}: ${detail}`);
      throw new AppError(message, code, detail);
    }
    // Errors from another realm (a DOMException from the web view) fail instanceof, so read message.
    const text = e && typeof e === "object" && "message" in e && typeof e.message === "string" ? e.message : null;
    const message = typeof e === "string" ? e : (text ?? String(e));
    throw new AppError(message, "message");
  }
}

export async function openUrl(url: string) {
  if (native) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** Mac only: the system folder picker. Null when cancelled or unavailable. */
export async function pickFolder(): Promise<string | null> {
  if (!native) return "/Users/jordan/Documents/Obsidian";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Choose a folder for your notes" });
  return typeof picked === "string" ? picked : null;
}

/** Folder vaults need a real file system to point at, which only the Mac app has. */
export const canPickFolder =
  typeof navigator !== "undefined" && /Mac/.test(navigator.platform) && !("ontouchend" in document);

/** Subscribes to an event from the Rust core. Returns the unsubscribe function. */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!native) {
    const { on } = await import("./mock");
    return on(event, handler as (p: unknown) => void);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload));
}

export const api = {
  status: () => call<Status>("status"),

  githubStartLogin: () => call<DeviceCode>("github_start_login"),
  githubPollLogin: (deviceCode: string) =>
    call<{ user?: User; slow_down?: boolean } | null>("github_poll_login", { deviceCode }),
  githubSignOut: () => call<void>("github_sign_out"),
  reposList: () => call<Repo[]>("repos_list"),
  repoCreate: (name: string) => call<Repo>("repo_create", { name }),
  vaultOpen: (owner: string, repo: string) => call<SyncReport>("vault_open", { owner, repo }),
  vaultClose: () => call<void>("vault_close"),
  vaultCreateLocal: (name: string, folder?: string) => call<void>("vault_create_local", { name, folder }),
  vaultSwitch: (id: string) => call<void>("vault_switch", { id }),
  vaultForget: (id: string) => call<void>("vault_forget", { id }),
  vaultConnectRemote: (owner: string, repo: string) => call<SyncReport>("vault_connect_remote", { owner, repo }),
  vaultDisconnectRemote: () => call<void>("vault_disconnect_remote"),
  syncNow: () => call<SyncReport>("sync_now"),
  /** Held deletions: delete them on GitHub too (next sync), or bring them back here. */
  syncHeldDeletions: (del: boolean, paths: string[]) => call<void>("sync_held_deletions", { delete: del, paths }),
  /** Stops the running sync at its next file; nothing on GitHub changes. */
  syncCancel: () => call<void>("sync_cancel"),

  tree: () => call<Entry[]>("tree"),
  /** Saves a file next to `note` (Obsidian's attachment folder) and returns its vault path. */
  attachmentSave: async (note: string, name: string, file: Blob) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // The bytes travel as the raw request body; the names ride in a header.
    return native
      ? call<string>("attachment_save", bytes, { headers: { "x-meta": new URLSearchParams({ note, name }).toString() } })
      : call<string>("attachment_save", { note, name, bytes });
  },
  attachmentRead: (target: string, from: string) => call<ArrayBuffer>("attachment_read", { target, from }),
  /** Where a new note goes, following Obsidian's "Default location for new notes". */
  newNoteFolder: (current: string | null) => call<string>("new_note_folder", { current }),
  templatesList: () => call<string[]>("templates_list"),
  templateRender: (path: string, title: string) => call<string>("template_render", { path, title }),
  /** Removes a note left empty and still named "Untitled". True when it was removed. */
  noteDiscardIfEmpty: (path: string) => call<boolean>("note_discard_if_empty", { path }),
  /** Puts something moved to the trash back where it was. */
  entryRestore: (path: string) => call<void>("entry_restore", { path }),
  noteRead: (path: string) => call<string>("note_read", { path }),
  noteWrite: (path: string, content: string) => call<void>("note_write", { path, content }),
  noteCreate: (folder: string, title: string, body?: string) =>
    call<string>("note_create", { folder, title, body }),
  folderCreate: (path: string) => call<void>("folder_create", { path }),
  entryRename: (path: string, name: string) => call<string>("entry_rename", { path, name }),
  entryTrash: (path: string) => call<void>("entry_trash", { path }),
  noteTitles: () => call<NoteMeta[]>("note_titles"),
  search: (query: string) => call<SearchHit[]>("search", { query }),
  backlinks: (path: string) => call<SearchHit[]>("backlinks", { path }),
  resolveLink: (target: string) => call<string | null>("resolve_link", { target }),
  tasksVault: () => call<VaultTask[]>("tasks_vault"),
  taskToggle: (path: string, line: number, text: string) =>
    call<boolean>("task_toggle", { path, line, text }),
  taskEdit: (path: string, line: number, expected: string, text: string, details: string) =>
    call<void>("task_edit", { path, line, expected, text, details }),
  /** Deletes a task and its notes; returns the removed lines, for Undo. */
  taskDelete: (path: string, line: number, expected: string) => call<string[]>("task_delete", { path, line, expected }),
  taskRestore: (path: string, line: number, lines: string[]) => call<void>("task_restore", { path, line, lines }),
  /** Moves a task and its notes to the vault's archive note. */
  taskArchive: (path: string, line: number, expected: string) => call<Archived>("task_archive", { path, line, expected }),
  taskUnarchive: (done: Archived, path: string, line: number) =>
    call<void>("task_unarchive", { archive: done.archive, appended: done.appended, path, line, lines: done.taken }),
  /** Adds a task to today's note; returns the note's path. */
  taskAdd: (text: string) => call<string>("task_add", { text }),
  dailyNote: (date?: string) => call<string>("daily_note", { date }),

  snippetsList: () => call<Snippet[]>("snippets_list"),
  snippetToggle: (name: string, enabled: boolean) => call<void>("snippet_toggle", { name, enabled }),
  encryptionSetup: (passphrase: string) => call<CryptoStatus>("encryption_setup", { passphrase }),
  encryptionUnlock: (passphrase: string) => call<CryptoStatus>("encryption_unlock", { passphrase }),
  encryptionLock: () => call<CryptoStatus>("encryption_lock"),
  setEncrypted: (path: string, encrypt: boolean) => call<string>("set_encrypted", { path, encrypt }),

  connectorConnect: (provider: string) => call<ConnectStart>("connector_connect", { provider }),
  connectorPoll: (deviceCode: string) => call<boolean>("connector_poll", { deviceCode }),
  connectorDisconnect: (provider: string) => call<void>("connector_disconnect", { provider }),
  today: (date?: string) => call<Today>("today", { date }),
  remoteTaskToggle: (source: string, listId: string, id: string, done: boolean) =>
    call<void>("remote_task_toggle", { source, listId, id, done }),
  mailToNote: (source: string, id: string) => call<string>("mail_to_note", { source, id }),
  mailRead: (source: string, id: string) => call<MailBody>("mail_read", { source, id }),
  /** Notes Claude Code changed through Wandika's MCP server, newest last, from the last two minutes. */
  externalChanges: () => call<{ path: string; at: number }[]>("external_changes"),
  eventToNote: (event: CalEvent) => call<string>("event_to_note", { event }),
  agendaToDaily: (events: CalEvent[], date?: string) =>
    call<string>("agenda_to_daily", { events, date }),
};
