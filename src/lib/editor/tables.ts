// GFM tables render as real tables while the cursor is elsewhere. Click a row to edit its source.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { alignOf, inline, splitRow } from "./tableText.ts";

class Table extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly onOpenLink: (target: string) => void,
  ) {
    super();
  }

  eq(other: Table) {
    return other.source === this.source && other.from === this.from;
  }

  toDOM(view: EditorView) {
    const lines = this.source.split("\n");
    const header = splitRow(lines[0]);
    const aligns = splitRow(lines[1] ?? "").map(alignOf);
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-table";
    const cell = (tag: "th" | "td", text: string, i: number) => {
      const el = document.createElement(tag);
      el.innerHTML = inline(text);
      if (aligns[i]) el.style.textAlign = aligns[i]!;
      return el;
    };
    const head = table.createTHead().insertRow();
    header.forEach((t, i) => head.appendChild(cell("th", t, i)));
    const body = table.createTBody();
    let offset = this.from + lines[0].length + 1 + (lines[1]?.length ?? 0) + 1;
    for (const line of lines.slice(2)) {
      const row = body.insertRow();
      row.dataset.pos = String(offset);
      const cells = splitRow(line);
      header.forEach((_, i) => row.appendChild(cell("td", cells[i] ?? "", i)));
      offset += line.length + 1;
    }
    wrap.appendChild(table);

    wrap.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      e.preventDefault();
      const link = t.closest<HTMLElement>(".cm-wikilink");
      if (link?.dataset.target) return this.onOpenLink(link.dataset.target);
      const href = t.closest<HTMLElement>(".cm-md-link")?.dataset.href;
      if (href) return window.dispatchEvent(new CustomEvent("wandika:open-url", { detail: href }));
      const pos = Number(t.closest<HTMLElement>("tr")?.dataset.pos ?? this.from);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

function build(state: EditorState, onOpenLink: (target: string) => void): DecorationSet {
  const out: Range<Decoration>[] = [];
  const focused = state.field(focusField, false) ?? false;
  const sel = state.selection.main;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      // Editing: the source shows while the cursor is in the table and the editor has focus.
      if (focused && sel.from <= to && sel.to >= from) return false;
      const source = state.sliceDoc(from, to);
      if (source.split("\n").length < 2) return false;
      out.push(Decoration.replace({ widget: new Table(source, from, onOpenLink), block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(out, true);
}

const setFocus = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setFocus) ? e.value : acc), v),
});

/** Block widgets must come from state; focus is mirrored into state so tables close on blur. */
export function tables(onOpenLink: (target: string) => void) {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state, onOpenLink),
    update(value, tr) {
      if (
        tr.docChanged ||
        tr.selection ||
        tr.effects.some((e) => e.is(setFocus)) ||
        syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ) {
        return build(tr.state, onOpenLink);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  const focusSync = EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing));
  return [focusField, field, focusSync];
}

export const tableTheme = EditorView.theme({
  ".cm-table-wrap": { overflowX: "auto", margin: "0.6em 0", cursor: "text" },
  ".cm-table": {
    borderCollapse: "collapse",
    fontSize: "0.92em",
    lineHeight: "1.5",
    minWidth: "60%",
  },
  ".cm-table th, .cm-table td": {
    border: "1px solid var(--rule)",
    padding: "6px 10px",
    verticalAlign: "top",
    textAlign: "left",
  },
  ".cm-table th": { fontWeight: "600", background: "var(--paper)" },
  ".cm-table code": {
    fontFamily: "var(--font-code)",
    fontSize: "0.88em",
    background: "var(--papyrus-wash)",
    borderRadius: "4px",
    padding: "0.1em 0.3em",
    whiteSpace: "nowrap",
  },
});
