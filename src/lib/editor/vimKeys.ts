// Vim keys, from @replit/codemirror-vim. The package loads only once Vim is turned on in Settings,
// so the editor starts as fast without it.

import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export const vimSlot = new Compartment();
let current: Extension = [];

/** What a new note's editor starts with: Vim if it's on and loaded, nothing otherwise. */
export const vimNow = () => current;

let loading: Promise<Extension> | null = null;

/** Loads Vim the first time it's needed. `:w` saves the note, as it would a file. */
function load(save: () => void): Promise<Extension> {
  loading ??= import("@replit/codemirror-vim").then(({ vim, Vim }) => {
    Vim.defineEx("write", "w", () => save());
    return vim({ status: true });
  });
  return loading;
}

/** Turns Vim keys on or off in `view` and in every note opened after. */
export async function setVim(view: () => EditorView | null, on: boolean, save: () => void) {
  current = on ? await load(save) : [];
  // The note on screen when loading ends, which may not be the one open when it began.
  view()?.dispatch({ effects: vimSlot.reconfigure(current) });
}
