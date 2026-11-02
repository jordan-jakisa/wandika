// Embeds drawn in place on lines the cursor isn't on: images (`![[photo.png]]`,
// `![[photo.png|300]]`, `![alt](path)`) and other notes (`![[Note]]`, `![[Note#Heading]]`).
// Tapping one puts the cursor there and shows the Markdown again.

import { type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { api } from "../api";
import { imageUrl, isImage } from "../attachments";
import { activeLines, inCode } from "./livePreview";
import { renderLite, section } from "./noteText";

const WIKI_EMBED = /!\[\[([^\]\n]+?)\]\]/g;
const MD_IMAGE = /!\[([^\]\n]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;

class ImageEmbed extends WidgetType {
  constructor(
    readonly target: string,
    readonly from: string,
    readonly alt: string,
    readonly width: number | null,
  ) {
    super();
  }
  eq(o: ImageEmbed) {
    return o.target === this.target && o.from === this.from && o.alt === this.alt && o.width === this.width;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-embed";
    const img = document.createElement("img");
    img.alt = this.alt;
    img.decoding = "async";
    if (this.width) img.style.width = `${this.width}px`;
    img.addEventListener("load", () => view.requestMeasure());
    wrap.append(img);
    imageUrl(this.target, this.from).then(
      (url) => (img.src = url),
      (e: unknown) => {
        wrap.classList.add("cm-embed-missing");
        wrap.textContent =
          (e as { code?: string }).code === "locked"
            ? "Unlock encrypted notes to see this image."
            : `${this.target} isn't in this vault.`;
      },
    );
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

class NoteEmbed extends WidgetType {
  constructor(
    readonly target: string,
    readonly onOpen: (target: string) => void,
  ) {
    super();
  }
  eq(o: NoteEmbed) {
    return o.target === this.target;
  }
  toDOM(view: EditorView) {
    const [name, sub] = this.target.split("#");
    const box = document.createElement("div");
    box.className = "cm-note-embed";
    const head = document.createElement("button");
    head.className = "cm-note-embed-title";
    head.textContent = (name.split("/").pop() ?? name) + (sub ? ` › ${sub.replace(/^\^/, "")}` : "");
    head.addEventListener("mousedown", (e) => e.preventDefault());
    head.addEventListener("click", () => this.onOpen(this.target));
    const body = document.createElement("div");
    body.className = "cm-note-embed-body";
    box.append(head, body);
    api
      .resolveLink(name)
      .then((path) => (path ? api.noteRead(path) : Promise.reject(new Error("missing"))))
      .then((text) => {
        const part = section(text, sub);
        if (!part.trim()) throw new Error("empty");
        const { html, more } = renderLite(part);
        body.innerHTML = html + (more ? '<p class="more">…</p>' : "");
        view.requestMeasure();
      })
      .catch((e: Error) => {
        box.classList.add("cm-embed-missing");
        body.textContent = e.message === "empty" ? `Nothing under “${sub}” in ${name}.` : `${name} isn't in this vault yet.`;
      });
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

function build(view: EditorView, from: string, onOpen: (target: string) => void): DecorationSet {
  const { state } = view;
  const active = activeLines(state, view.hasFocus);
  const out: Range<Decoration>[] = [];
  for (const { from: start, to } of view.visibleRanges) {
    for (let pos = start; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (active.has(line.number) || !line.text.includes("![") || inCode(state, line.from)) continue;
      for (const m of line.text.matchAll(WIKI_EMBED)) {
        const [target, size] = m[1].split("|");
        if (!isImage(target.trim())) {
          const widget = new NoteEmbed(target.trim(), onOpen);
          out.push(Decoration.replace({ widget }).range(line.from + m.index!, line.from + m.index! + m[0].length));
          continue;
        }
        const width = /^\d+/.exec(size?.trim() ?? "")?.[0];
        const widget = new ImageEmbed(target.trim(), from, target.trim(), width ? Number(width) : null);
        out.push(Decoration.replace({ widget }).range(line.from + m.index!, line.from + m.index! + m[0].length));
      }
      for (const m of line.text.matchAll(MD_IMAGE)) {
        let target = m[2];
        try {
          target = decodeURI(target);
        } catch {
          // Leave a malformed escape as written.
        }
        const [alt, size] = m[1].split("|");
        const width = /^\d+/.exec(size?.trim() ?? "")?.[0];
        const widget = new ImageEmbed(target, from, alt, width ? Number(width) : null);
        out.push(Decoration.replace({ widget }).range(line.from + m.index!, line.from + m.index! + m[0].length));
      }
    }
  }
  return Decoration.set(out, true);
}

export function embeds(getPath: () => string, onOpen: (target: string) => void) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, getPath(), onOpen);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.decorations = build(u.view, getPath(), onOpen);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export const embedTheme = EditorView.theme({
  ".cm-embed": { display: "block", margin: "6px 0" },
  ".cm-embed img": { display: "block", maxWidth: "100%", height: "auto", borderRadius: "8px" },
  ".cm-embed-missing": { color: "var(--graphite)", fontSize: "var(--small)" },
  // An embedded note reads as part of this one: a quiet panel, its title a link to the source.
  ".cm-note-embed": {
    display: "block",
    margin: "6px 0",
    padding: "10px 14px 12px",
    borderRadius: "10px",
    background: "color-mix(in srgb, var(--ink) 4%, transparent)",
    whiteSpace: "normal",
  },
  ".cm-note-embed-title": {
    display: "block",
    padding: "0",
    border: "0",
    background: "none",
    color: "var(--papyrus)",
    font: "inherit",
    fontSize: "var(--small)",
    fontWeight: "600",
    cursor: "pointer",
  },
  ".cm-note-embed-body": { marginTop: "4px" },
  ".cm-note-embed-body p": { margin: "0" },
  ".cm-note-embed-body .gap": { height: "0.6em" },
  ".cm-note-embed-body .h": { fontWeight: "650" },
  ".cm-note-embed-body .h1, .cm-note-embed-body .h2": { fontSize: "1.1em" },
  ".cm-note-embed-body .li": { paddingLeft: "calc(var(--depth) * 0.5em)" },
  ".cm-note-embed-body .done": { color: "var(--graphite)", textDecoration: "line-through" },
  ".cm-note-embed-body .q": { color: "var(--graphite)" },
  ".cm-note-embed-body .q.title": { fontWeight: "600" },
  ".cm-note-embed-body pre": { margin: "0", fontFamily: "var(--font-code)", fontSize: "0.86em", whiteSpace: "pre-wrap" },
  ".cm-note-embed-body code": { fontFamily: "var(--font-code)", fontSize: "0.9em" },
  ".cm-note-embed-body .more": { color: "var(--graphite)" },
});

/** Pasted or dropped files are saved as attachments and embedded at the drop point. */
export function fileDrops(onFiles: (files: File[], view: EditorView, pos: number) => void) {
  return EditorView.domEventHandlers({
    paste(e, view) {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return false;
      e.preventDefault();
      onFiles(files, view, view.state.selection.main.head);
      return true;
    },
    drop(e, view) {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return false;
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      onFiles(files, view, pos);
      return true;
    },
  });
}
