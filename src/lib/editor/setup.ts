import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { fold } from "../fold";
import { slashCommands, type SlashActions } from "./slash";
import { vimSlot, vimNow } from "./vimKeys";
import { smartListKeymap } from "./smartLists";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { crosshairCursor, drawSelection, EditorView, keymap, placeholder, rectangularSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { NoteMeta } from "../types";
import { diagrams, diagramTheme } from "./diagrams";
import { embedTheme, embeds, fileDrops } from "./embeds";
import { formatting } from "./format";
import { livePreview } from "./livePreview";
import { properties, propertiesTheme } from "./properties";
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
    borderRadius: "var(--radius-xs)",
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
  // Callouts: a tinted block, its title in the callout's colour. No side stripe.
  ".cm-callout": {
    background: "color-mix(in srgb, var(--tone) 9%, transparent)",
    padding: "0 1em !important",
  },
  ".cm-callout-first": { borderRadius: "8px 8px 0 0", paddingTop: "0.45em !important" },
  ".cm-callout-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px", paddingBottom: "0.45em !important" },
  ".cm-callout-info, .cm-callout-accent": { "--tone": "var(--papyrus)" },
  ".cm-callout-amber": { "--tone": "var(--amber)" },
  ".cm-callout-alarm": { "--tone": "var(--alarm)" },
  ".cm-callout-quiet": { "--tone": "var(--graphite)" },
  ".cm-callout-title": { color: "var(--tone)", fontWeight: "600" },
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
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-ui)", fontSize: "var(--ui-size)", maxHeight: "16em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "6px 10px !important" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--papyrus)", color: "var(--on-papyrus)" },
  ".cm-completionDetail": { opacity: "0.7", fontStyle: "normal", marginLeft: "0.6em" },
  // Slash command groups ("Text", "Insert"): a quiet label, not a heading.
  ".cm-tooltip-autocomplete completion-section": { display: "list-item", padding: "6px 10px 2px", color: "var(--graphite)", fontSize: "var(--small)", borderBottom: "0" },
  ".cm-panels": { background: "var(--sheet)", color: "var(--ink)", borderColor: "var(--rule)" },
  // The editor is as tall as its note, so a panel stuck to its bottom would sit mid-window on a
  // short note. Vim's : command line floats just above the window's status bar instead.
  ".cm-panels.cm-panels-bottom": {
    position: "fixed",
    // The middle of the note's column: the workspace sets --sidebar and --today to their widths.
    left: "calc(var(--sidebar, 0px) + (100vw - var(--sidebar, 0px) - var(--today, 0px)) / 2)",
    bottom: "calc(26px + var(--space-3) + var(--safe-bottom))",
    transform: "translateX(-50%)",
    width: "min(520px, calc(100vw - 32px))",
    border: "1px solid var(--rule)",
    borderRadius: "var(--radius)",
    boxShadow: "var(--shadow-pop)",
    zIndex: "30",
    overflow: "hidden",
  },
  ".cm-vim-panel": { padding: "6px 10px", fontFamily: "var(--font-code)", fontSize: "var(--ui-size)" },
  ".cm-vim-panel input": { border: "0", outline: "0", background: "transparent", color: "inherit", font: "inherit" },
  ".cm-searchMatch": { background: "color-mix(in srgb, var(--amber) 30%, transparent)" },
});

/** Folded titles and paths, worked out once per list of notes rather than on every keystroke. */
const folded = new WeakMap<NoteMeta[], { n: NoteMeta; t: string; p: string }[]>();
function foldedTitles(titles: NoteMeta[]) {
  let out = folded.get(titles);
  if (!out) {
    out = titles.map((n) => ({ n, t: fold(n.title), p: fold(n.path) }));
    folded.set(titles, out);
  }
  return out;
}

function wikilinks(getTitles: () => NoteMeta[]) {
  return (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/\[\[[^\]\n|]*/);
    if (!m) return null;
    // Matched here rather than by the editor, so accents don't matter: "cafe" finds "Café".
    // Titles that start with what was typed come first, then titles that contain it.
    const typed = fold(m.text.slice(2).trim());
    const ranked = foldedTitles(getTitles())
      .filter(({ t, p }) => !typed || t.includes(typed) || p.includes(typed))
      .sort(
        (a, b) =>
          Number(!a.t.startsWith(typed)) - Number(!b.t.startsWith(typed)) ||
          Number(!a.t.includes(typed)) - Number(!b.t.includes(typed)) ||
          a.n.title.localeCompare(b.n.title),
      )
      .slice(0, 200);
    const options: Completion[] = ranked.map(({ n }, i) => {
      const folder = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
      return {
        label: n.title,
        detail: folder,
        boost: -i,
        apply: (view, _c, from, to) => {
          const closed = view.state.sliceDoc(to, to + 2) === "]]";
          const insert = n.title + (closed ? "" : "]]");
          view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + n.title.length + 2 } });
        },
      };
    });
    return { from: m.from + 2, options, filter: false };
  };
}

export function extensions(opts: {
  getTitles: () => NoteMeta[];
  onOpenLink: (target: string) => void;
  onTag: (tag: string) => void;
  onChange: (doc: string) => void;
  getPath: () => string;
  onFiles: (files: File[], view: EditorView, pos: number) => void;
  /** What the slash commands for a picture, a drawing, a voice note and a template do. */
  slash?: SlashActions;
}): Extension[] {
  return [
    // Vim keys come first so they see keys before the other keymaps; empty unless turned on.
    vimSlot.of(vimNow()),
    history(),
    drawSelection(),
    // Several cursors, as in JetBrains IDEs: ⌥-click adds a cursor, ⌥-drag selects a column,
    // ⌥⌘↑ and ⌥⌘↓ add one above or below (the default keymap), Esc goes back to one.
    EditorView.clickAddsSelectionRange.of((e) => e.altKey || (/Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey)),
    rectangularSelection(),
    crosshairCursor(),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    markdown({ base: markdownLanguage, addKeymap: true }),
    syntaxHighlighting(highlight),
    search({ top: true }),
    highlightSelectionMatches(),
    autocompletion({ override: [wikilinks(opts.getTitles), slashCommands(opts.slash ?? {})], icons: false }),
    formatting,
    smartListKeymap,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    placeholder("Start writing. Type / for commands, or [[ to link a note."),
    embeds(opts.getPath, opts.onOpenLink),
    fileDrops(opts.onFiles),
    livePreview(opts.onOpenLink, opts.onTag),
    diagrams,
    properties,
    tables(opts.onOpenLink, opts.onTag),
    theme,
    diagramTheme,
    tableTheme,
    embedTheme,
    propertiesTheme,
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences" }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state.doc.toString());
    }),
  ];
}
