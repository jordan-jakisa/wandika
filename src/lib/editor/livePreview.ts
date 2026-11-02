// Obsidian-style live preview: Markdown marks hide on lines the cursor isn't on, headings and
// emphasis render in place, task boxes become real checkboxes, and [[links]] become tappable.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

const hide = Decoration.replace({});
const WIKILINK = /\[\[([^\]\n]+?)\]\]/g;
const TAG = /(^|\s)(#[A-Za-z][\w/-]*)/g;

class Checkbox extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(other: Checkbox) {
    return other.checked === this.checked && other.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-task";
    box.setAttribute("aria-label", this.checked ? "Mark as not done" : "Mark as done");
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class Rule extends WidgetType {
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-hr-line";
    return hr;
  }
}

function activeLines(state: EditorState) {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

/** YAML frontmatter at the top of the note: dimmed, never rendered. */
function frontmatterEnd(state: EditorState) {
  if (state.doc.lines < 2 || state.doc.line(1).text !== "---") return 0;
  for (let n = 2; n <= Math.min(state.doc.lines, 200); n++) {
    if (state.doc.line(n).text === "---") return n;
  }
  return 0;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const out: Range<Decoration>[] = [];
  const fmEnd = frontmatterEnd(state);

  for (let n = 1; n <= fmEnd; n++) {
    out.push(Decoration.line({ class: "cm-frontmatter" }).range(state.doc.line(n).from));
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          const line = state.doc.lineAt(node.from);
          if (line.number <= fmEnd) return false;
          out.push(Decoration.line({ class: `cm-h cm-h${heading[1]}` }).range(line.from));
          return;
        }
        if (name === "HeaderMark" && !isActive(node.from)) {
          const next = state.sliceDoc(node.to, node.to + 1);
          out.push(hide.range(node.from, next === " " ? node.to + 1 : node.to));
          return;
        }
        if (name === "StrongEmphasis") out.push(Decoration.mark({ class: "cm-strong" }).range(node.from, node.to));
        if (name === "Emphasis") out.push(Decoration.mark({ class: "cm-em" }).range(node.from, node.to));
        if (name === "Strikethrough") out.push(Decoration.mark({ class: "cm-strike" }).range(node.from, node.to));
        if (name === "InlineCode") out.push(Decoration.mark({ class: "cm-inline-code" }).range(node.from, node.to));
        if (
          (name === "EmphasisMark" || name === "CodeMark" || name === "StrikethroughMark") &&
          !isActive(node.from) &&
          node.node.parent?.name !== "FencedCode"
        ) {
          out.push(hide.range(node.from, node.to));
          return;
        }
        if (name === "Link") {
          const url = node.node.getChild("URL");
          const href = url ? state.sliceDoc(url.from, url.to) : "";
          out.push(
            Decoration.mark({ class: "cm-md-link", attributes: { "data-href": href } }).range(node.from, node.to),
          );
          if (!isActive(node.from)) {
            const marks = node.node.getChildren("LinkMark");
            // [text](url): hide "[" and everything from "]" to the end.
            if (marks.length >= 2) {
              out.push(hide.range(marks[0].from, marks[0].to));
              out.push(hide.range(marks[1].from, node.to));
            }
          }
          return false;
        }
        if (name === "TaskMarker") {
          const sel = state.selection.main;
          const inside = sel.from <= node.to && sel.to >= node.from;
          if (!inside) {
            const checked = state.sliceDoc(node.from + 1, node.from + 2).toLowerCase() === "x";
            out.push(Decoration.replace({ widget: new Checkbox(checked, node.from + 1) }).range(node.from, node.to));
            if (checked) {
              const line = state.doc.lineAt(node.from);
              if (node.to + 1 < line.to) out.push(Decoration.mark({ class: "cm-task-done" }).range(node.to + 1, line.to));
            }
          }
          return;
        }
        if (name === "Blockquote") {
          for (let p = node.from; p <= node.to; ) {
            const line = state.doc.lineAt(p);
            out.push(Decoration.line({ class: "cm-quote" }).range(line.from));
            p = line.to + 1;
          }
        }
        if (name === "QuoteMark" && !isActive(node.from)) {
          const next = state.sliceDoc(node.to, node.to + 1);
          out.push(hide.range(node.from, next === " " ? node.to + 1 : node.to));
        }
        if (name === "FencedCode") {
          for (let p = node.from; p <= node.to; ) {
            const line = state.doc.lineAt(p);
            out.push(Decoration.line({ class: "cm-codeblock" }).range(line.from));
            p = line.to + 1;
          }
          return false;
        }
        if (name === "HorizontalRule" && !isActive(node.from)) {
          out.push(Decoration.replace({ widget: new Rule() }).range(node.from, node.to));
        }
        if (name === "ListMark") out.push(Decoration.mark({ class: "cm-list-mark" }).range(node.from, node.to));
      },
    });

    // Wikilinks and tags aren't in the CommonMark tree; find them per visible line.
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number <= fmEnd || inCode(state, line.from)) continue;
      const lineActive = active.has(line.number);
      for (const m of line.text.matchAll(WIKILINK)) {
        const start = line.from + m.index!;
        const end = start + m[0].length;
        const [target, alias] = m[1].split("|");
        out.push(
          Decoration.mark({ class: "cm-wikilink", attributes: { "data-target": target.trim() } }).range(start, end),
        );
        if (!lineActive) {
          out.push(hide.range(start, start + 2));
          if (alias !== undefined) out.push(hide.range(start + 2, start + 2 + target.length + 1));
          out.push(hide.range(end - 2, end));
        }
      }
      for (const m of line.text.matchAll(TAG)) {
        if (/^#+\s/.test(line.text) && m.index === 0) continue;
        const start = line.from + m.index! + m[1].length;
        out.push(Decoration.mark({ class: "cm-tag" }).range(start, start + m[2].length));
      }
    }
  }
  return Decoration.set(out, true);
}

function inCode(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (let n: typeof node | null = node; n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") return true;
  }
  return false;
}

export function livePreview(onOpenLink: (target: string) => void) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = (e.target as HTMLElement).closest<HTMLElement>(".cm-wikilink, .cm-md-link");
      if (!el) return false;
      const pos = view.posAtDOM(el);
      const onActiveLine = activeLines(view.state).has(view.state.doc.lineAt(pos).number);
      // On the line being edited a plain click places the cursor; Cmd or Ctrl click still follows.
      if (onActiveLine && !(e.metaKey || e.ctrlKey)) return false;
      e.preventDefault();
      if (el.dataset.target) onOpenLink(el.dataset.target);
      else if (el.dataset.href) window.dispatchEvent(new CustomEvent("wandika:open-url", { detail: el.dataset.href }));
      return true;
    },
  });

  return [plugin, clicks];
}
