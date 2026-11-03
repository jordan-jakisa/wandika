// Commands for the phone's writing toolbar. Each keeps the cursor where the next keystroke belongs,
// so the keyboard stays up and typing carries on.

import { startCompletion } from "@codemirror/autocomplete";
import { indentLess, indentMore, redo, undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { setLines } from "./format";
import { cycleHeading, type LineKind } from "./lists";

/** Inserts `before` and `after` around the selection, cursor in between, then offers completions. */
function surround(view: EditorView, before: string, after: string, complete: boolean) {
  view.dispatch(
    view.state.changeByRange((r) => ({
      changes: [
        { from: r.from, insert: before },
        { from: r.to, insert: after },
      ],
      range: r.empty ? EditorSelection.cursor(r.from + before.length) : EditorSelection.range(r.from + before.length, r.to + before.length),
    })),
  );
  view.focus();
  if (complete) startCompletion(view);
  return true;
}

export const link = (view: EditorView) => surround(view, "[[", "]]", true);

export function tag(view: EditorView) {
  const { from } = view.state.selection.main;
  const prev = from > 0 ? view.state.sliceDoc(from - 1, from) : "\n";
  return surround(view, /\s/.test(prev) ? "#" : " #", "", false);
}

/** Converts the cursor's lines; with no selection the cursor stays at the end of its line. */
export const lines = (view: EditorView, kind: LineKind) => setLines(view, kind);

export function heading(view: EditorView) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const next = cycleHeading(line.text);
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, selection: EditorSelection.cursor(line.from + next.length) });
  view.focus();
  return true;
}

export { indentLess, indentMore, redo, undo };
