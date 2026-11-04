// Vim keys, from @replit/codemirror-vim. The package loads only once Vim is turned on in Settings,
// so the editor starts as fast without it.

import { Compartment, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import { app } from "../app.svelte";

export const vimSlot = new Compartment();
let current: Extension = [];

/** What a new note's editor starts with: Vim if it's on and loaded, nothing otherwise. */
export const vimNow = () => current;

let loading: Promise<Extension> | null = null;

/** Loads Vim the first time it's needed. `:w` saves the note, as it would a file. */
function load(save: () => void): Promise<Extension> {
  loading ??= import("@replit/codemirror-vim").then(({ vim, Vim, getCM }) => {
    Vim.defineEx("write", "w", () => save());
    // The mode shows in the window's status bar, not in a line inside the note.
    const mode = ViewPlugin.define((view) => {
      const cm = getCM(view);
      const changed = (e: { mode: string; subMode?: string }) =>
        (app.vimMode = e.subMode ? `${e.mode} ${e.subMode === "linewise" ? "line" : "block"}` : e.mode);
      cm?.on("vim-mode-change", changed);
      app.vimMode = "normal";
      return {
        destroy() {
          cm?.off("vim-mode-change", changed);
          app.vimMode = null;
        },
      };
    });
    return [vim({ status: false }), mode];
  });
  return loading;
}

/** Turns Vim keys on or off in `view` and in every note opened after. */
export async function setVim(view: () => EditorView | null, on: boolean, save: () => void) {
  current = on ? await load(save) : [];
  if (!on) app.vimMode = null;
  // The note on screen when loading ends, which may not be the one open when it began.
  view()?.dispatch({ effects: vimSlot.reconfigure(current) });
}
