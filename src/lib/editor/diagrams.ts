// ```mermaid blocks render as diagrams with Pele (obsidianmd/pele). The renderer for each diagram
// type loads only when a note first uses it. Put the cursor in the block to edit its source.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

let seq = 0;

class Diagram extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
  ) {
    super();
  }

  eq(other: Diagram) {
    return other.source === this.source;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-diagram";
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", `Diagram: ${this.source.split("\n")[0].trim()}`);
    box.title = "Click to edit the diagram";
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 4 } });
      view.focus();
    });
    import("pele/lazy")
      .then(({ renderAsync }) =>
        renderAsync(this.source, {
          idPrefix: `d${++seq}-`,
          responsive: true,
          links: false,
          images: false,
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-ui"),
        }),
      )
      .then(({ svg }) => {
        box.innerHTML = svg;
      })
      .catch((e: Error) => {
        box.classList.add("cm-diagram-error");
        box.textContent = `This diagram has an error: ${e.message}`;
      });
    return box;
  }

  get estimatedHeight() {
    return 240;
  }

  ignoreEvent() {
    return true;
  }
}

function build(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = [];
  const sel = state.selection.main;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") return;
      const info = node.node.getChild("CodeInfo");
      if (!info || state.sliceDoc(info.from, info.to).trim().toLowerCase() !== "mermaid") return false;
      // Editing: show the source while the cursor is inside the block.
      if (sel.from <= node.to && sel.to >= node.from) return false;
      const text = node.node.getChild("CodeText");
      const source = text ? state.sliceDoc(text.from, text.to) : "";
      if (!source.trim()) return false;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      out.push(Decoration.replace({ widget: new Diagram(source, from), block: true }).range(from, to));
      return false;
    },
  });
  return Decoration.set(out, true);
}

/** Block widgets must come from state, not a view plugin, so this is a StateField. */
export const diagrams = StateField.define<DecorationSet>({
  create: build,
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return build(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const diagramTheme = EditorView.theme({
  ".cm-diagram": {
    margin: "0.6em 0",
    padding: "12px",
    borderRadius: "var(--radius)",
    background: "var(--paper)",
    cursor: "pointer",
    overflowX: "auto",
    "--pele-bg": "transparent",
    "--pele-fg": "var(--ink)",
    "--pele-muted": "var(--graphite)",
    "--pele-line": "var(--graphite)",
    "--pele-surface": "var(--sheet)",
    "--pele-surface-alt": "var(--papyrus-wash)",
    "--pele-border": "var(--rule)",
    "--pele-accent": "var(--papyrus)",
    "--pele-font": "var(--font-ui)",
    "--pele-radius": "6px",
    "--pele-series-1": "var(--papyrus)",
    "--pele-series-2": "var(--amber)",
    "--pele-series-3": "var(--alarm)",
    "--pele-series-4": "var(--graphite)",
    "--pele-series-5": "color-mix(in srgb, var(--papyrus) 55%, var(--sheet))",
    "--pele-series-6": "color-mix(in srgb, var(--amber) 55%, var(--sheet))",
    "--pele-series-7": "color-mix(in srgb, var(--alarm) 55%, var(--sheet))",
    "--pele-series-8": "color-mix(in srgb, var(--graphite) 55%, var(--sheet))",
  },
  ".cm-diagram svg": { display: "block", maxWidth: "100%", height: "auto", margin: "0 auto" },
  ".cm-diagram-error": { color: "var(--alarm)", fontFamily: "var(--font-ui)", fontSize: "var(--small)" },
});
