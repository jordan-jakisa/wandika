import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { NoteMeta } from "../types";
import { diagrams, diagramTheme } from "./diagrams";
import { embedTheme, embeds, fileDrops } from "./embeds";
import { formatting } from "./format";
import { livePreview } from "./livePreview";
import { tables, tableTheme } from "./tables";

const highlight = HighlightStyle.define([
  { tag: t.url, color: "var(--graphite)" },
  { tag: t.monospace, fontFamily: "var(--font-code)" },
  { tag: t.keyword, color: "var(--papyrus)" },
  { tag: t.string, color: "var(--amber)" },
  { tag: t.comment, color: "var(--graphite)", fontStyle: "italic" },
  { tag: t.processingInstruction, color: "var(--graphite)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", background: "transparent", color: "var(--ink)", fontSize: "var(--note-size)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-note)", lineHeight: "1.65", overflow: "visible" },
  ".cm-content": { padding: "0 0 2em", caretColor: "var(--papyrus)", maxWidth: "var(--measure)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--papyrus)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    background: "color-mix(in srgb, var(--papyrus) 22%, transparent) !important",
  },
  ".cm-h": { fontWeight: "600", lineHeight: "1.25" },
  ".cm-h1": { fontSize: "2em", paddingTop: "0.4em !important", paddingBottom: "0.15em !important" },
  ".cm-h2": { fontSize: "1.5em", paddingTop: "0.6em !important", paddingBottom: "0.1em !important" },
  ".cm-h3": { fontSize: "1.25em", paddingTop: "0.5em !important" },
  ".cm-h4, .cm-h5, .cm-h6": { fontSize: "1em", paddingTop: "0.4em !important" },
  ".cm-strong": { fontWeight: "650" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-strike": { textDecoration: "line-through", color: "var(--graphite)" },
  ".cm-inline-code": {
    fontFamily: "var(--font-code)",
    fontSize: "0.86em",
    background: "var(--papyrus-wash)",
    borderRadius: "4px",
    padding: "0.1em 0.3em",
  },
  ".cm-codeblock": {
    fontFamily: "var(--font-code)",
    fontSize: "0.86em",
    background: "var(--papyrus-wash)",
    paddingLeft: "0.8em !important",
  },
  ".cm-quote": {
    borderLeft: "2px solid var(--rule)",
    paddingLeft: "1em !important",
    color: "var(--graphite)",
  },
  ".cm-frontmatter": { fontFamily: "var(--font-code)", fontSize: "0.8em", color: "var(--graphite)" },
  ".cm-wikilink, .cm-md-link": {
    color: "var(--papyrus)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in srgb, var(--papyrus) 40%, transparent)",
    textUnderlineOffset: "3px",
    cursor: "pointer",
  },
  ".cm-tag": { color: "var(--papyrus)", fontFamily: "var(--font-ui)", fontSize: "0.85em", fontWeight: "500", cursor: "pointer" },
  ".cm-list-mark": { color: "var(--graphite)" },
  ".cm-bullet": { color: "var(--graphite)", display: "inline-block", width: "0.6em" },
  ".cm-task": {
    width: "1.05em",
    height: "1.05em",
    margin: "0 0.35em 0 0",
    verticalAlign: "-0.15em",
    accentColor: "var(--papyrus)",
    cursor: "pointer",
  },
  ".cm-task-done": { color: "var(--graphite)", textDecoration: "line-through" },
  ".cm-hr-line": { display: "inline-block", width: "100%", borderTop: "1px solid var(--rule)", verticalAlign: "middle" },
  ".cm-placeholder": { color: "var(--graphite)" },
  ".cm-tooltip": { background: "var(--sheet)", border: "1px solid var(--rule)", borderRadius: "var(--radius)" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-ui)", fontSize: "var(--ui-size)", maxHeight: "16em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "6px 10px !important" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--papyrus)", color: "var(--on-papyrus)" },
  ".cm-completionDetail": { opacity: "0.7", fontStyle: "normal", marginLeft: "0.6em" },
  ".cm-panels": { background: "var(--sheet)", color: "var(--ink)", borderColor: "var(--rule)" },
  ".cm-searchMatch": { background: "color-mix(in srgb, var(--amber) 30%, transparent)" },
});

function wikilinks(getTitles: () => NoteMeta[]) {
  return (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/\[\[[^\]\n|]*/);
    if (!m) return null;
    const options: Completion[] = getTitles().map((n) => {
      const folder = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
      return {
        label: n.title,
        detail: folder,
        apply: (view, _c, from, to) => {
          const closed = view.state.sliceDoc(to, to + 2) === "]]";
          const insert = n.title + (closed ? "" : "]]");
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + n.title.length + 2 } });
        },
      };
    });
    return { from: m.from + 2, options, validFor: /^[^\]\n|]*$/ };
  };
}

export function extensions(opts: {
  getTitles: () => NoteMeta[];
  onOpenLink: (target: string) => void;
  onTag: (tag: string) => void;
  onChange: (doc: string) => void;
  getPath: () => string;
  onFiles: (files: File[], view: EditorView, pos: number) => void;
}): Extension[] {
  return [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    markdown({ base: markdownLanguage, addKeymap: true }),
    syntaxHighlighting(highlight),
    search({ top: true }),
    highlightSelectionMatches(),
    autocompletion({ override: [wikilinks(opts.getTitles)], icons: false }),
    formatting,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    placeholder("Start writing. Type [[ to link a note."),
    embeds(opts.getPath),
    fileDrops(opts.onFiles),
    livePreview(opts.onOpenLink, opts.onTag),
    diagrams,
    tables(opts.onOpenLink),
    theme,
    diagramTheme,
    tableTheme,
    embedTheme,
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state.doc.toString());
    }),
  ];
}
