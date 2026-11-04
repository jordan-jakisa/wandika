// Slash commands: type / at the start of a line or after a space, then a few letters, to turn the
// line into a heading or list, or to insert a table, a code block, a callout, a diagram, today's
// date, a link, a picture, a drawing, a voice note or a template.

import { startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { inCode } from "./livePreview";

/** What the note around the editor does: pick a picture, open the drawing pad, listen, pick a template. */
export interface SlashActions {
  image?: () => void;
  drawing?: () => void;
  voice?: () => void;
  template?: () => void;
}

/** A list, heading or quote marker at the start of a line, after its indent. */
const MARKER = /^(\s*)(?:#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> )?/;

/** Replaces the line's marker with `prefix`, keeping its words and indent; the cursor ends the line. */
function lineAs(view: EditorView, at: number, prefix: string) {
  const line = view.state.doc.lineAt(at);
  const m = MARKER.exec(line.text)!;
  const next = m[1] + prefix + line.text.slice(m[0].length).trimEnd();
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, selection: EditorSelection.cursor(line.from + next.length) });
}

/** Puts `text` on lines of its own at `at`, with the cursor at `cursor` within it. */
function block(view: EditorView, at: number, text: string, cursor: number) {
  const line = view.state.doc.lineAt(at);
  const head = line.text.slice(0, at - line.from);
  const before = head.trim() ? "\n" : "";
  // The space typed before the slash goes with it.
  const from = before ? line.from + head.trimEnd().length : at;
  const after = line.text.slice(at - line.from).trim() ? "\n" : "";
  view.dispatch({ changes: { from, to: at, insert: before + text + after }, selection: EditorSelection.cursor(from + before.length + cursor) });
}

const TABLE = "| Column | Column |\n| --- | --- |\n|  |  |";

const pad = (n: number) => String(n).padStart(2, "0");
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface Command {
  label: string;
  /** Other words that find it: "/h1" finds Heading 1, "/todo" finds Checklist. */
  words: string;
  section: { name: string; rank: number };
  run: (view: EditorView, at: number) => void;
}

function commands(actions: SlashActions): Command[] {
  // Ranked, or the menu would sort the groups by name.
  const text = { name: "Text", rank: 0 };
  const insert = { name: "Insert", rank: 1 };
  const list: Command[] = [
    { label: "Heading 1", words: "h1 title", section: text, run: (v, at) => lineAs(v, at, "# ") },
    { label: "Heading 2", words: "h2", section: text, run: (v, at) => lineAs(v, at, "## ") },
    { label: "Heading 3", words: "h3", section: text, run: (v, at) => lineAs(v, at, "### ") },
    { label: "Bulleted list", words: "ul bullet", section: text, run: (v, at) => lineAs(v, at, "- ") },
    { label: "Numbered list", words: "ol number", section: text, run: (v, at) => lineAs(v, at, "1. ") },
    { label: "Checklist", words: "todo task checkbox", section: text, run: (v, at) => lineAs(v, at, "- [ ] ") },
    { label: "Quote", words: "blockquote", section: text, run: (v, at) => lineAs(v, at, "> ") },
    { label: "Plain text", words: "paragraph normal", section: text, run: (v, at) => lineAs(v, at, "") },
    {
      label: "Link to a note",
      words: "wikilink",
      section: insert,
      run: (v, at) => {
        v.dispatch({ changes: { from: at, insert: "[[]]" }, selection: EditorSelection.cursor(at + 2) });
        startCompletion(v);
      },
    },
    { label: "Table", words: "grid", section: insert, run: (v, at) => block(v, at, TABLE, TABLE.lastIndexOf("\n") + 3) },
    { label: "Code block", words: "pre fence", section: insert, run: (v, at) => block(v, at, "```\n\n```", 4) },
    {
      label: "Callout",
      words: "note tip admonition",
      section: insert,
      run: (v, at) => block(v, at, "> [!note] \n> ", "> [!note] \n> ".length),
    },
    {
      label: "Diagram",
      words: "mermaid chart flowchart",
      section: insert,
      run: (v, at) => block(v, at, "```mermaid\nflowchart LR\n  A --> B\n```", "```mermaid\nflowchart LR\n  ".length),
    },
    { label: "Divider", words: "hr rule line", section: insert, run: (v, at) => block(v, at, "---\n", 4) },
    {
      label: "Today's date",
      words: "date now",
      section: insert,
      run: (v, at) => {
        const d = today();
        v.dispatch({ changes: { from: at, insert: d }, selection: EditorSelection.cursor(at + d.length) });
      },
    },
  ];
  if (actions.image) list.push({ label: "Image", words: "picture photo attachment", section: insert, run: () => actions.image!() });
  if (actions.drawing) list.push({ label: "Drawing", words: "sketch canvas pen", section: insert, run: () => actions.drawing!() });
  if (actions.voice) list.push({ label: "Voice note", words: "dictate speak mic", section: insert, run: () => actions.voice!() });
  if (actions.template) list.push({ label: "Template", words: "snippet", section: insert, run: () => actions.template!() });
  return list;
}

/** The completion source: `/` and what follows it, at a line start or after a space, outside code. */
export function slashCommands(actions: SlashActions) {
  const all = commands(actions);
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/(?:^|\s)\/[\w ]{0,20}$/);
    if (!m) return null;
    const slash = m.from + m.text.indexOf("/");
    const typed = m.text.slice(m.text.indexOf("/") + 1).toLowerCase();
    // A space only belongs to a command name ("/heading 2"), never starts one.
    if (typed.startsWith(" ") || inCode(ctx.state, slash)) return null;
    const words = typed.trim().split(/\s+/).filter(Boolean);
    const found = all.filter((c) => {
      const hay = `${c.label} ${c.words}`.toLowerCase();
      return words.every((w) => hay.split(" ").some((h) => h.startsWith(w)));
    });
    if (!found.length) return null;
    const options: Completion[] = found.map((c, i) => ({
      label: c.label,
      section: c.section,
      boost: -i,
      apply: (view, _c, _from, to) => {
        // The slash and what was typed go; the command works where they were.
        view.dispatch({ changes: { from: slash, to }, selection: EditorSelection.cursor(slash) });
        c.run(view, slash);
        view.focus();
      },
    }));
    return { from: slash + 1, options, filter: false };
  };
}
