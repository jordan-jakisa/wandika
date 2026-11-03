// Shared set-up for the tests of the workspace screens (Workspace, Settings, Editor, FileTree,
// Search, Start, Unlock, GitHubSignIn, RepoPicker and the routes). jsdom has no layout, no modal
// dialogs and no media queries; these stand-ins give the components what they ask for.

import { vi } from "vitest";
import { app } from "../lib/app.svelte";
import type { Status, VaultConfig } from "../lib/types";

// <dialog>: jsdom has the element but not showModal or close.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.show = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

// Media queries: a desktop with a mouse, in light mode.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

// CodeMirror measures text through ranges; jsdom has the methods only on elements.
if (typeof Range !== "undefined") {
  const empty = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] };
  Range.prototype.getClientRects ??= () => empty as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
}

if (typeof window !== "undefined" && !("ResizeObserver" in window)) {
  (window as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/** Sets the window width the screens read, and tells them it changed. */
export function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: px });
  window.dispatchEvent(new Event("resize"));
}

export const githubVault: VaultConfig = {
  id: "github/jordan-jakisa/notes",
  name: "notes",
  folder: null,
  remote: { owner: "jordan-jakisa", repo: "notes", branch: "main" },
};

export const localVault: VaultConfig = { id: "local/1", name: "Notes", folder: null, remote: null };

/** A status as the Rust core reports it; `patch` changes what a test needs. */
export function status(patch: Partial<Status> = {}): Status {
  return {
    configured: { github: true, google: true, microsoft: true, apple: true },
    user: { login: "jordan-jakisa", name: "Jordan", avatar_url: "" },
    vault: localVault,
    known: [localVault],
    last_sync: null,
    encryption: { set_up: true, unlocked: true, folders: ["Private"] },
    connectors: { google: null, microsoft: null, apple_calendar: "not_asked", apple_reminders: "not_asked" },
    ...patch,
  };
}

/** Puts the shared app state back as it is when the app starts, so tests don't leak into each other. */
export function resetApp() {
  vi.restoreAllMocks();
  app.dialog?.resolve(null);
  app.stopAutoSync();
  Object.assign(app, {
    status: null,
    bootError: null,
    tree: [],
    titles: [],
    current: null,
    tab: "notes",
    showToday: true,
    switcherOpen: false,
    viewing: null,
    settingsOpen: false,
    settingsSection: "vault",
    settingsDirect: false,
    syncing: false,
    syncError: null,
    lastSync: null,
    syncProgress: null,
    conflicts: [],
    tooBig: [],
    heldDeletions: [],
    vaultBytes: 0,
    toast: null,
    toastAction: null,
    dialog: null,
    tagFilter: null,
    today: null,
    snippets: [],
  });
  try {
    localStorage.clear();
  } catch {
    // Nothing stored.
  }
}

/** Answers the in-app dialog (app.ask) as if the person pressed its confirm button. */
export function confirmDialog(value = "") {
  const d = app.dialog;
  if (!d) throw new Error("No dialog is open");
  d.resolve(value);
}
