// Frontmatter shown as a list of properties, like Obsidian's Properties view. The YAML itself
// comes back when the cursor goes into it (tap the list to edit).

import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { parseProperties } from "./noteText";

/** End of the closing `---` line, or -1 when the note has no frontmatter. */
function frontmatterTo(state: EditorState) {
  if (state.doc.lines < 2 || state.doc.line(1).text !== "---") return -1;
  for (let n = 2; n <= Math.min(state.doc.lines, 200); n++) {
    if (state.doc.line(n).text === "---") return state.doc.line(n).to;
  }
  return -1;
}

class Properties extends WidgetType {
  constructor(readonly yaml: string) {
    super();
  }
  eq(other: Properties) {
    return other.yaml === this.yaml;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-properties";
    box.setAttribute("role", "button");
    box.setAttribute("aria-label", "Properties. Tap to edit.");
    const props = parseProperties(this.yaml);
    for (const p of props) {
      const row = document.createElement("div");
      row.className = "cm-prop";
      const key = document.createElement("span");
      key.className = "cm-prop-key";
      key.textContent = p.key;
      const value = document.createElement("span");
      value.className = "cm-prop-value";
      const list = p.values.length > 1 || /^(tags|aliases|cssclasses)$/i.test(p.key);
      for (const v of p.values) {
        const text = v.replace(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/, (_, t: string, a?: string) => a ?? t);
        if (list) {
          const chip = document.createElement("span");
          chip.className = "cm-prop-chip";
          chip.textContent = /^tags$/i.test(p.key) ? `#${text.replace(/^#/, "")}` : text;
          value.append(chip);
        } else {
          value.textContent = text;
        }
      }
      if (!p.values.length) value.textContent = "Empty";
      if (!p.values.length) value.classList.add("cm-prop-empty");
      row.append(key, value);
      box.append(row);
    }
    if (!props.length) box.textContent = "Properties";
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.state.doc.line(Math.min(2, view.state.doc.lines)).to } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

const focusEffect = StateEffect.define<boolean>();

const focused = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(focusEffect) ? e.value : acc), v),
});

function decorate(state: EditorState): DecorationSet {
  const to = frontmatterTo(state);
  if (to < 0) return Decoration.none;
  const head = state.selection.main.head;
  if (state.field(focused) && head <= to) return Decoration.none;
  const yaml = state.sliceDoc(state.doc.line(2).from, state.doc.lineAt(to).from).replace(/\n$/, "");
  return Decoration.set(Decoration.replace({ widget: new Properties(yaml), block: true }).range(0, to));
}

const field = StateField.define<DecorationSet>({
  create: decorate,
  update: (deco, tr) =>
    tr.docChanged || tr.selection || tr.effects.some((e) => e.is(focusEffect)) ? decorate(tr.state) : deco,
  provide: (f) => EditorView.decorations.from(f),
});

export const properties = [
  focused,
  field,
  EditorView.focusChangeEffect.of((_state, focusing) => focusEffect.of(focusing)),
];

export const propertiesTheme = EditorView.theme({
  ".cm-properties": {
    display: "grid",
    gap: "2px",
    margin: "0 0 12px",
    padding: "8px 0",
    borderBottom: "1px solid var(--rule)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--small)",
    cursor: "text",
  },
  ".cm-prop": { display: "grid", gridTemplateColumns: "minmax(6em, 30%) 1fr", gap: "12px", padding: "3px 0" },
  ".cm-prop-key": { color: "var(--graphite)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  ".cm-prop-value": { display: "flex", flexWrap: "wrap", gap: "4px 6px", color: "var(--ink)", overflowWrap: "anywhere" },
  ".cm-prop-empty": { color: "var(--graphite)" },
  ".cm-prop-chip": {
    padding: "0 8px",
    borderRadius: "999px",
    background: "color-mix(in srgb, var(--ink) 7%, transparent)",
  },
});
