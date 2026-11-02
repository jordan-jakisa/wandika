// Embedded images, `![[photo.png]]`, `![[photo.png|300]]` and `![alt](path)`, drawn in place on
// lines the cursor isn't on. Tapping one puts the cursor there and shows the Markdown again.

import { type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { imageUrl, isImage } from "../attachments";
import { activeLines, inCode } from "./livePreview";

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
      () => {
        wrap.classList.add("cm-embed-missing");
        wrap.textContent = `${this.target} isn't in this vault.`;
      },
    );
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function build(view: EditorView, from: string): DecorationSet {
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
        if (!isImage(target.trim())) continue;
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

export function embeds(getPath: () => string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, getPath());
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) this.decorations = build(u.view, getPath());
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export const embedTheme = EditorView.theme({
  ".cm-embed": { display: "block", margin: "6px 0" },
  ".cm-embed img": { display: "block", maxWidth: "100%", height: "auto", borderRadius: "8px" },
  ".cm-embed-missing": { color: "var(--graphite)", fontSize: "var(--small)" },
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
