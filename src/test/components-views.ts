// Shared set-up for the view component tests (Board, Today, Tasks, Graph, Dialog, Menu …): the
// browser features jsdom lacks, a clean app state per test, and fixtures in the app's own shapes.
// Importing this file installs the stubs; each test calls `resetApp()` in beforeEach.

import { vi } from "vitest";
import { app } from "../lib/app.svelte";
import { clock } from "../lib/clock.svelte";
import type { NoteMeta, Status, Today, VaultTask } from "../lib/types";

/** Media queries the page asks for; set an entry to true to make that query match. */
export const media: Record<string, boolean> = {};

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: !!media[query],
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

/** A ResizeObserver that reports once, as soon as it starts watching, like the browser's first callback. */
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      this.cb([{ target: el } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
}

// CodeMirror measures text through Range rectangles, which jsdom leaves out.
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

/** Drag events with a position and a data transfer, which jsdom doesn't have. */
if (!("DragEvent" in window)) {
  class DragEvent extends MouseEvent {
    dataTransfer: DataTransfer | null;
    constructor(type: string, init: DragEventInit = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  }
  (window as unknown as { DragEvent: typeof DragEvent }).DragEvent = DragEvent;
}

/** A plain DataTransfer stand-in for drag tests. */
export function dataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "all",
    dropEffect: "none",
    setData: (k: string, v: string) => void data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
  } as unknown as DataTransfer;
}

// Modal <dialog>: jsdom has the element but not showModal() or close(). This follows the
// browser: Escape fires a cancelable "cancel", then closes; close() fires "close".
const proto = HTMLDialogElement.prototype as HTMLDialogElement & { __stubbed?: boolean };
if (!proto.showModal) {
  proto.__stubbed = true;
  proto.show = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
    this.dataset.modal = "";
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    delete this.dataset.modal;
    this.dispatchEvent(new Event("close"));
  };
  if (!Object.getOwnPropertyDescriptor(proto, "open")?.get) {
    Object.defineProperty(proto, "open", {
      get(this: HTMLDialogElement) {
        return this.hasAttribute("open");
      },
      set(this: HTMLDialogElement, v: boolean) {
        this.toggleAttribute("open", v);
      },
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const top = [...document.querySelectorAll<HTMLDialogElement>("dialog[data-modal]")].pop();
    if (!top) return;
    const cancel = new Event("cancel", { cancelable: true });
    top.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) top.close();
  });
}

/** A modal dialog is open (showModal, not show). */
export const isModal = (el: HTMLElement) => el.hasAttribute("open") && "modal" in (el as HTMLElement).dataset;

/** What a canvas was asked to draw: dots and labels in screen pixels, and the last transform. */
export interface Drawing {
  dots: { x: number; y: number; r: number; alpha: number; fill: string }[];
  labels: { text: string; x: number; y: number; alpha: number }[];
  view: { x: number; y: number; k: number };
}

/**
 * A 2D context that records each frame (jsdom has no canvas). `frames` holds every finished
 * frame, the newest last; a frame starts at clearRect.
 */
export function recordCanvas() {
  const frames: Drawing[] = [];
  let cur: Drawing = { dots: [], labels: [], view: { x: 0, y: 0, k: 1 } };
  const ctx: Record<string, unknown> & { globalAlpha: number; fillStyle: string } = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    lineJoin: "",
    setTransform: () => {},
    clearRect: () => {
      cur = { dots: [], labels: [], view: { x: 0, y: 0, k: 1 } };
      frames.push(cur);
    },
    translate: (x: number, y: number) => {
      cur.view.x += x;
      cur.view.y += y;
    },
    scale: (k: number) => {
      cur.view.k *= k;
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    arc: (x: number, y: number, r: number) => {
      pending = { x, y, r };
    },
    fill: () => {
      if (!pending) return;
      const { x, y, r } = pending;
      const { view } = cur;
      cur.dots.push({ x: view.x + x * view.k, y: view.y + y * view.k, r: r * view.k, alpha: ctx.globalAlpha, fill: ctx.fillStyle });
      pending = null;
    },
    strokeText: () => {},
    fillText: (text: string, x: number, y: number) => {
      const { view } = cur;
      cur.labels.push({ text, x: view.x + x * view.k, y: view.y + y * view.k, alpha: ctx.globalAlpha });
    },
  };
  let pending: { x: number; y: number; r: number } | null = null;
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
  return {
    frames,
    /** The newest frame that drew anything. */
    get last(): Drawing {
      return [...frames].reverse().find((f) => f.dots.length || f.labels.length) ?? cur;
    },
    restore: () => spy.mockRestore(),
  };
}

export const statusFixture = (over: Partial<Status> = {}): Status => ({
  configured: { github: true, google: true, microsoft: true, apple: true },
  user: { login: "jordan-jakisa", name: "Jordan", avatar_url: "" },
  vault: { id: "github/jordan-jakisa/notes", name: "notes", folder: null, remote: { owner: "jordan-jakisa", repo: "notes", branch: "main" } },
  known: [],
  last_sync: null,
  encryption: null,
  connectors: { google: null, microsoft: null, apple_calendar: "not_asked", apple_reminders: "not_asked" },
  ...over,
});

export const localStatus = () =>
  statusFixture({ vault: { id: "local/1", name: "Notes", folder: null, remote: null } });

export const note = (path: string, over: Partial<NoteMeta> = {}): NoteMeta => ({
  path,
  title: path.split("/").pop()!.replace(/\.md$/, ""),
  links: [],
  tags: [],
  encrypted: false,
  locked: false,
  board: false,
  modified: 0,
  ...over,
});

export const task = (path: string, line: number, text: string, over: Partial<VaultTask> = {}): VaultTask => ({
  path,
  title: path.split("/").pop()!.replace(/\.md$/, ""),
  line,
  text,
  done: false,
  due: null,
  ...over,
});

export const todayFixture = (over: Partial<Today> = {}): Today => ({
  events: [],
  mail: [],
  tasks: [],
  remote_tasks: [],
  errors: {},
  ...over,
});

/** A fixed "today" so due dates read the same on any day the tests run. */
export const TODAY = "2026-11-03";

/** Puts the shared app state back to a fresh start and the clock on TODAY. */
export function resetApp() {
  app.dialog?.resolve(null);
  Object.assign(app, {
    status: null,
    tree: [],
    titles: [],
    current: null,
    tab: "notes",
    viewing: null,
    syncing: false,
    syncError: null,
    lastSync: null,
    syncProgress: null,
    conflicts: [],
    changed: { paths: [], at: 0 },
    toast: null,
    toastAction: null,
    dialog: null,
    tagFilter: null,
    graphFocus: null,
    graphLocal: false,
    today: null,
    settingsOpen: false,
    settingsSection: "vault",
    settingsDirect: false,
    noteStats: { words: 0, chars: 0, cards: null, backlinks: 0, encrypted: false },
  });
  clock.today = TODAY;
  for (const k of Object.keys(media)) delete media[k];
  try {
    localStorage.clear();
  } catch {
    // Nothing stored, nothing to clear.
  }
}
