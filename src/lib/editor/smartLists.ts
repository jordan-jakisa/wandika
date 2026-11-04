// Smart lists, as in Obsidian: indenting, outdenting or moving a list item takes the items nested
// under it along, and Enter at the end of an item with nested items adds a new first nested item.
// With text selected, or with several cursors, the plain line commands run instead.

import { indentLess, indentMore, moveLineDown, moveLineUp } from "@codemirror/commands";
import { getIndentUnit, indentString } from "@codemirror/language";
import { EditorSelection, Prec, type EditorState, type Text, type TransactionSpec } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";

const ITEM = /^(\s*)(?:([-*+])( \[[ xX]\])?|(\d+)([.)]))[ \t]/;
const lead = (text: string) => /^\s*/.exec(text)![0];
const width = (indent: string) => indent.replace(/\t/g, "    ").length;
const isItem = (text: string) => ITEM.test(text);

/** The cursor's line, when there is exactly one cursor, no text is selected and the line is a list item. */
function itemLine(state: EditorState) {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  const line = state.doc.lineAt(sel.main.head);
  return isItem(line.text) ? line : null;
}

/** The last line of the item on line `n`: the lines after it indented deeper, with blank lines between them. */
export function blockEnd(doc: Text, n: number): number {
  const w = width(lead(doc.line(n).text));
  let end = n;
  for (let k = n + 1; k <= doc.lines; k++) {
    const text = doc.line(k).text;
    if (!text.trim()) continue;
    if (width(lead(text)) <= w) break;
    end = k;
  }
  return end;
}

/** One level of indent: a tab when the list already uses tabs, else the editor's indent unit. */
function unitFor(state: EditorState, from: number, to: number): string {
  for (let k = Math.max(1, from - 1); k <= to; k++) if (lead(state.doc.line(k).text).includes("\t")) return "\t";
  return indentString(state, getIndentUnit(state));
}

/** Keeps the cursor on the same character, even when text is added at its line's start. */
function apply(view: EditorView, spec: TransactionSpec & { changes: { from: number; to?: number; insert?: string }[] }) {
  const changes = view.state.changes(spec.changes);
  view.dispatch({ changes, selection: view.state.selection.map(changes, 1), scrollIntoView: true, userEvent: "input.indent" });
  return true;
}

export function indentItem(view: EditorView): boolean {
  const line = itemLine(view.state);
  if (!line) return indentMore(view);
  const { doc } = view.state;
  const w = width(lead(line.text));
  // The item above sets the limit: one level deeper than it, no more.
  let above = -1;
  for (let k = line.number - 1; k >= 1; k--) {
    const text = doc.line(k).text;
    if (!text.trim()) continue;
    if (isItem(text)) above = width(lead(text));
    if (isItem(text) || width(lead(text)) <= w) break;
  }
  const end = blockEnd(doc, line.number);
  const unit = unitFor(view.state, line.number, end);
  if (above < 0 || w + width(unit) > above + width(unit)) return true;
  const changes = [];
  for (let k = line.number; k <= end; k++) {
    const l = doc.line(k);
    if (l.text.trim()) changes.push({ from: l.from, insert: unit });
  }
  return apply(view, { changes });
}

export function outdentItem(view: EditorView): boolean {
  const line = itemLine(view.state);
  if (!line) return indentLess(view);
  if (!lead(line.text)) return true;
  const { doc } = view.state;
  const end = blockEnd(doc, line.number);
  const unit = unitFor(view.state, line.number, end);
  const changes = [];
  for (let k = line.number; k <= end; k++) {
    const l = doc.line(k);
    const ws = lead(l.text);
    if (!l.text.trim() || !ws) continue;
    const cut = ws.startsWith("\t") ? 1 : Math.min(ws.length, /^ */.exec(ws)![0].length, width(unit) || 1);
    changes.push({ from: l.from, to: l.from + cut });
  }
  return apply(view, { changes });
}

