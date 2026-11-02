import type {
  CalEvent,
  ConnectStart,
  CryptoStatus,
  DeviceCode,
  Entry,
  NoteMeta,
  Repo,
  SearchHit,
  Status,
  SyncReport,
  Today,
  User,
  VaultTask,
} from "./types";

type Args = Record<string, unknown>;

/** True inside the Tauri app; false when the interface is opened in a plain browser for design work. */
export const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let backend: Promise<(cmd: string, args?: Args) => Promise<unknown>> | null = null;

function load() {
  backend ??= native
    ? import("@tauri-apps/api/core").then((m) => m.invoke)
    : import("./mock").then((m) => m.invoke);
  return backend;
}

async function call<T>(cmd: string, args?: Args): Promise<T> {
  const invoke = await load();
  try {
    return (await invoke(cmd, args)) as T;
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
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

  tree: () => call<Entry[]>("tree"),
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
  dailyNote: (date?: string) => call<string>("daily_note", { date }),

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
  eventToNote: (event: CalEvent) => call<string>("event_to_note", { event }),
  agendaToDaily: (events: CalEvent[], date?: string) =>
    call<string>("agenda_to_daily", { events, date }),
};
