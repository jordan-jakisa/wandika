// In-browser stand-in for the Rust core, used only when the interface runs outside Tauri
// (`npm run dev` in a browser) so screens can be designed and checked without a device.

import { isBoard } from "./kanban";
import type { CalEvent, Entry, NoteMeta, Status, VaultTask } from "./types";

type Args = Record<string, any>;
const listeners = new Map<string, Set<(p: unknown) => void>>();

export function on(event: string, fn: (p: unknown) => void) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(fn);
  return () => listeners.get(event)!.delete(fn);
}

const today = new Date();
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const at = (h: number, m = 0) => {
  const d = new Date(today);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const notes = new Map<string, string>([
  [
    "Welcome.md",
    "# Welcome to Wandika\n\nThis repository is your notes vault. Every note is a Markdown file, so it also opens in Obsidian.\n\nLink notes with [[Reading list]] or [[Projects/Wandika]], tag them with #idea, and tick tasks off:\n\n- [x] Pick a repository\n- [ ] Write your first note\n- [ ] Connect a calendar 📅 " +
      iso(today) +
      "\n",
  ],
  [
    "Projects/Wandika.md",
    "# Wandika\n\nNotes app on **Mac, iPhone and Android**, synced through GitHub.\n\n## Next\n\n- [ ] Test sync with two phones\n- [ ] Encrypt the *Private* folder\n\n> Plain files first. Nothing that Obsidian couldn't open.\n\n```rust\nfn main() { println!(\"#notatag [[notalink]]\"); }\n```\n",
  ],
  ["Reading list.md", "# Reading list\n\n- The Elements of Typographic Style\n- [[Projects/Wandika]] notes on sync #reading\n"],
  [
    "Daily/" + iso(today) + ".md",
    "# " +
      today.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) +
      "\n\n## Agenda\n\n## Notes\n\n## Tasks\n\n",
  ],
  [
    "Projects/Wandika launch.md",
    "---\n\nkanban-plugin: basic\n\n---\n\n## To do\n\n- [ ] Set up OAuth apps #setup\n- [ ] Test on the Android phone #testing 📅 " +
      iso(today) +
      "\n- [ ] Write [[Reading list]] review\n\n\n## Doing\n\n- [ ] [[Projects/Wandika]] sync design #design\n\n\n## Done\n\n**Complete**\n- [x] Pick a stack #design\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"basic\"}\n```\n%%\n",
  ],
  ["Private/Passport renewal.md.age", "# Passport renewal\n\nAppointment reference and documents list.\n"],
]);
let encryption = { set_up: true, unlocked: false, folders: ["Private"] };
// `?mock=vault` opens straight into a vault, for checking screens after a reload.
const startInVault = typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "vault";
let signedIn = startInVault;
let target: Status["target"] = startInVault ? { owner: "jordan-jakisa", repo: "notes", branch: "main" } : null;
let polls = 0;
let lastSync: number | null = null;

const titleOf = (p: string) => p.split("/").pop()!.replace(/\.age$/, "").replace(/\.md$/, "");

function entries(): Entry[] {
  const folders = new Set<string>();
  for (const p of notes.keys()) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  const out: Entry[] = [...folders].map((f) => ({
    path: f,
    name: f.split("/").pop()!,
    kind: "folder",
    encrypted: false,
    modified: Date.now(),
  }));
  for (const p of notes.keys())
    out.push({ path: p, name: titleOf(p), kind: "note", encrypted: p.endsWith(".age"), modified: Date.now() });
  return out.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
}

function meta(): NoteMeta[] {
  return [...notes.entries()].map(([path, text]) => ({
    path,
    title: titleOf(path),
    links: [...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1]),
    tags: [...text.matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)].map((m) => m[1]),
    encrypted: path.endsWith(".age"),
    locked: path.endsWith(".age") && !encryption.unlocked,
    board: isBoard(text),
    modified: Date.now(),
  }));
}

function tasks(): VaultTask[] {
  const out: VaultTask[] = [];
  for (const [path, text] of notes) {
    if (path.endsWith(".age") && !encryption.unlocked) continue;
    text.split("\n").forEach((line, i) => {
      const m = line.match(/^\s*[-*+] \[([ xX])\] (.*)$/);
      if (m) out.push({ path, title: titleOf(path), line: i, text: m[2], done: m[1] !== " ", due: m[2].match(/📅\s?(\d{4}-\d{2}-\d{2})/)?.[1] ?? null });
    });
  }
  return out;
}

