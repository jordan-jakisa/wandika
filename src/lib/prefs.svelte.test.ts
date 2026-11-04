import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { storageFull } from "../test/lib";

const KEY = "wandika.appearance";
const DEFAULTS = { theme: "system", accent: "papyrus", font: "serif", size: null, width: "normal", vim: false };

/** jsdom has no matchMedia: a stand-in whose dark setting a test can flip. */
function system(dark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const media = {
    matches: dark,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
  };
  vi.stubGlobal("matchMedia", () => media);
  return {
    set(next: boolean) {
      media.matches = next;
      for (const fn of listeners) fn({ matches: next });
    },
  };
}

/** Fresh prefs loaded from what is in storage now. */
async function fresh() {
  vi.resetModules();
  return import("./prefs.svelte");
}

const root = document.documentElement;
const css = (name: string) => root.style.getPropertyValue(name);

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("style");
  delete root.dataset.mode;
  system(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  delete (window as { WandikaAndroid?: unknown }).WandikaAndroid;
});

describe("loading", () => {
  test("nothing saved gives the defaults", async () => {
    const { prefs } = await fresh();
    expect(prefs.value).toEqual(DEFAULTS);
  });

  test("saved choices come back", async () => {
    const saved = { theme: "dark", accent: "plum", font: "mono", size: 20, width: "wide", vim: true };
    localStorage.setItem(KEY, JSON.stringify(saved));
    const { prefs } = await fresh();
    expect(prefs.value).toEqual(saved);
  });

  test("a choice saved before it existed takes its default", async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "dark" }));
    const { prefs } = await fresh();
    expect(prefs.value).toEqual({ ...DEFAULTS, theme: "dark" });
  });

  test("unknown or damaged values fall back one by one", async () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: "purple", accent: "neon", font: "comic", size: "big", width: "huge" }));
    const { prefs } = await fresh();
    expect(prefs.value).toEqual(DEFAULTS);
    // Applying them must not throw either.
    expect(() => prefs.apply()).not.toThrow();
  });

  test("a size outside the slider is brought within it", async () => {
    for (const [saved, loaded] of [
      [500, 24],
      [3, 14],
      [17.6, 18],
      [0, null],
      [-4, null],
      [null, null],
    ]) {
      localStorage.setItem(KEY, JSON.stringify({ size: saved }));
      const { prefs } = await fresh();
      expect(prefs.value.size, String(saved)).toBe(loaded);
    }
  });

  test.each([["not json"], ["null"], ["5"], ['"dark"'], ["[1,2]"]])("damaged storage (%s) gives the defaults", async (raw) => {
    localStorage.setItem(KEY, raw);
    const { prefs } = await fresh();
    expect(prefs.value).toEqual(DEFAULTS);
  });
});

describe("choosing", () => {
  test("a change is saved and applied", async () => {
    const { prefs } = await fresh();
    prefs.set({ theme: "dark", accent: "lake" });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toMatchObject({ theme: "dark", accent: "lake", font: "serif" });
    expect(root.dataset.mode).toBe("dark");
    expect(css("--papyrus")).toBe("#8DB7E0");
  });

  test("reset goes back to the defaults", async () => {
    const { prefs } = await fresh();
    prefs.set({ theme: "light", font: "sans", size: 22, width: "full" });
    prefs.reset();
    expect(prefs.value).toEqual(DEFAULTS);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(DEFAULTS);
  });

  test("storage that refuses writes keeps the choice for now", async () => {
    const { prefs } = await fresh();
    storageFull();
    expect(() => prefs.set({ theme: "dark" })).not.toThrow();
    expect(prefs.value.theme).toBe("dark");
    expect(root.dataset.mode).toBe("dark");
  });
});