/** Swaps the lines `a..b` with the lines `b+1..c`, keeping the cursor on the same character of what moved. */
function swap(view: EditorView, a: number, b: number, c: number, moving: "first" | "second") {
  const { doc } = view.state;
  const from = doc.line(a).from;
  const first = doc.sliceString(from, doc.line(b).to);
  const second = doc.sliceString(doc.line(b + 1).from, doc.line(c).to);
  const head = view.state.selection.main.head;
  const anchor = moving === "first" ? from + second.length + 1 + (head - from) : from + (head - doc.line(b + 1).from);
  view.dispatch({
    changes: { from, to: doc.line(c).to, insert: `${second}\n${first}` },
    selection: EditorSelection.cursor(anchor),
    scrollIntoView: true,
    userEvent: "move.line",
  });
  return true;
}

/** Where the chunk above line `n` starts: the whole previous sibling with its nested items, or one line. */
function chunkAbove(doc: Text, n: number): number {
  const w = width(lead(doc.line(n).text));
  if (!doc.line(n - 1).text.trim()) return n - 1;
  for (let k = n - 1; k >= 1; k--) {
    const text = doc.line(k).text;
    if (!text.trim() || width(lead(text)) > w) continue;
    return isItem(text) && width(lead(text)) === w ? k : n - 1;
  }
  return n - 1;
}

export function moveItemUp(view: EditorView): boolean {
  const line = itemLine(view.state);
  if (!line) return moveLineUp(view);
  if (line.number === 1) return true;
  const { doc } = view.state;
  return swap(view, chunkAbove(doc, line.number), line.number - 1, blockEnd(doc, line.number), "second");
}

export function moveItemDown(view: EditorView): boolean {
  const line = itemLine(view.state);
  if (!line) return moveLineDown(view);
  const { doc } = view.state;
  const end = blockEnd(doc, line.number);
  if (end === doc.lines) return true;
  const next = doc.line(end + 1).text;
  const sibling = isItem(next) && width(lead(next)) === width(lead(line.text));
  return swap(view, line.number, end, sibling ? blockEnd(doc, end + 1) : end + 1, "first");
}

/** Enter at the end of an item with nested items starts a new first nested item. */
export function enterNested(view: EditorView): boolean {
  const line = itemLine(view.state);
  if (!line || view.state.selection.main.head !== line.to) return false;
  const m = ITEM.exec(line.text)!;
  if (!line.text.slice(m[0].length).trim()) return false;
  const { doc } = view.state;
  const end = blockEnd(doc, line.number);
  let child = line.number + 1;
  while (child <= end && !doc.line(child).text.trim()) child++;
  if (child > end) return false;
  const c = ITEM.exec(doc.line(child).text);
  if (!c) return false;
  const [, indent, bullet, check, num, delim] = c;
  const mark = num ? `${num}${delim}` : `${bullet}${check ? " [ ]" : ""}`;
  const changes: { from: number; to?: number; insert: string }[] = [{ from: line.to, insert: `\n${indent}${mark} ` }];
  // A numbered list keeps counting: the old first item and those after it move up by one.
  if (num) {
    const w = width(indent);
    for (let k = child; k <= end; k++) {
      const t = doc.line(k).text;
      const n = /^(\s*)(\d+)([.)])[ \t]/.exec(t);
      if (n && width(n[1]) === w) {
        const at = doc.line(k).from + n[1].length;
        changes.push({ from: at, to: at + n[2].length, insert: String(Number(n[2]) + 1) });
      } else if (t.trim() && width(lead(t)) < w) break;
    }
  }
  const insert = changes[0].insert;
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(line.to + insert.length),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/** The smart list keys. They run before the default keymap, and fall back to it outside lists. */
export const smartListKeymap = Prec.high(
  keymap.of([
    { key: "Tab", run: indentItem, shift: outdentItem },
    { key: "Alt-ArrowUp", run: moveItemUp },
    { key: "Alt-ArrowDown", run: moveItemDown },
    { key: "Enter", run: enterNested },
  ]),
);
