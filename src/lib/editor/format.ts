// Formatting for the selection: a small bar that appears above selected text, plus shortcuts.
// List buttons convert whole lines; the others wrap the selected text.

import { EditorSelection, StateField, type EditorState } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { Bold, Code, Italic, List, ListChecks, ListOrdered, Pilcrow, Quote, Strikethrough } from "@lucide/svelte";
import { mount, type Component } from "svelte";
import { convertLines, toggleWrap, type LineKind } from "./lists";

export function setLines(view: EditorView, kind: LineKind) {
  const { state } = view;
  const changes = state.selection.ranges.map((r) => {
    const from = state.doc.lineAt(r.from).from;
    const to = state.doc.lineAt(r.to).to;
    const lines = state.sliceDoc(from, to).split("\n");
    return { from, to, insert: convertLines(lines, kind).join("\n") };
  });
  const tx = state.update({ changes });
  // Keep whole converted lines selected so the next button applies to the same block. A cursor
  // (a shortcut pressed while typing) stays a cursor at the end of its line, so typing carries on
  // instead of replacing the line.
  const ranges = changes.map((c, i) => {
    const start = tx.changes.mapPos(c.from, -1);
    const end = tx.changes.mapPos(c.to, 1);
    return state.selection.ranges[i].empty ? EditorSelection.cursor(end) : EditorSelection.range(start, end);
  });
  // One spec: the selection then refers to the changed document and is not mapped a second time.
  view.dispatch({ changes, selection: EditorSelection.create(ranges) });
  view.focus();
  return true;
}

export function wrap(view: EditorView, mark: string) {
  const { state } = view;
  view.dispatch(
    state.changeByRange((r) => {
      const text = state.sliceDoc(r.from, r.to);
      // With no selection, insert a pair of marks and put the cursor between them.
      if (r.empty) return { changes: { from: r.from, insert: mark + mark }, range: EditorSelection.cursor(r.from + mark.length) };
      const next = toggleWrap(text, mark);
      return { changes: { from: r.from, to: r.to, insert: next }, range: EditorSelection.range(r.from, r.from + next.length) };
    }),
  );
  view.focus();
  return true;
}

const BUTTONS: { label: string; icon: Component<any>; run: (v: EditorView) => boolean; group: number }[] = [
  { label: "Bulleted list", icon: List, run: (v) => setLines(v, "bullet"), group: 0 },
  { label: "Numbered list", icon: ListOrdered, run: (v) => setLines(v, "numbered"), group: 0 },
  { label: "Checklist", icon: ListChecks, run: (v) => setLines(v, "task"), group: 0 },
  { label: "Quote", icon: Quote, run: (v) => setLines(v, "quote"), group: 0 },
  { label: "Plain text", icon: Pilcrow, run: (v) => setLines(v, "plain"), group: 0 },
  { label: "Bold", icon: Bold, run: (v) => wrap(v, "**"), group: 1 },
  { label: "Italic", icon: Italic, run: (v) => wrap(v, "*"), group: 1 },
  { label: "Strikethrough", icon: Strikethrough, run: (v) => wrap(v, "~~"), group: 1 },
  { label: "Code", icon: Code, run: (v) => wrap(v, "`"), group: 1 },
];

const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

function toolbar(state: EditorState): readonly Tooltip[] {
  const sel = state.selection.main;
  if (sel.empty) return [];
  return [
    {
      pos: sel.from,
      // On phones the system's own copy/paste menu sits above the selection, so ours goes below.
      above: !touch,
      strictSide: false,
      arrow: false,
      create(view) {
        const dom = document.createElement("div");
        dom.className = "cm-format";
        dom.setAttribute("role", "toolbar");
        dom.setAttribute("aria-label", "Format selection");
        let group = 0;
        for (const b of BUTTONS) {
          if (b.group !== group) {
            const sep = document.createElement("span");
            sep.className = "cm-format-sep";
            dom.appendChild(sep);
            group = b.group;
          }
          const btn = document.createElement("button");
          btn.type = "button";
          btn.title = b.label;
          btn.setAttribute("aria-label", b.label);
          // Keep the editor's selection: act on mousedown and don't take focus.
          btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            b.run(view);
          });
          mount(b.icon, { target: btn, props: { size: 16 } });
          dom.appendChild(btn);
        }
        return { dom };
      },
    },
  ];
}

const toolbarField = StateField.define<readonly Tooltip[]>({
  create: toolbar,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    return toolbar(tr.state);
  },
  provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

export const formatKeymap = keymap.of([
  { key: "Mod-Shift-8", run: (v) => setLines(v, "bullet") },
  { key: "Mod-Shift-7", run: (v) => setLines(v, "numbered") },
  { key: "Mod-l", run: (v) => setLines(v, "task") },
  { key: "Mod-b", run: (v) => wrap(v, "**") },
  { key: "Mod-i", run: (v) => wrap(v, "*") },
]);

export const formatTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-format, .cm-tooltip:has(> .cm-format)": {
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius)",
    background: "var(--sheet)",
    boxShadow: "var(--shadow-pop)",
  },
  ".cm-format": { display: "flex", alignItems: "center", gap: "2px", padding: "4px" },
  ".cm-format button": {
    display: "grid",
    placeItems: "center",
    width: "32px",
    height: "32px",
    border: "0",
    borderRadius: "var(--radius-sm)",
    background: "none",
    color: "var(--ink)",
    cursor: "pointer",
  },
  "@media (hover: hover)": {
    ".cm-format button:hover": { background: "var(--papyrus-wash)", color: "var(--papyrus)" },
  },
  ".cm-format button:active": { background: "var(--press)" },
  ".cm-format-sep": { width: "1px", height: "20px", margin: "0 4px", background: "var(--rule)" },
  "@media (pointer: coarse)": {
    ".cm-format button": { width: "40px", height: "40px" },
  },
});

export const formatting = [toolbarField, formatKeymap, formatTheme];
