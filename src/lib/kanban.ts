// Boards in the Obsidian Kanban plugin's Markdown format, so the same file opens in either app:
//
//   ---
//
//   kanban-plugin: basic
//
//   ---
//
//   ## To do
//
//   - [ ] Card text with [[links]] and #tags
//
//   %% kanban:settings
//   ```
//   {"kanban-plugin":"basic"}
//   ```
//   %%
//
// Anything after the lanes (archive, settings) is kept as written.

export interface Card {
  id: string;
  text: string;
  done: boolean;
}

export interface Lane {
  id: string;
  title: string;
  /** Lane marked `**Complete**`: cards moved here are ticked. */
  complete: boolean;
  cards: Card[];
}

export interface Board {
  frontmatter: string;
  lanes: Lane[];
  tail: string;
}

let seq = 0;
const id = () => `k${++seq}`;

export const TEMPLATE = `---

kanban-plugin: basic

---

## To do



## Doing



## Done

**Complete**


%% kanban:settings
\`\`\`
{"kanban-plugin":"basic"}
\`\`\`
%%
`;

export function isBoard(text: string) {
  if (!text.startsWith("---")) return false;
  const end = text.indexOf("\n---", 3);
  return /^\s*kanban-plugin:/m.test(text.slice(3, end < 0 ? undefined : end));
}

export function parse(text: string): Board {
  const lines = text.split("\n");
  let i = 0;
  let frontmatter = "";
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      frontmatter = lines.slice(0, end + 1).join("\n");
      i = end + 1;
    }
  }
  const lanes: Lane[] = [];
  let lane: Lane | null = null;
  let card: Card | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("***") || line.startsWith("%% kanban:settings")) break;
    const heading = /^## (.*)$/.exec(line);
    if (heading) {
      lane = { id: id(), title: heading[1].trim(), complete: false, cards: [] };
      lanes.push(lane);
      card = null;
      continue;
    }
    if (!lane) continue;
    if (line.trim() === "**Complete**") {
      lane.complete = true;
      continue;
    }
    const item = /^[-*+] \[([ xX])\] ?(.*)$/.exec(line);
    if (item) {
      card = { id: id(), text: item[2], done: item[1] !== " " };
      lane.cards.push(card);
      continue;
    }
    // Indented continuation lines belong to the card above.
    if (card && /^(\t| {2,})\S/.test(line)) {
      card.text += "\n" + line.trim();
      continue;
    }
    if (line.trim()) card = null;
  }
  const tail = lines.slice(i).join("\n");
  return { frontmatter, lanes, tail };
}

export function serialize(board: Board) {
  const parts: string[] = [];
  if (board.frontmatter) parts.push(board.frontmatter, "");
  for (const lane of board.lanes) {
    parts.push(`## ${lane.title}`, "");
    if (lane.complete) parts.push("**Complete**");
    for (const c of lane.cards) {
      const [first, ...rest] = c.text.split("\n");
      parts.push(`- [${c.done ? "x" : " "}] ${first}`, ...rest.map((r) => `\t${r}`));
    }
    parts.push("", "");
  }
  let out = parts.join("\n");
  if (board.tail.trim()) out += "\n" + board.tail.replace(/^\n+/, "");
  else out = out.replace(/\n+$/, "\n");
  return out;
}

export function newCard(text: string): Card {
  return { id: id(), text, done: false };
}

export function newLane(title: string): Lane {
  return { id: id(), title, complete: false, cards: [] };
}

// Tag letters as the Rust index reads them (its \w is Unicode), so #café is "café", not "caf".
export const TAG = /(^|\s)#([A-Za-z][\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}/-]*)/gu;
export const LINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

export function tagsOf(text: string) {
  return [...text.matchAll(TAG)].map((m) => m[2]);
}

/** Splits card text into plain runs, [[links]] and #tags for display. */
export function tokens(text: string) {
  const out: ({ kind: "text"; text: string } | { kind: "link"; target: string; label: string } | { kind: "tag"; tag: string })[] = [];
  const re = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]|(^|\s)#([A-Za-z][\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}/-]*)/gu;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index!;
    if (m[1] !== undefined) {
      if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
      out.push({ kind: "link", target: m[1].trim(), label: (m[2] ?? m[1]).trim() });
    } else {
      const lead = m[3] ?? "";
      if (start + lead.length > last) out.push({ kind: "text", text: text.slice(last, start + lead.length) });
      out.push({ kind: "tag", tag: m[4] });
    }
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
