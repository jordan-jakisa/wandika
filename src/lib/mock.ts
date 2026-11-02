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
    "# Wandika\n\nNotes app on **Mac, iPhone and Android**, synced through GitHub.\n\n![[Sync sketch.svg]]\n\n## Next\n\n- [ ] Test sync with two phones\n- [ ] Encrypt the *Private* folder\n\n> Plain files first. Nothing that Obsidian couldn't open.\n\n> [!warning] Before the first sync\n> Back up the vault folder once.\n\n> [!tip]\n> Long-press a note in the list for more actions.\n\n```rust\nfn main() { println!(\"#notatag [[notalink]]\"); }\n```\n",
  ],
  [
    "Projects/Sync design.md",
    "How a change travels between devices.\n\n```mermaid\nflowchart LR\n  A[Edit on Mac] --> B[Save to disk]\n  B --> C{Changed on GitHub too?}\n  C -- no --> D[Push commit]\n  C -- yes --> E[Three-way merge]\n  E --> D\n  D --> F[Phone pulls]\n```\n\n```mermaid\npie title Notes by folder\n  \"Daily\" : 42\n  \"Projects\" : 18\n  \"Mail\" : 9\n```\n",
  ],
  [
    "START_HERE.md",
    "The dashboard is [[Welcome]]. Open that.\n\n## Vault layout (PARA-ish)\n\n| Folder | Purpose | When to add here |\n|---|---|---|\n| `00_Inbox/` | Capture | Anything you don't want to think about right now. **Triage to empty weekly.** |\n| `01_Atlas/` | Knowledge base + MOCs | Cross-cutting maps, journals |\n| `02_Projects/` | Active work | When you start something with a clear \"done\" #para |\n\n## Conventions\n\nOne concept per file.\n",
  ],
  ["Templates/Meeting.md", "## {{title}}\n\n{{date:dddd D MMMM}}, {{time}}\n\n### Attendees\n\n- \n\n### Notes\n\n### Actions\n\n- [ ] \n"],
  ["Reading list.md", "---\ntags: [reading, books]\nstatus: ongoing\nsource: \"[[Projects/Wandika]]\"\n---\n# Reading list\n\n- The Elements of Typographic Style\n- [[Projects/Wandika]] notes on sync #reading\n\n![[Projects/Wandika#Next]]\n"],
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
// `?big` adds 300 linked notes in folders, for judging the graph at a realistic size; `?big=644`
// sizes it like Jordan's vault, with 2,000 images as well.
const bigParam = typeof location !== "undefined" ? new URLSearchParams(location.search).get("big") : null;
const BIG_NOTES = bigParam === null ? 0 : Number(bigParam) || 300;
const BIG_FILES: string[] = [];
if (BIG_NOTES) {
  const folders = ["00_Inbox", "01_Atlas", "02_Projects", "03_Sources", "04_Articles", "07_Areas", "09_Topics", "Daily"];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const titles: string[] = [];
  for (let i = 0; i < BIG_NOTES; i++) titles.push(`${folders[Math.floor(rand() * rand() * folders.length)]}/Note ${i}`);
  titles.forEach((t, i) => {
    const hub = i % 37 === 0;
    const n = rand() < 0.35 ? 0 : hub ? 12 : Math.ceil(rand() * 3);
    const links = Array.from({ length: n }, () => `[[${titles[Math.floor(rand() * (hub ? BIG_NOTES : Math.min(BIG_NOTES, i + 40)))].split("/")[1]}]]`);
    notes.set(`${t}.md`, `Linked: ${links.join(" ")}\n- [ ] Task ${i}\n`);
  });
  if (BIG_NOTES > 300) for (let i = 0; i < 2000; i++) BIG_FILES.push(`05_Visuals/Images/Pasted image ${i}.png`);
}

let encryption = { set_up: true, unlocked: false, folders: ["Private"] };
// `?mock=vault` opens straight into a vault, for checking screens after a reload.
const startInVault = typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "vault";
let signedIn = startInVault;
type Vault = NonNullable<Status["vault"]>;
const githubVault: Vault = { id: "github/jordan-jakisa/notes", name: "notes", folder: null, remote: { owner: "jordan-jakisa", repo: "notes", branch: "main" } };
let vault: Vault | null = startInVault ? githubVault : null;
const known: Vault[] = startInVault ? [githubVault] : [];
const remember = (v: Vault) => {
  const i = known.findIndex((k) => k.id === v.id);
  if (i >= 0) known[i] = v;
  else known.push(v);
};
let polls = 0;
let lastSync: number | null = null;

const titleOf = (p: string) => p.split("/").pop()!.replace(/\.age$/, "").replace(/\.md$/, "");

/** Images and other files, by vault path. */
const files = new Map<string, Uint8Array>([
  [
    "attachments/Sync sketch.svg",
    new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300"><rect width="640" height="300" fill="#e9efe9"/><g fill="none" stroke="#2f6b4f" stroke-width="4"><rect x="40" y="110" width="150" height="80" rx="12"/><rect x="245" y="110" width="150" height="80" rx="12"/><rect x="450" y="110" width="150" height="80" rx="12"/><path d="M190 150h55M395 150h55"/></g><g font-family="sans-serif" font-size="22" fill="#1d2b24" text-anchor="middle"><text x="115" y="157">Mac</text><text x="320" y="157">GitHub</text><text x="525" y="157">Phone</text></g></svg>',
    ),
  ],
]);