describe("mode", () => {
  test("a set theme wins over the system", async () => {
    system(true);
    const { prefs } = await fresh();
    prefs.set({ theme: "light" });
    expect(prefs.mode).toBe("light");
    prefs.set({ theme: "dark" });
    expect(prefs.mode).toBe("dark");
  });

  test("system follows the device, even before anything is applied", async () => {
    system(true);
    const { prefs } = await fresh();
    expect(prefs.mode).toBe("dark");
  });

  test("a change on the device is followed while the theme is system", async () => {
    const device = system(false);
    const { prefs } = await fresh();
    prefs.apply();
    expect(root.dataset.mode).toBe("light");
    device.set(true);
    expect(prefs.mode).toBe("dark");
    expect(root.dataset.mode).toBe("dark");
  });

  test("a change on the device leaves a set theme alone", async () => {
    const device = system(false);
    const { prefs } = await fresh();
    prefs.set({ theme: "light" });
    device.set(true);
    expect(root.dataset.mode).toBe("light");
  });

  test("without matchMedia it is light", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const { prefs } = await fresh();
    expect(prefs.mode).toBe("light");
  });
});

describe("apply", () => {
  test("writes every choice onto the page", async () => {
    const { prefs, FONTS, WIDTHS } = await fresh();
    prefs.set({ theme: "light", accent: "rose", font: "mono", size: 20, width: "wide" });
    expect(root.dataset.mode).toBe("light");
    expect(css("--papyrus")).toBe("#A23B5A");
    expect(css("--papyrus-wash")).toBe("#A23B5A14");
    expect(css("--font-note")).toBe(FONTS.mono.css);
    expect(css("--measure")).toBe(WIDTHS.wide.css);
    expect(css("--note-size")).toBe("calc(20px * var(--text-scale))");
  });

  test("the default size leaves the platform's own", async () => {
    const { prefs } = await fresh();
    prefs.set({ size: 20 });
    prefs.set({ size: null });
    expect(css("--note-size")).toBe("");
  });

  test("dark mode uses the dark accent and a stronger wash", async () => {
    const { prefs } = await fresh();
    prefs.set({ theme: "dark", accent: "papyrus" });
    expect(css("--papyrus")).toBe("#7FC19C");
    expect(css("--papyrus-wash")).toBe("#7FC19C1f");
  });

  test("the browser bar colour follows the mode", async () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    const { prefs } = await fresh();
    prefs.set({ theme: "dark" });
    expect(meta.content).toBe("#151917");
    prefs.set({ theme: "light" });
    expect(meta.content).toBe("#F2F3EF");
  });

  test("Android's system bars are told the mode", async () => {
    const setDark = vi.fn();
    (window as { WandikaAndroid?: unknown }).WandikaAndroid = { setDark };
    const { prefs } = await fresh();
    prefs.set({ theme: "dark" });
    expect(setDark).toHaveBeenLastCalledWith(true);
    prefs.set({ theme: "light" });
    expect(setDark).toHaveBeenLastCalledWith(false);
  });

  test("canvas views are told to read the colours again", async () => {
    const { prefs } = await fresh();
    const heard = vi.fn();
    window.addEventListener("wandika:theme", heard);
    prefs.apply();
    window.removeEventListener("wandika:theme", heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("choices on offer", () => {
  test("every accent has a light and a dark colour", async () => {
    const { ACCENTS } = await fresh();
    expect(ACCENTS[0].id).toBe("papyrus");
    expect(new Set(ACCENTS.map((a) => a.id)).size).toBe(ACCENTS.length);
    for (const a of ACCENTS) {
      expect(a.light).toMatch(/^#[0-9A-F]{6}$/);
      expect(a.dark).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  test("every font and width has a label and a CSS value", async () => {
    const { FONTS, WIDTHS } = await fresh();
    expect(Object.keys(FONTS)).toEqual(["serif", "sans", "mono"]);
    expect(Object.keys(WIDTHS)).toEqual(["narrow", "normal", "wide", "full"]);
    for (const v of [...Object.values(FONTS), ...Object.values(WIDTHS)]) {
      expect(v.label).toBeTruthy();
      expect(v.css).toBeTruthy();
    }
  });
});
