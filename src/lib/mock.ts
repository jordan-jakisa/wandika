// In-browser stand-in for the Rust core, used only when the interface runs outside Tauri
// (`npm run dev` in a browser) so screens can be designed and checked without a device.

import { isBoard, tagsOf } from "./kanban";
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
/** "Tuesday 3 November 2026", as the Rust core heads a new daily note. */
const longDate = (d: Date) =>
  `${d.toLocaleDateString("en-GB", { weekday: "long" })} ${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "long" })} ${d.getFullYear()}`;
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
      longDate(today) +
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

/** As the Rust core cleans a name: characters a file name can't hold become "-"; one is required. */
const cleanName = (name: string) => {
  const n = String(name).trim().replace(/[/\\:*?"<>|]/g, "-").replace(/^\.+/, "").trim();
  if (!n) throw "Give the note a name.";
  return n;
};
/** The path itself and everything inside it, when it is a folder. */
const within = (path: string) => (k: string) => k === path || k.startsWith(path + "/");
// Thrown the way the core sends it, so the interface sees code "locked" and shows the passphrase form.
/** Notes changed outside the app (by Claude Code); tests push to it with `changeOutside`. */
const outside: { path: string; at: number }[] = [];
export function changeOutside(path: string, content: string) {
  notes.set(path, content);
  outside.push({ path, at: Date.now() });
}

/** The mock inbox's first email, the flight booking. */
const FLIGHT = "18c2f0a1b2c3d4e5";

const LOCKED = {
  code: "locked",
  message: "Encrypted notes are locked. Unlock them with your passphrase.",
  detail: "Encrypted notes are locked. Unlock them with your passphrase.",
};
const locked = (path: string) => path.endsWith(".age") && !encryption.unlocked;

/**
 * The daily note for `date` (YYYY-MM-DD, today when absent), created when it doesn't exist yet.
 * The mock has no .obsidian settings, so it always uses Daily/ (the core's choice for a vault
 * without them; with Obsidian's daily-note settings and no folder, the core uses the vault root).
 */
function daily(date?: string | null) {
  const day = date ?? iso(new Date());
  const d = new Date(`${day}T12:00:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(d.getTime()) || iso(d) !== day) throw "Dates look like 2026-11-02.";
  const path = `Daily/${day}.md`;
  if (!notes.has(path)) notes.set(path, `# ${longDate(d)}\n\n## Agenda\n\n## Notes\n\n## Tasks\n\n`);
  return path;
}

/** What was moved to the vault's .trash folder, by the path it came from. */
const trash = new Map<string, string | Uint8Array>();

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
    tags: tagsOf(text),
    encrypted: path.endsWith(".age"),
    locked: path.endsWith(".age") && !encryption.unlocked,
    board: isBoard(text),
    modified: Date.now(),
  }));
}

/** Cuts a task and the notes under it out of its note, the way the app's vault does. */
function takeTask(path: string, line: number, expected: string): string[] {
  if (locked(path)) throw LOCKED;
  const lines = (notes.get(path) ?? "").split("\n");
  const m = lines[line]?.match(/^(\s*)[-*+] \[[ xX]\] (.*)$/);
  if (!m) throw "That task moved. Refresh and try again.";
  if (m[2].trim() !== expected.trim()) throw "That task changed. Refresh and try again.";
  let n = 1;
  for (const next of lines.slice(line + 1)) {
    if (!next.trim() || next.length - next.trimStart().length <= m[1].length || /^\s*[-*+] \[[ xX]\] /.test(next)) break;
    n++;
  }
  const taken = lines.splice(line, n);
  notes.set(path, lines.join("\n"));
  return taken;
}

function putBack(path: string, line: number, taken: string[]) {
  if (!/^\s*[-*+] \[[ xX]\] /.test(taken[0] ?? "")) throw "There's no task to put back.";
  const lines = (notes.get(path) ?? "").split("\n");
  const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  lines.splice(Math.min(line, end), 0, ...taken);
  notes.set(path, lines.join("\n"));
}

