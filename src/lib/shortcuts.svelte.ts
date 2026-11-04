// Every keyboard shortcut in one table, and the ones you changed in Settings, Shortcuts (kept on
// this device). Bindings are written as CodeMirror writes them: "Mod-Shift-p", "Alt-Mod-n", "F6",
// where Mod is ⌘ on a Mac and Ctrl elsewhere. The app's keys, the note's and the editor's all
// read from here when a key is pressed, so a change works at once.

export type ShortcutGroup = "App" | "Note" | "Editing";

export interface ShortcutDef {
  id: string;
  label: string;
  group: ShortcutGroup;
  keys: string[];
}

export const CATALOG: ShortcutDef[] = [
  { id: "palette", label: "Every command", group: "App", keys: ["Mod-Shift-p"] },
  { id: "search", label: "Search or create a note", group: "App", keys: ["Mod-k", "Mod-o"] },
  { id: "new-note", label: "New note", group: "App", keys: ["Mod-n"] },
  { id: "new-voice", label: "New voice note", group: "App", keys: ["Alt-Mod-n"] },
  { id: "new-task", label: "New task", group: "App", keys: [] },
  { id: "new-drawing", label: "New drawing", group: "App", keys: [] },
  { id: "daily", label: "Today's note", group: "App", keys: ["Mod-d"] },
  { id: "tasks", label: "Go to Tasks", group: "App", keys: [] },
  { id: "projects", label: "Go to Projects", group: "App", keys: [] },
  { id: "graph", label: "Go to Graph", group: "App", keys: [] },
  { id: "sync", label: "Sync now", group: "App", keys: ["Mod-s"] },
  { id: "settings", label: "Settings", group: "App", keys: ["Mod-,"] },
  { id: "sidebar", label: "Show or hide the sidebar", group: "App", keys: ["Mod-\\"] },
  { id: "today-panel", label: "Show or hide Today", group: "App", keys: ["Alt-Mod-t"] },
  { id: "back", label: "Back", group: "App", keys: ["Mod-["] },
  { id: "forward", label: "Forward", group: "App", keys: ["Mod-]"] },
  { id: "focus-tree", label: "Go to the file list", group: "App", keys: ["Mod-1"] },
  { id: "focus-note", label: "Go to the note", group: "App", keys: ["Mod-2"] },
  { id: "focus-today", label: "Go to Today", group: "App", keys: ["Mod-3"] },
  { id: "cycle", label: "Next of the file list, the note and Today", group: "App", keys: ["F6"] },
  { id: "cycle-back", label: "Previous of the file list, the note and Today", group: "App", keys: ["Shift-F6"] },
  { id: "pdf", label: "Export the note as a PDF", group: "Note", keys: ["Mod-p"] },
  { id: "voice-here", label: "Voice note into this note", group: "Note", keys: [] },
  { id: "bold", label: "Bold", group: "Editing", keys: ["Mod-b"] },
  { id: "italic", label: "Italic", group: "Editing", keys: ["Mod-i"] },
  { id: "checklist", label: "Checklist", group: "Editing", keys: ["Mod-l"] },
  { id: "bullets", label: "Bulleted list", group: "Editing", keys: ["Mod-Shift-8"] },
  { id: "numbers", label: "Numbered list", group: "Editing", keys: ["Mod-Shift-7"] },
  { id: "follow", label: "Open the link under the cursor", group: "Editing", keys: ["Mod-Enter"] },
  { id: "item-up", label: "Move the line or list item up", group: "Editing", keys: ["Alt-ArrowUp"] },
  { id: "item-down", label: "Move the line or list item down", group: "Editing", keys: ["Alt-ArrowDown"] },
];

const KEY = "wandika.shortcuts";
const byId = new Map(CATALOG.map((d) => [d.id, d]));

function load(): Record<string, string[]> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const out: Record<string, string[]> = {};
    for (const [id, keys] of Object.entries(saved as Record<string, unknown>)) {
      if (byId.has(id) && Array.isArray(keys) && keys.every((k) => typeof k === "string")) out[id] = keys as string[];
    }
    return out;
  } catch {
    return {};
  }
}

class Shortcuts {
  /** Only the changed ones; everything else keeps its default. */
  changed = $state<Record<string, string[]>>(load());

  keysOf(id: string): string[] {
    return this.changed[id] ?? byId.get(id)?.keys ?? [];
  }

  isChanged(id: string) {
    return id in this.changed;
  }

  /** Gives `id` these keys. A key another shortcut had moves here; returns who lost it. */
  set(id: string, keys: string[]): string[] {
    const taken: string[] = [];
    const next = { ...this.changed };
    for (const def of CATALOG) {
      if (def.id === id) continue;
      const own = next[def.id] ?? def.keys;
      const kept = own.filter((k) => !keys.some((n) => same(n, k)));
      if (kept.length !== own.length) {
        next[def.id] = kept;
        taken.push(def.label);
      }
    }
    next[id] = keys;
    // A shortcut back to its default is no longer a change.
    for (const def of CATALOG) if (next[def.id] && sameList(next[def.id], def.keys)) delete next[def.id];
    this.changed = next;
    this.#save();
    return taken;
  }

