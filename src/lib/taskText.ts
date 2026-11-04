// A task line in the Obsidian Tasks emoji format, so the vault stays readable in Obsidian:
// `Call Amina #home 📌 ⏫ 📅 2026-11-05`. 📌 (pinned) is Wandika's own; Obsidian shows it as text.

export type Priority = "highest" | "high" | "medium" | "low" | "lowest";

export const PRIORITIES: { value: Priority; emoji: string; label: string }[] = [
  { value: "highest", emoji: "🔺", label: "Highest" },
  { value: "high", emoji: "⏫", label: "High" },
  { value: "medium", emoji: "🔼", label: "Medium" },
  { value: "low", emoji: "🔽", label: "Low" },
  { value: "lowest", emoji: "⏬", label: "Lowest" },
];

export interface TaskParts {
  /** The words, tags included, without the markers. */
  name: string;
  tags: string[];
  pinned: boolean;
  priority: Priority | null;
  due: string | null;
}

const PIN = "📌";
const TAG = /(?:^|\s)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
/** Every Obsidian Tasks marker, plus 📌. The name ends where the first one starts. */
const MARKER = /[📌🔺⏫🔼🔽⏬📅⏳🛫✅❌➕🔁🆔⛔]/u;
const MARKERS = new RegExp(MARKER.source, "gu");

export function tagsOf(text: string): string[] {
  return [...new Set([...text.matchAll(TAG)].map((m) => m[1].toLowerCase()))];
}

/** The name, and each marker with its value (`📅 2026-11-05`, `⏫`), in order. */
function split(text: string): { name: string; meta: string[] } {
  const clean = text.replace(/\uFE0F/g, "");
  const at = clean.search(MARKER);
  if (at < 0) return { name: clean.replace(/\s+/g, " ").trim(), meta: [] };
  const tail = clean.slice(at);
  const starts = [...tail.matchAll(MARKERS)].map((m) => m.index!);
  const meta = starts.map((s, i) => tail.slice(s, starts[i + 1]).replace(/\s+/g, " ").trim());
  return { name: clean.slice(0, at).replace(/\s+/g, " ").trim(), meta };
}

export function parseTask(text: string): TaskParts {
  const { name, meta } = split(text);
  const priority = PRIORITIES.find((p) => meta.includes(p.emoji))?.value ?? null;
  const due = meta.map((m) => /^📅\s?(\d{4}-\d{2}-\d{2})/u.exec(m)?.[1]).find(Boolean) ?? null;
  return { name, tags: tagsOf(text), pinned: meta.includes(PIN), priority, due };
}

/**
 * The task's text with these parts changed. Markers Wandika doesn't edit (✅ done, ⏳ scheduled,
 * 🔁 repeats, 🛫 start) stay, after the ones it writes, where Obsidian Tasks expects them.
 */
export function composeTask(text: string, change: Partial<Omit<TaskParts, "tags">>): string {
  const now = parseTask(text);
  const next = { ...now, ...change };
  const owned = (m: string) => m === PIN || PRIORITIES.some((p) => p.emoji === m) || m.startsWith("📅");
  const keep = split(text).meta.filter((m) => !owned(m));
  const parts = [next.name.replace(/\s+/g, " ").trim()];
  if (next.pinned) parts.push(PIN);
  const p = PRIORITIES.find((x) => x.value === next.priority);
  if (p) parts.push(p.emoji);
  if (next.due) parts.push(`📅 ${next.due}`);
  return [...parts, ...keep].filter(Boolean).join(" ");
}

/** Lower case without accents, so "cafe" finds "Café". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Whether a task matches a search: every word must appear in the task, its notes or its note's
 * name; a word starting with # must be one of its tags (or a parent tag: #work finds #work/admin).
 */
export function matchesTask(task: { text: string; details?: string; title?: string; path?: string }, query: string): boolean {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const tags = tagsOf(task.text);
  const hay = fold([task.text, task.details ?? "", task.title ?? "", task.path ?? ""].join(" "));
  return words.every((w) => {
    if (w.startsWith("#") && w.length > 1) {
      const t = w.slice(1).toLowerCase();
      return tags.some((tag) => tag === t || tag.startsWith(`${t}/`));
    }
    return hay.includes(fold(w));
  });
}

const RANK: Record<Priority, number> = { highest: 0, high: 1, medium: 2, low: 4, lowest: 5 };

/** Pinned first, then by priority (no priority sits between medium and low, as in Obsidian Tasks), then by due date. */
export function taskOrder(a: string, b: string): number {
  const x = parseTask(a);
  const y = parseTask(b);
  if (x.pinned !== y.pinned) return x.pinned ? -1 : 1;
  const px = x.priority ? RANK[x.priority] : 3;
  const py = y.priority ? RANK[y.priority] : 3;
  if (px !== py) return px - py;
  if (x.due !== y.due) return !x.due ? 1 : !y.due ? -1 : x.due < y.due ? -1 : 1;
  return 0;
}

/** A task line for an email: its subject and a link back to it. */
export function emailTask(subject: string, from: string, url: string | null): string {
  const name = (subject.trim() || "Email").replace(/\s+/g, " ").replace(/[[\]]/g, "");
  const who = from.replace(/\s*<[^>]+>/, "").replace(/["[\]]/g, "").trim();
  if (!url) return who ? `${name} (from ${who})` : name;
  return `${name} [email${who ? ` from ${who}` : ""}](${url})`;
}

/** When a task is due, for the Tasks filters. "week" is today and the six days after it. */
export type Due = "any" | "overdue" | "today" | "week" | "none";

export interface TaskFilters {
  due: Due;
  /** Only tasks marked high or highest priority. */
  high: boolean;
  /** A folder, "Vault" for notes at the vault's top, or "" for every folder. */
  folder: string;
}

export const NO_FILTERS: TaskFilters = { due: "any", high: false, folder: "" };

/** The folder a note sits in, "Vault" for the top of the vault. */
export const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "Vault");

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Whether a task passes every filter that is on. A task in Google Tasks or Reminders has no
 * priority or folder, so it only shows when those filters are off.
 */
export function passesFilters(task: { text: string; due: string | null; path?: string }, f: TaskFilters, today: string): boolean {
  const due = task.due;
  switch (f.due) {
    case "overdue":
      if (!due || due >= today) return false;
      break;
    case "today":
      if (due !== today) return false;
      break;
    case "week":
      if (!due || due < today || due > addDays(today, 6)) return false;
      break;
    case "none":
      if (due) return false;
  }
  if (f.high) {
    const p = parseTask(task.text).priority;
    if (p !== "high" && p !== "highest") return false;
  }
  if (f.folder) {
    if (task.path === undefined) return false;
    const folder = folderOf(task.path);
    if (folder !== f.folder && !folder.startsWith(`${f.folder}/`)) return false;
  }
  return true;
}