function tasks(): VaultTask[] {
  const out: VaultTask[] = [];
  for (const [path, text] of notes) {
    if ((path.endsWith(".age") && !encryption.unlocked) || path.startsWith("Templates/") || /^archive\.md(\.age)?$/i.test(path)) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/^(\s*)[-*+] \[([ xX])\] (.*)$/);
      if (!m) return;
      const details: string[] = [];
      for (const next of lines.slice(i + 1)) {
        const indent = next.length - next.trimStart().length;
        if (!next.trim() || indent <= m[1].length || /^\s*[-*+] \[[ xX]\] /.test(next)) break;
        details.push(next.trim());
      }
      out.push({ path, title: titleOf(path), line: i, text: m[3], done: m[2] !== " ", due: m[3].match(/📅\s?(\d{4}-\d{2}-\d{2})/)?.[1] ?? null, details: details.join("\n") });
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
    configured: { github: true, google: true, microsoft: true, apple: true, gmail: true },
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
    const i = known.findIndex((k) => k.id === id);
    if (i >= 0) known.splice(i, 1);
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
  entry_restore: ({ path }) => {
    const back = [...trash.keys()].filter(within(path));
    if (!back.length) throw "It isn't in the trash any more.";
    if ([...notes.keys(), ...files.keys()].some(within(path))) throw "Something new has the same name there now, so it stays in the trash.";
    for (const k of back) {
      const v = trash.get(k)!;
      if (typeof v === "string") notes.set(k, v);
      else files.set(k, v);
      trash.delete(k);
    }
  },
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
    if (locked(path)) throw LOCKED;
    if (!notes.has(path)) throw "That note no longer exists.";
    return notes.get(path);
  },
  note_write: ({ path, content }) => {
    if (locked(path)) throw LOCKED;
    notes.set(path, content);
  },
  note_create: ({ folder: raw, title: name, body }) => {
    const folder = String(raw ?? "").replace(/^\/+|\/+$/g, "");
    const title = cleanName(name);
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
    const clean = cleanName(name);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const folder = !notes.has(path) && !files.has(path);
    if (folder && ![...notes.keys(), ...files.keys()].some(within(path))) throw "That note no longer exists.";
    // Notes keep .md (and .age); other files keep their type: "photo.png" renamed "beach" stays a PNG.
    let suffix = "";
    if (!folder) {
      const file = path.slice(dir.length);
      const base = file.replace(/\.age$/, "");
      const ext = path.endsWith(".md") || path.endsWith(".md.age") ? ".md" : base.includes(".") ? base.slice(base.lastIndexOf(".")) : "";
      const typed = ext && !ext.startsWith(".md") && clean.toLowerCase().endsWith(ext.toLowerCase());
      suffix = (typed ? "" : ext) + (file.endsWith(".age") ? ".age" : "");
    }
    const to = dir + clean + suffix;
    if (to === path) return to;
    const taken = [...notes.keys(), ...files.keys()].some(within(to));
    if (taken && to.toLowerCase() !== path.toLowerCase()) throw `“${clean}” already exists here.`;
    for (const map of [notes, files] as Map<string, unknown>[])
      for (const k of [...map.keys()].filter(within(path))) {
        const v = map.get(k);
        map.delete(k);
        map.set(to + k.slice(path.length), v);
      }
    if (folder) encryption.folders = encryption.folders.map((f) => (within(path)(f) ? to + f.slice(path.length) : f));
    else {
      // Links to it follow the new name, keeping any folder, heading and alias as written.
      const [from, into] = [titleOf(path), titleOf(to)];
      for (const [k, text] of notes) {
        const updated = text.replace(/\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g, (all, target: string, heading = "", alias = "") => {
          const t = target.trim();
          const slash = t.lastIndexOf("/");
          if (t.slice(slash + 1).toLowerCase() !== from.toLowerCase()) return all;
          return `[[${t.slice(0, slash + 1)}${into}${heading}${alias}]]`;
        });
        if (updated !== text) notes.set(k, updated);
      }
    }
    return to;
  },
  entry_trash: ({ path }) => {
    for (const k of [...trash.keys()].filter(within(path))) trash.delete(k);
    for (const map of [notes, files] as Map<string, string | Uint8Array>[])
      for (const k of [...map.keys()].filter(within(path))) {
        trash.set(k, map.get(k)!);
        map.delete(k);
      }
    encryption.folders = encryption.folders.filter((f) => !within(path)(f));
  },
  note_titles: () => meta(),
  search: ({ query }) => {
    // Every word must appear in the title, path or text; title matches rank first, as in the core.
    const q = String(query).trim().toLowerCase();
    if (!q) return [];
    const words = q.split(/\s+/);
    const hits = [];
    for (const [p, text] of notes) {
      const title = titleOf(p).toLowerCase();
      const path = p.toLowerCase();
      const body = locked(p) ? "" : text.toLowerCase();
      if (!words.every((w) => title.includes(w) || path.includes(w) || body.includes(w))) continue;
      let score = (title === q ? 1000 : 0) + (title.startsWith(q) ? 300 : 0);
      for (const w of words) score += (title.includes(w) ? 100 : 0) + Math.min(20, body.split(w).length - 1);
      const i = body.indexOf(words[0]);
      const from = Math.max(0, i - 60);
      const snippet = locked(p) ? "" : i < 0 ? text.slice(0, 140).replace(/\n/g, " ") : (from ? "…" : "") + text.slice(from, from + 160).replace(/\n/g, " ").trimStart();
      hits.push({ score, hit: { path: p, title: titleOf(p), snippet, encrypted: p.endsWith(".age") } });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 50).map((h) => h.hit);
  },
  backlinks: ({ path }) =>
    meta()
      .filter((m) => m.path !== path && m.links.some((l) => l.split("/").pop()!.toLowerCase() === titleOf(path).toLowerCase()))
      .map((m) => ({ path: m.path, title: m.title, snippet: (notes.get(m.path) ?? "").split("\n").find((l) => l.includes("[[")) ?? "", encrypted: m.encrypted })),
  // A link with a folder matches that path; a bare name matches any folder; the shortest path wins.
  resolve_link: ({ target }) => {
    const t = String(target).trim().replace(/\.md$/, "").toLowerCase();
    const stem = (p: string) => p.toLowerCase().replace(/\.age$/, "").replace(/\.md$/, "");
    const found = [...notes.keys()].filter((p) => stem(p) === t || stem(p).endsWith("/" + t));
    return found.sort((a, b) => a.length - b.length)[0] ?? null;
  },
  tasks_vault: () => tasks(),
  // Checks the line still holds the same task, then ticks it with an Obsidian Tasks done date.
  task_toggle: ({ path, line, text }) => {
    if (locked(path)) throw LOCKED;
    const lines = (notes.get(path) ?? "").split("\n");
    const m = lines[line]?.match(/^(\s*[-*+] \[)([ xX])(\] )(.*)$/);
    if (!m) throw "That task moved. Refresh and try again.";
    if (m[4].trim() !== String(text).trim()) throw "That task changed. Refresh and try again.";
    const done = m[2] === " ";
    const rest = m[4].replace(/\s*✅ \d{4}-\d{2}-\d{2}/g, "") + (done ? ` ✅ ${iso(new Date())}` : "");
    lines[line] = `${m[1]}${done ? "x" : " "}${m[3]}${rest}`;
    notes.set(path, lines.join("\n"));
    return done;
  },
  task_edit: ({ path, line, expected, text, details }) => {
    if (locked(path)) throw LOCKED;
    const lines = (notes.get(path) ?? "").split("\n");
    const m = lines[line]?.match(/^(\s*)([-*+] \[[ xX]\] )(.*)$/);
    if (!m) throw "That task moved. Refresh and try again.";
    if (m[3].trim() !== String(expected).trim()) throw "That task changed. Refresh and try again.";
    if (!String(text).trim()) throw "Give the task a name.";
    let old = 0;
    for (const next of lines.slice(line + 1)) {
      if (!next.trim() || next.length - next.trimStart().length <= m[1].length || /^\s*[-*+] \[[ xX]\] /.test(next)) break;
      old++;
    }
    const notesUnder = String(details).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => `${m[1]}  ${l}`);
    lines.splice(line, 1 + old, `${m[1]}${m[2]}${String(text).trim()}`, ...notesUnder);
    notes.set(path, lines.join("\n"));
  },
  task_delete: ({ path, line, expected }) => takeTask(String(path), Number(line), String(expected)),
  task_restore: ({ path, line, lines }) => putBack(String(path), Number(line), lines as string[]),
  task_archive: ({ path, line, expected }) => {
    const archive = String(path).endsWith(".age") ? "Archive.md.age" : "Archive.md";
    if (/^archive\.md(\.age)?$/i.test(String(path))) throw "That task is already in the archive.";
    const taken = takeTask(String(path), Number(line), String(expected));
    const indent = taken[0].length - taken[0].trimStart().length;
    const block = taken.map((l) => l.slice(indent));
    block.splice(1, 0, `  From [[${String(path).replace(/(\.md)?(\.age)?$/, "")}]], archived ${iso(new Date())}`);
    const appended = `${block.join("\n")}\n`;
    const was = notes.get(archive) ?? "# Archive\n";
    notes.set(archive, `${was.endsWith("\n") ? was : `${was}\n`}${appended}`);
    return { archive, taken, appended };
  },
  task_unarchive: ({ archive, appended, path, line, lines }) => {
    putBack(String(path), Number(line), lines as string[]);
    const text = notes.get(String(archive)) ?? "";
    const at = text.lastIndexOf(String(appended));
    if (at >= 0) notes.set(String(archive), text.slice(0, at) + text.slice(at + String(appended).length));
  },
  task_add: ({ text }) => {
    const path = daily(undefined);
    const body = (notes.get(path) ?? "").replace(/\n*$/, "");
    notes.set(path, body.includes("## Tasks") ? body.replace("## Tasks", `## Tasks\n\n- [ ] ${text}`) : `${body}\n\n## Tasks\n\n- [ ] ${text}\n`);
    return path;
  },
  mail_read: ({ id }) => ({
    subject: id === FLIGHT ? "Your flight to Nairobi is confirmed" : "Re: Wandika sync design",
    from: id === FLIGHT ? "Uganda Airlines <bookings@ugandaairlines.com>" : "Amina Okello <amina@example.com>",
    to: "jordan@example.com",
    date: at(7, 12),
    text: "Booking reference UR8K2.\n\nCheck-in opens 24 hours before departure.",
    html: id === FLIGHT ? '<h1>You are going to Nairobi</h1><p>Booking reference <b>UR8K2</b>.</p><p><a href="https://example.com/checkin">Check in</a></p><img src="https://tracker.example.com/pixel.gif" alt="">' : null,
    url: `https://mail.google.com/mail/u/0/#all/${id}`,
  }),
  external_changes: () => outside,
  daily_note: ({ date }) => daily(date),
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
        { id: "18c2f0a1b2c3d4e5", source: "google", subject: "Your flight to Nairobi is confirmed", from: "Uganda Airlines", date: at(7, 12), snippet: "Booking reference UR8K2. Check-in opens 24 hours before departure.", url: "https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5", unread: true },
        { id: "18c2f0a1b2c3d4e6", source: "google", subject: "Re: Wandika sync design", from: "Amina Okello", date: at(6, 40), snippet: "Three-way merge sounds right. What happens when both sides edit the same line?", url: null, unread: false },
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
  mail_to_note: ({ id }) => handlers.note_create({ folder: "Mail", title: id === FLIGHT ? "Your flight to Nairobi is confirmed" : "Re Wandika sync design", body: "# Email\n" }),
  event_to_note: ({ event }) => handlers.note_create({ folder: "Meetings", title: `${iso(today)} ${event.title}`, body: `# ${event.title}\n\n## Notes\n\n` }),
  agenda_to_daily: ({ date }) => daily(date),
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