  reset(id?: string) {
    if (id) {
      const { [id]: _, ...rest } = this.changed;
      this.changed = rest;
    } else this.changed = {};
    this.#save();
  }

  /** The shortcut a key press is, among `groups`, or null. */
  match(e: KeyboardEvent, groups: ShortcutGroup[]): string | null {
    const pressed = fromEvent(e);
    if (!pressed) return null;
    for (const def of CATALOG) {
      if (!groups.includes(def.group)) continue;
      if (this.keysOf(def.id).some((k) => same(k, pressed))) return def.id;
    }
    return null;
  }

  #save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.changed));
    } catch {
      /* private mode: the change lasts until the app closes */
    }
  }
}

export const shortcuts = new Shortcuts();

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The key itself, by where it sits on the keyboard, so ⇧8 is "8" and ⌥N is "n" on a Mac too. */
const CODES: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Escape: "Escape",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

function baseOf(e: KeyboardEvent): string | null {
  const code = e.code ?? "";
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  if (CODES[code]) return CODES[code];
  if (/^F\d{1,2}$/.test(e.key)) return e.key;
  // No code: the key's number says which letter or digit it is, with or without Shift.
  if (e.keyCode >= 48 && e.keyCode <= 57) return String(e.keyCode - 48);
  if (e.keyCode >= 65 && e.keyCode <= 90) return String.fromCharCode(e.keyCode + 32);
  // No code (some test and remote keyboards): the character typed.
  if (e.key && e.key.length === 1) return e.key.toLowerCase();
  return CODES[e.key] ?? null;
}

interface Parsed {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  base: string;
}

/** "Alt-Mod-n" as modifiers and a key. A "-" key is written "Mod--". */
function parse(binding: string): Parsed {
  const parts = binding.split(/-(?!$)/);
  const base = parts.pop()!;
  const p: Parsed = { alt: false, ctrl: false, meta: false, shift: false, base: base.length === 1 ? base.toLowerCase() : base };
  for (const m of parts) {
    if (m === "Alt") p.alt = true;
    else if (m === "Shift") p.shift = true;
    else if (m === "Ctrl") p.ctrl = true;
    else if (m === "Meta" || m === "Cmd") p.meta = true;
    else if (m === "Mod") mac ? (p.meta = true) : (p.ctrl = true);
  }
  return p;
}

const same = (a: string, b: string) => {
  const x = parse(a);
  const y = parse(b);
  return x.alt === y.alt && x.ctrl === y.ctrl && x.meta === y.meta && x.shift === y.shift && x.base === y.base;
};
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.some((m) => same(k, m)));

/** A key press as a binding, or null for a lone modifier. */
export function fromEvent(e: KeyboardEvent): string | null {
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return null;
  const base = baseOf(e);
  if (!base) return null;
  const mods: string[] = [];
  if (e.altKey) mods.push("Alt");
  if (mac && e.ctrlKey) mods.push("Ctrl");
  // Off a Mac the Windows or Command key of an attached keyboard counts as Ctrl.
  if (mac ? e.metaKey : e.ctrlKey || e.metaKey) mods.push("Mod");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, base].join("-");
}

/** Whether a key press can be a shortcut: it needs ⌘, ⌃ or ⌥, unless it's a function key. */
export function usable(binding: string) {
  const p = parse(binding);
  return /^F\d{1,2}$/.test(p.base) || p.meta || p.ctrl || p.alt;
}

const NAMES: Record<string, string> = {
  Enter: "Return",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "Esc",
  Space: "Space",
  Tab: "Tab",
};

/** How a binding reads: "⌥⌘N" on a Mac, "Ctrl+Alt+N" elsewhere. */
export function display(binding: string): string {
  const p = parse(binding);
  const key = NAMES[p.base] ?? (p.base.length === 1 ? p.base.toUpperCase() : p.base);
  if (mac) return `${p.ctrl ? "⌃" : ""}${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""}${p.meta ? "⌘" : ""}${key}`;
  return [p.ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", p.meta && "Win", key].filter(Boolean).join("+");
}

/** A CodeMirror key binding that runs `commands[id]` for whichever editing shortcut is pressed,
 *  read from the table at each key press, so a change in Settings works in an open note. */
export function editingKeys<V>(commands: Record<string, (view: V) => boolean>) {
  return {
    any(view: V, e: KeyboardEvent) {
      const id = shortcuts.match(e, ["Editing"]);
      const run = id ? commands[id] : undefined;
      return run ? run(view) : false;
    },
  };
}

/** All of a shortcut's keys, as the palette and Settings show them: "⌘K or ⌘O". */
export const shownKeys = (id: string) => shortcuts.keysOf(id).map(display).join(" or ");
