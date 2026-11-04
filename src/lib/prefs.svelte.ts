// Appearance choices, kept per device. Applied as CSS variables on <html>, so every screen and the
// editor follow them without re-rendering.

export type Theme = "system" | "light" | "dark";
export type NoteFont = "serif" | "sans" | "mono";
export type Width = "narrow" | "normal" | "wide" | "full";

/** Accent colours, each tuned for contrast with the paper in both modes. */
export const ACCENTS = [
  { id: "papyrus", label: "Papyrus", light: "#2E6A4E", dark: "#7FC19C" },
  { id: "lake", label: "Lake", light: "#2F5D8A", dark: "#8DB7E0" },
  { id: "indigo", label: "Indigo", light: "#4A4FA3", dark: "#A9ADF0" },
  { id: "plum", label: "Plum", light: "#6E3F72", dark: "#CDA2D1" },
  { id: "rose", label: "Rose", light: "#A23B5A", dark: "#EF9DB5" },
  { id: "graphite", label: "Graphite", light: "#3A4540", dark: "#C9D0CB" },
] as const;

export const FONTS: Record<NoteFont, { label: string; css: string }> = {
  serif: { label: "Serif", css: '"Literata Variable", Literata, Georgia, serif' },
  sans: { label: "Sans", css: "var(--font-ui)" },
  mono: { label: "Mono", css: "var(--font-code)" },
};

export const WIDTHS: Record<Width, { label: string; css: string }> = {
  narrow: { label: "Narrow", css: "60ch" },
  normal: { label: "Normal", css: "68ch" },
  wide: { label: "Wide", css: "88ch" },
  full: { label: "Full", css: "none" },
};

export interface Prefs {
  theme: Theme;
  accent: string;
  font: NoteFont;
  /** Note text size in px; null keeps the platform default (18 on Mac, 17 on phones). */
  size: number | null;
  width: Width;
  /** Vim keys in the editor (Mac, or a keyboard with a pointer). */
  vim: boolean;
  /** Line numbers beside the note. */
  lineNumbers: boolean;
}

const KEY = "wandika.appearance";
const DEFAULTS: Prefs = { theme: "system", accent: "papyrus", font: "serif", size: null, width: "normal", vim: false, lineNumbers: false };
/** The note size slider's range in Settings. */
const SIZES = { min: 14, max: 24 };

/** Saved choices, each checked: one that is missing, unknown or damaged falls back to its default. */
function load(): Prefs {
  let s: Record<string, unknown> = {};
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (saved && typeof saved === "object") s = saved as Record<string, unknown>;
  } catch {
    // Unreadable: every choice takes its default.
  }
  const one = <T extends string>(v: unknown, allowed: readonly T[], fallback: T) => (allowed.includes(v as T) ? (v as T) : fallback);
  return {
    theme: one(s.theme, ["system", "light", "dark"], DEFAULTS.theme),
    accent: one(s.accent, ACCENTS.map((a) => a.id), DEFAULTS.accent),
    font: one(s.font, Object.keys(FONTS) as NoteFont[], DEFAULTS.font),
    size: typeof s.size === "number" && s.size > 0 && Number.isFinite(s.size) ? Math.min(SIZES.max, Math.max(SIZES.min, Math.round(s.size))) : null,
    width: one(s.width, Object.keys(WIDTHS) as Width[], DEFAULTS.width),
    vim: s.vim === true,
    lineNumbers: s.lineNumbers === true,
  };
}

class PrefsState {
  value = $state<Prefs>(load());
  /** The system's light or dark setting, kept current so screens showing `mode` follow it. */
  #systemDark = $state(false);

  constructor() {
    if (typeof matchMedia === "undefined") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    this.#systemDark = media.matches;
    media.addEventListener("change", (e) => {
      this.#systemDark = e.matches;
      if (this.value.theme === "system") this.apply();
    });
  }

  get mode(): "light" | "dark" {
    if (this.value.theme !== "system") return this.value.theme;
    return this.#systemDark ? "dark" : "light";
  }

  set(patch: Partial<Prefs>) {
    this.value = { ...this.value, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      /* private mode: the choice lasts until the app closes */
    }
    this.apply();
  }

  reset() {
    this.set({ ...DEFAULTS });
  }

  /** Writes the choices onto <html>. Safe to call often. */
  apply() {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const mode = this.mode;
    root.dataset.mode = mode;
    const accent = ACCENTS.find((a) => a.id === this.value.accent) ?? ACCENTS[0];
    const color = mode === "dark" ? accent.dark : accent.light;
    root.style.setProperty("--papyrus", color);
    root.style.setProperty("--papyrus-wash", color + (mode === "dark" ? "1f" : "14"));
    root.style.setProperty("--font-note", FONTS[this.value.font].css);
    root.style.setProperty("--measure", WIDTHS[this.value.width].css);
    if (this.value.size) root.style.setProperty("--note-size", `calc(${this.value.size}px * var(--text-scale))`);
    else root.style.removeProperty("--note-size");
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = mode === "dark" ? "#151917" : "#F2F3EF";
    }
    // Android's status and navigation bar icons follow the page (see MainActivity.kt).
    (window as { WandikaAndroid?: { setDark(dark: boolean): void } }).WandikaAndroid?.setDark(mode === "dark");
    // Native menus and dialogs follow too.
    if ("__TAURI_INTERNALS__" in window) {
      const theme = this.value.theme === "system" ? null : this.value.theme;
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme)).catch(() => {});
    }
    // Canvas views (the graph) read colours once; tell them to read again.
    window.dispatchEvent(new Event("wandika:theme"));
  }
}

export const prefs = new PrefsState();