function entries(): Entry[] {
  const folders = new Set<string>();
  for (const p of [...notes.keys(), ...files.keys(), ...BIG_FILES]) {
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
  for (const p of [...files.keys(), ...BIG_FILES]) out.push({ path: p, name: p.split("/").pop()!, kind: "file", encrypted: false, modified: Date.now() });
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
    if ((path.endsWith(".age") && !encryption.unlocked) || path.startsWith("Templates/")) continue;
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

const snippets = [
  { name: "wide-tables", css: ".cm-table { width: 100%; }", enabled: false },
  { name: "rounded-cards", css: ".card { border-radius: 14px; }", enabled: true },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const handlers: Record<string, (a: Args) => unknown> = {
  status: () => ({
    configured: { github: true, google: true, microsoft: true, apple: true },
    user: signedIn ? { login: "jordan-jakisa", name: "Jordan", avatar_url: "" } : null,
    vault,
    known,
    last_sync: lastSync,
    encryption: vault ? encryption : null,
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
    if (vault?.remote) vault = null;
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
    vault = { id: `github/${owner}/${repo}`, name: repo, folder: null, remote: { owner, repo, branch: "main" } };
    remember(vault);
    lastSync = Date.now();
    return { pulled: [...notes.keys()], pushed: [], removed: [], merged: [], conflicts: [], too_big: [], held_deletions: [], vault_bytes: 312_000_000, head: "abc", at: lastSync };
  },
  snippets_list: () => snippets,
  snippet_toggle: ({ name, enabled }) => {
    const sn = snippets.find((x) => x.name === name);
    if (sn) sn.enabled = enabled;
  },
  vault_close: () => {
    vault = null;
  },
  vault_create_local: ({ name, folder }) => {
    vault = { id: `local/${Date.now()}`, name: name || String(folder).split("/").pop(), folder: folder ?? null, remote: null };
    remember(vault);
  },
  vault_switch: ({ id }) => {
    vault = known.find((k) => k.id === id) ?? null;
  },
  vault_forget: ({ id }) => {
    known.splice(known.findIndex((k) => k.id === id), 1);
    if (vault?.id === id) vault = null;
  },
  vault_connect_remote: async ({ owner, repo }) => {
    await sleep(800);
    vault = { ...vault!, remote: { owner, repo, branch: "main" } };
    remember(vault);
    lastSync = Date.now();
    return { pulled: [], pushed: [...notes.keys()], removed: [], merged: [], conflicts: [], too_big: [], held_deletions: [], vault_bytes: 312_000_000, head: "abc", at: lastSync };
  },
  vault_disconnect_remote: () => {
    vault = { ...vault!, remote: null };
    remember(vault);
  },
  sync_now: async () => {
    await sleep(700);
    lastSync = Date.now();
    return { pulled: [], pushed: [], removed: [], merged: [], conflicts: [], too_big: [], held_deletions: [], vault_bytes: 312_000_000, head: "abc", at: lastSync };
  },
  tree: () => entries(),
  sync_cancel: () => undefined,
  sync_held_deletions: () => undefined,
  entry_restore: () => undefined,
  note_discard_if_empty: ({ path }) => {
    if (!/^Untitled( \d+)?$/.test(titleOf(path)) || (notes.get(path) ?? "x").trim()) return false;
    notes.delete(path);
    return true;
  },
  new_note_folder: ({ current }) => (current && current.includes("/") ? current.slice(0, current.lastIndexOf("/")) : ""),
  templates_list: () => [...notes.keys()].filter((p) => p.startsWith("Templates/")),
  template_render: ({ path, title }) =>
    (notes.get(path) ?? "")
      .replace(/\{\{\s*title\s*\}\}/g, title)
      .replace(/\{\{\s*date[^}]*\}\}/g, iso(today))
      .replace(/\{\{\s*time[^}]*\}\}/g, today.toTimeString().slice(0, 5)),
  attachment_save: ({ name, bytes }) => {
    let path = `attachments/${name}`;
    for (let n = 1; files.has(path); n++) path = `attachments/${name.replace(/(\.[^.]+)?$/, ` ${n}$1`)}`;
    files.set(path, bytes);
    return path;
  },
  attachment_read: ({ target }) => {
    const name = target.split("/").pop()!.toLowerCase();
    const hit = [...files.keys()].find((p) => p === target || p.split("/").pop()!.toLowerCase() === name);
    if (!hit) throw `${target} isn't in this vault.`;
    return files.get(hit)!.slice().buffer;
  },
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
      errors: {
        "Outlook Mail": { code: "provider_auth", message: "Outlook needs you to sign in again. Reconnect it in Settings, under Connections." },
        "Outlook Calendar": { code: "provider_auth", message: "Outlook needs you to sign in again. Reconnect it in Settings, under Connections." },
      },
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
