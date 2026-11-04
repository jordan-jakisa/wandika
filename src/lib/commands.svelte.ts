// Every action in one list, for the command palette (⌘⇧P, or ">" in ⌘K): so the whole app works
// from the keyboard. Screens add their own while they're on screen (the open note adds Export as
// PDF, the workspace adds the sidebar and focus moves) and take them away when they leave.

import { app } from "./app.svelte";
import { fold } from "./fold";
import { prefs } from "./prefs.svelte";

export interface Command {
  id: string;
  label: string;
  /** The shortcut, as the About list writes it: "⌘N", "⌥⌘T". */
  keys?: string;
  run: () => void | Promise<unknown>;
  /** Shown only while this holds (a note is open, sync is set up). */
  when?: () => boolean;
}

const sources = $state<Record<string, Command[]>>({});

/** Adds a screen's commands; the returned function takes them away again. */
export function registerCommands(source: string, commands: Command[]) {
  sources[source] = commands;
  return () => {
    delete sources[source];
  };
}

/** What the app can always do. */
const core: Command[] = [
  { id: "new-note", label: "New note", keys: "⌘N", run: () => app.newNote() },
  { id: "new-voice", label: "New voice note", keys: "⌥⌘N", run: () => app.newVoiceNote() },
  { id: "new-task", label: "New task", run: () => app.newTask() },
  { id: "new-drawing", label: "New drawing", run: () => app.newDrawing() },
  { id: "new-board", label: "New board", run: () => app.newBoard() },
  { id: "new-folder", label: "New folder", run: () => app.newFolder() },
  { id: "daily", label: "Open today's note", keys: "⌘D", run: () => app.openDaily() },
  { id: "search", label: "Search notes", keys: "⌘K", run: () => (app.switcherOpen = true) },
  { id: "tasks", label: "Go to Tasks", run: () => app.showTasks() },
  {
    id: "projects",
    label: "Go to Projects",
    run: () => {
      app.current = null;
      app.tab = "projects";
    },
  },
  { id: "graph", label: "Go to Graph", run: () => app.showGraph() },
  { id: "back", label: "Back", keys: "⌘[", run: () => app.goBack() },
  { id: "forward", label: "Forward", keys: "⌘]", run: () => app.goForward() },
  { id: "today-panel", label: "Show or hide Today", keys: "⌥⌘T", run: () => (app.showToday = !app.showToday) },
  { id: "today-full", label: "Today full screen", run: () => (app.todayFull = !app.todayFull) },
  { id: "sync", label: "Sync now", keys: "⌘S", run: () => app.sync(true), when: () => !!app.synced },
  { id: "settings", label: "Settings", keys: "⌘,", run: () => app.openSettings() },
  { id: "shortcuts", label: "Keyboard shortcuts", run: () => app.openSettings("about") },
  {
    id: "vim",
    label: "Turn Vim keys on or off",
    run: () => {
      prefs.set({ vim: !prefs.value.vim });
      app.say(prefs.value.vim ? "Vim keys are on." : "Vim keys are off.");
    },
  },
];

/** Commands that fit now, best match first: every typed word starts a word of the name. */
export function matchCommands(query: string): Command[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const all = [...Object.values(sources).flat(), ...core].filter((c) => !c.when || c.when());
  const seen = new Set<string>();
  return all
    .filter((c) => !seen.has(c.id) && seen.add(c.id))
    .filter((c) => {
      const names = fold(c.label).split(/[\s']+/);
      return words.every((w) => names.some((n) => n.startsWith(w)));
    })
    .sort((a, b) => Number(!fold(a.label).startsWith(words[0] ?? "")) - Number(!fold(b.label).startsWith(words[0] ?? "")));
}
