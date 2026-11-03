// Helpers for the editor tests. A document is written with its selection marked in place: `‸` is a
// cursor and `«…»` a selected range, so a test reads as the text the user sees.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { onTestFinished } from "vitest";

// jsdom has no layout. CodeMirror measures text ranges to draw the selection; without these it
// logs an error on every measure. Nothing in the tests depends on the sizes.
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

/** The plain document and selection that a marked-up string describes. */
export function parse(marked: string): { doc: string; selection: EditorSelection | undefined } {
  let doc = "";
  const ranges: { anchor: number; head: number }[] = [];
  let open = -1;
  for (const c of marked) {
    if (c === "‸") ranges.push({ anchor: doc.length, head: doc.length });
    else if (c === "«") open = doc.length;
    else if (c === "»") {
      ranges.push({ anchor: open, head: doc.length });
      open = -1;
    } else doc += c;
  }
  const selection = ranges.length
    ? EditorSelection.create(ranges.map((r) => EditorSelection.range(r.anchor, r.head)))
    : undefined;
  return { doc, selection };
}

/** The document with its selection marked, the inverse of `parse`. */
export function show(state: EditorState): string {
  const doc = state.doc.toString();
  const marks: { pos: number; text: string }[] = [];
  for (const r of state.selection.ranges) {
    if (r.empty) marks.push({ pos: r.from, text: "‸" });
    else marks.push({ pos: r.from, text: "«" }, { pos: r.to, text: "»" });
  }
  marks.sort((a, b) => b.pos - a.pos);
  let out = doc;
  for (const m of marks) out = out.slice(0, m.pos) + m.text + out.slice(m.pos);
  return out;
}

/** The Markdown language as the app configures it. */
export const md = () => markdown({ base: markdownLanguage });

// CodeMirror parses in time slices, so on a busy machine a fresh editor may not have parsed the
// whole note yet. Tests parse it all up front, so what they see doesn't depend on the clock.

export function stateOf(marked: string, extensions: Extension[] = []) {
  const { doc, selection } = parse(marked);
  const state = EditorState.create({ doc, selection, extensions: [EditorState.allowMultipleSelections.of(true), ...extensions] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  // The parsed tree reaches the state with its next transaction.
  return state.update({}).state;
}

/** An editor on a jsdom element, destroyed when the test ends. */
export function viewOf(marked: string, extensions: Extension[] = []) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: stateOf(marked, extensions), parent });
  forceParsing(view, view.state.doc.length, 5000);
  onTestFinished(() => {
    view.destroy();
    parent.remove();
  });
  return view;
}

// CodeMirror tells extensions about focus changes 10 ms after the DOM event.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Focuses the editor and waits until its extensions have heard about it. */
export async function focus(view: EditorView) {
  view.focus();
  await settle();
}

export async function blur(view: EditorView) {
  view.contentDOM.blur();
  await settle();
}

/** Moves the selection the way a click or arrow key would. */
export function select(view: EditorView, marked: string) {
  const { doc, selection } = parse(marked);
  if (doc !== view.state.doc.toString()) throw new Error("select: the document differs");
  view.dispatch({ selection });
}

export interface Deco {
  from: number;
  to: number;
  /** The class of a mark or line decoration, or the widget's class name. */
  kind: string;
  /** The text the decoration covers. */
  text: string;
}

/** Every decoration the editor draws, in document order. */
export function decorations(view: EditorView): Deco[] {
  const out: Deco[] = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    set.between(0, view.state.doc.length, (from, to, value: Decoration) => {
      const spec = value.spec;
      const kind = spec.widget ? spec.widget.constructor.name : spec.class ?? (from === to ? "line" : "hide");
      out.push({ from, to, kind, text: view.state.sliceDoc(from, to) });
    });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Fires a mousedown on an element the way a click starts. */
export function mousedown(el: Element, init: MouseEventInit = {}) {
  const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(e);
  return e;
}
