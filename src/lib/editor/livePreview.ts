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
const TAG = /(^|\s)(#[A-Za-z][\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}/-]*)/gu;

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

// Obsidian callouts: `> [!type]` with an optional fold mark and title.
const CALLOUT = /^(\s*>\s*)\[!([\w-]+)\]([+-]?)\s*(.*)$/;
const TONES: Record<string, string> = {
  tip: "accent", hint: "accent", important: "accent", success: "accent", check: "accent", done: "accent",
  question: "amber", help: "amber", faq: "amber", warning: "amber", caution: "amber", attention: "amber",
  failure: "alarm", fail: "alarm", missing: "alarm", danger: "alarm", error: "alarm", bug: "alarm",
  example: "quiet", quote: "quiet", cite: "quiet",
};
const tone = (type: string) => TONES[type.toLowerCase()] ?? "info";

class CalloutTitle extends WidgetType {
  constructor(readonly title: string) {
    super();
  }
  eq(other: CalloutTitle) {
    return other.title === this.title;
  }
  toDOM() {
    const t = document.createElement("span");
    t.className = "cm-callout-title";
    t.textContent = this.title;
    return t;
  }
  ignoreEvent() {
    return false;
  }
}

class Bullet extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const b = document.createElement("span");
    b.className = "cm-bullet";
    b.textContent = "•";
    return b;
  }
}

class Rule extends WidgetType {
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-hr-line";
    return hr;
  }
}

export function activeLines(state: EditorState, focused = true) {
  const lines = new Set<number>();
  // Unfocused, the whole note reads as rendered text.
  if (!focused) return lines;
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
  const active = activeLines(state, view.hasFocus);
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const out: Range<Decoration>[] = [];
  const fmEnd = frontmatterEnd(state);
  const fmTo = fmEnd ? state.doc.line(fmEnd).to : -1;

  for (let n = 1; n <= fmEnd; n++) {
    out.push(Decoration.line({ class: "cm-frontmatter" }).range(state.doc.line(n).from));
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        // CommonMark reads frontmatter as a rule and a heading; it stays as typed.
        if (name !== "Document" && node.from <= fmTo) return false;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(Decoration.line({ class: `cm-h cm-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
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
          // `[[note]]` also parses as a reference link `[note]`; leave those to the wikilink pass.
          if (!url) return false;
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
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          const callout = CALLOUT.exec(first.text);
          for (let p = node.from; p <= node.to; ) {
            const line = state.doc.lineAt(p);
            let cls = "cm-quote";
            if (callout) {
              cls = `cm-callout cm-callout-${tone(callout[2])}`;
              if (line.number === first.number) cls += " cm-callout-first";
              if (line.number === last.number) cls += " cm-callout-last";
            }
            out.push(Decoration.line({ class: cls }).range(line.from));
            p = line.to + 1;
          }
          if (callout && !isActive(first.from)) {
            // "> [!warning] Mind the gap": the marker and title become one styled title.
            const start = first.from + callout[1].length;
            const title = callout[4].trim() || callout[2][0].toUpperCase() + callout[2].slice(1).toLowerCase();
            out.push(Decoration.replace({ widget: new CalloutTitle(title) }).range(start, first.to));
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
        if (name === "ListMark") {
          const item = node.node.parent;
          const isTask = !!item?.getChild("Task");
          const bullet = /^[-*+]$/.test(state.sliceDoc(node.from, node.to));
          if (!isActive(node.from) && isTask) {
            // "- [ ] text": the checkbox stands in for the dash.
            out.push(hide.range(node.from, Math.min(node.to + 1, state.doc.lineAt(node.from).to)));
          } else if (!isActive(node.from) && bullet) {
            out.push(Decoration.replace({ widget: new Bullet() }).range(node.from, node.to));
          } else {
            out.push(Decoration.mark({ class: "cm-list-mark" }).range(node.from, node.to));
          }
        }
      },
    });

    // Wikilinks and tags aren't in the CommonMark tree; find them per visible line.
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (line.number <= fmEnd || inCode(state, line.from)) continue;
      const lineActive = active.has(line.number);
      for (const m of line.text.matchAll(WIKILINK)) {
        // `![[file]]` is an embed, drawn by the embeds extension, not a link.
        if (line.text[m.index! - 1] === "!" || inInlineCode(state, line.from + m.index!)) continue;
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
        if (inInlineCode(state, start)) continue;
        out.push(Decoration.mark({ class: "cm-tag", attributes: { "data-tag": m[2].slice(1) } }).range(start, start + m[2].length));
      }
    }
  }
  return Decoration.set(out, true);
}

function inInlineCode(state: EditorState, pos: number) {
  const node = syntaxTree(state).resolveInner(pos, 1);
  for (let n: typeof node | null = node; n; n = n.parent) {
    if (n.name === "InlineCode") return true;
  }
  return false;
}

/** Whether `pos` is in a code block. A position in a line's indent counts by the line's text. */
export function inCode(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  const indent = /^\s*/.exec(line.text)![0].length;
  const at = Math.max(pos, Math.min(line.from + indent, line.to));
  let node = syntaxTree(state).resolveInner(at, 1);
  for (let n: typeof node | null = node; n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") return true;
  }
  return false;
}

export function livePreview(onOpenLink: (target: string) => void, onTag: (tag: string) => void) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const target = e.target as HTMLElement;
      const tag = target.closest<HTMLElement>(".cm-tag");
      if (tag?.dataset.tag && (e.metaKey || e.ctrlKey || !activeLines(view.state, view.hasFocus).has(view.state.doc.lineAt(view.posAtDOM(tag)).number))) {
        e.preventDefault();
        onTag(tag.dataset.tag);
        return true;
      }
      const el = target.closest<HTMLElement>(".cm-wikilink") ?? target.closest<HTMLElement>(".cm-md-link");
      if (!el) return false;
      const pos = view.posAtDOM(el);
      const onActiveLine = activeLines(view.state, view.hasFocus).has(view.state.doc.lineAt(pos).number);
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