const events: CalEvent[] = [
  { id: "1", source: "google", calendar: "Personal", title: "Gym", start: iso(today) + "T00:00:00", end: iso(today) + "T00:00:00", all_day: true, location: null, url: null, attendees: [] },
  { id: "2", source: "microsoft", calendar: "Outlook", title: "Product standup", start: at(9, 30), end: at(9, 45), all_day: false, location: null, url: "https://teams.microsoft.com", attendees: ["Amina Okello", "Brian Kato"] },
  { id: "3", source: "apple", calendar: "Home", title: "Call with the landlord", start: at(13), end: at(13, 30), all_day: false, location: "Kampala", url: null, attendees: [] },
  { id: "4", source: "google", calendar: "Work", title: "Design review: Today panel", start: at(16), end: at(17), all_day: false, location: null, url: "https://meet.google.com", attendees: ["Sarah N."] },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const handlers: Record<string, (a: Args) => unknown> = {
  status: () => ({
    configured: { github: true, google: true, microsoft: true, apple: true },
    user: signedIn ? { login: "jordan-jakisa", name: "Jordan", avatar_url: "" } : null,
    target,
    last_sync: lastSync,
    encryption: target ? encryption : null,
    connectors: { google: "jordan@example.com", microsoft: null, apple_calendar: "granted", apple_reminders: "not_asked" },
  }),
  github_start_login: () => ({ device_code: "d", user_code: "WDKA-2611", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }),
  github_poll_login: () => {
    if (++polls < 3) return null;
    signedIn = true;
    return { user: { login: "jordan-jakisa", name: "Jordan", avatar_url: "" } };
  },
  github_sign_out: () => {
    signedIn = false;
    target = null;
  },
  repos_list: async () => {
    await sleep(400);
    return [
      { name: "notes", full_name: "jordan-jakisa/notes", owner: { login: "jordan-jakisa" }, private: true, default_branch: "main", description: "Everything I write down", pushed_at: new Date(Date.now() - 36e5).toISOString() },
      { name: "wandika", full_name: "jordan-jakisa/wandika", owner: { login: "jordan-jakisa" }, private: false, default_branch: "main", description: "Markdown notes synced through GitHub", pushed_at: new Date(Date.now() - 864e5).toISOString() },
      { name: "rowpin", full_name: "jordan-jakisa/rowpin", owner: { login: "jordan-jakisa" }, private: true, default_branch: "main", description: null, pushed_at: new Date(Date.now() - 6048e5).toISOString() },
    ];
  },
  repo_create: ({ name }) => ({ name, full_name: `jordan-jakisa/${name}`, owner: { login: "jordan-jakisa" }, private: true, default_branch: "main", description: null, pushed_at: null }),
  vault_open: async ({ owner, repo }) => {
    await sleep(900);
    target = { owner, repo, branch: "main" };
    lastSync = Date.now();
    return { pulled: [...notes.keys()], pushed: [], removed: [], merged: [], conflicts: [], too_big: [], head: "abc", at: lastSync };
  },
  vault_close: () => {
    target = null;
  },
  sync_now: async () => {
    await sleep(700);
    lastSync = Date.now();
    return { pulled: [], pushed: [], removed: [], merged: [], conflicts: [], too_big: [], head: "abc", at: lastSync };
  },
  tree: () => entries(),
  note_read: ({ path }) => {
    if (path.endsWith(".age") && !encryption.unlocked) throw "Encrypted notes are locked. Unlock them with your passphrase.";
    if (!notes.has(path)) throw "That note no longer exists.";
    return notes.get(path);
  },
  note_write: ({ path, content }) => void notes.set(path, content),
  note_create: ({ folder, title, body }) => {
    const ext = encryption.folders.some((f) => folder === f || folder.startsWith(f + "/")) ? ".md.age" : ".md";
    let n = 1;
    let path = "";
    do path = `${folder ? folder + "/" : ""}${title}${n > 1 ? " " + n : ""}${ext}`;
    while (notes.has(path) && ++n);
    notes.set(path, body ?? "");
    return path;
  },
  folder_create: () => undefined,
  entry_rename: ({ path, name }) => {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const ext = path.endsWith(".md.age") ? ".md.age" : ".md";
    const to = dir + name + ext;
    notes.set(to, notes.get(path) ?? "");
    notes.delete(path);
    return to;
  },
  entry_trash: ({ path }) => {
    for (const k of [...notes.keys()]) if (k === path || k.startsWith(path + "/")) notes.delete(k);
  },
  note_titles: () => meta(),
  search: ({ query }) => {
    const q = String(query).toLowerCase();
    return [...notes.entries()]
      .filter(([p, t]) => p.toLowerCase().includes(q) || (!p.endsWith(".age") && t.toLowerCase().includes(q)))
      .map(([p, t]) => {
        const i = t.toLowerCase().indexOf(q);
        return { path: p, title: titleOf(p), snippet: i >= 0 ? t.slice(Math.max(0, i - 40), i + 100).replace(/\n/g, " ") : "", encrypted: p.endsWith(".age") };
      });
  },
  backlinks: ({ path }) =>
    meta()
      .filter((m) => m.path !== path && m.links.some((l) => l.split("/").pop()!.toLowerCase() === titleOf(path).toLowerCase()))
      .map((m) => ({ path: m.path, title: m.title, snippet: (notes.get(m.path) ?? "").split("\n").find((l) => l.includes("[[")) ?? "", encrypted: m.encrypted })),
  resolve_link: ({ target: t }) => [...notes.keys()].find((p) => p.replace(/\.md(\.age)?$/, "").toLowerCase().endsWith(String(t).toLowerCase())) ?? null,
  tasks_vault: () => tasks(),
  task_toggle: ({ path, line }) => {
    const lines = (notes.get(path) ?? "").split("\n");
    const done = /\[ \]/.test(lines[line]);
    lines[line] = lines[line].replace(/\[( |x|X)\]/, done ? "[x]" : "[ ]");
    notes.set(path, lines.join("\n"));
    return done;
  },
  daily_note: () => "Daily/" + iso(today) + ".md",
  encryption_setup: () => (encryption = { ...encryption, set_up: true, unlocked: true }),
  encryption_unlock: ({ passphrase }) => {
    if (String(passphrase).length < 8) throw "Wrong passphrase, or this file was encrypted with another key.";
    return (encryption = { ...encryption, unlocked: true });
  },
  encryption_lock: () => (encryption = { ...encryption, unlocked: false }),
  set_encrypted: ({ path, encrypt }) => {
    const to = encrypt ? path + ".age" : path.replace(/\.age$/, "");
    notes.set(to, notes.get(path) ?? "");
    notes.delete(path);
    return to;
  },
  connector_connect: ({ provider }) =>
    provider === "microsoft"
      ? { kind: "device", device_code: "m", user_code: "F4K3C0DE", verification_uri: "https://microsoft.com/devicelogin", interval: 2 }
      : provider.startsWith("apple")
        ? { kind: "done", access: "granted" }
        : { kind: "browser" },
  connector_poll: () => false,
  connector_disconnect: () => undefined,
  today: async () => {
    await sleep(300);
    return {
      events,
      mail: [
        { id: "a", source: "google", subject: "Your flight to Nairobi is confirmed", from: "Uganda Airlines", date: at(7, 12), snippet: "Booking reference UR8K2. Check-in opens 24 hours before departure.", url: null, unread: true },
        { id: "b", source: "google", subject: "Re: Wandika sync design", from: "Amina Okello", date: at(6, 40), snippet: "Three-way merge sounds right. What happens when both sides edit the same line?", url: null, unread: false },
      ],
      tasks: tasks().filter((t) => !t.done),
      remote_tasks: [{ id: "r1", source: "google", list_id: "l", list: "My Tasks", title: "Renew domain", done: false, due: iso(today) }],
      errors: { "Outlook Mail": "Your Outlook sign-in expired. Connect it again." },
    };
  },
  remote_task_toggle: () => undefined,
  mail_to_note: ({ id }) => handlers.note_create({ folder: "Mail", title: id === "a" ? "Your flight to Nairobi is confirmed" : "Re Wandika sync design", body: "# Email\n" }),
  event_to_note: ({ event }) => handlers.note_create({ folder: "Meetings", title: `${iso(today)} ${event.title}`, body: `# ${event.title}\n\n## Notes\n\n` }),
  agenda_to_daily: () => "Daily/" + iso(today) + ".md",
};

export async function invoke(cmd: string, args: Args = {}): Promise<unknown> {
  // Lets a screen check count backend calls, e.g. to catch an effect that loops.
  (globalThis as { __mockCalls?: Record<string, number> }).__mockCalls ??= {};
  const calls = (globalThis as { __mockCalls?: Record<string, number> }).__mockCalls!;
  calls[cmd] = (calls[cmd] ?? 0) + 1;
  const h = handlers[cmd];
  if (!h) throw `Mock has no command ${cmd}`;
  await sleep(40);
  return h(args);
}
