// Turning selected lines into bullets, numbers, a checklist, a quote or plain text. Pure functions,
// so they can be tested without an editor.

export type LineKind = "bullet" | "numbered" | "task" | "quote" | "plain";

const LINE = /^(\s*)(?:([-*+])\s+\[([ xX])\]\s+|([-*+])\s+|(\d+)[.)]\s+|>\s?)?(.*)$/;

interface Parsed {
  indent: string;
  kind: LineKind;
  done: boolean;
  text: string;
}

function parse(line: string): Parsed {
  const m = LINE.exec(line)!;
  const [, indent, taskMark, check, bullet, num, text] = m;
  const kind: LineKind = taskMark ? "task" : bullet ? "bullet" : num ? "numbered" : line.trimStart().startsWith(">") ? "quote" : "plain";
  return { indent, kind, done: !!check && check !== " ", text };
}

const width = (indent: string) => indent.replace(/\t/g, "    ").length;

/**
 * Converts lines to `kind`. Blank lines stay blank. When some lines are already list items, lines
 * indented deeper than those items and not items themselves are treated as their descriptions and
 * left alone. Converting lines that are all already `kind` turns them back into plain text.
 */
export function convertLines(lines: string[], kind: LineKind): string[] {
  const parsed = lines.map(parse);
  const listed = parsed.filter((p) => p.kind !== "plain" && p.kind !== "quote");
  const itemIndent = listed.length ? Math.min(...listed.map((p) => width(p.indent))) : Infinity;
  const isContinuation = (p: Parsed, raw: string) =>
    !raw.trim() || (listed.length > 0 && p.kind === "plain" && width(p.indent) > itemIndent);

  const targets = parsed.filter((p, i) => !isContinuation(p, lines[i]));
  const target: LineKind = targets.length > 0 && targets.every((p) => p.kind === kind) ? "plain" : kind;

  // Numbering restarts at each indent level, and deeper levels restart under a new parent.
  const counters = new Map<number, number>();
  return parsed.map((p, i) => {
    const raw = lines[i];
    if (isContinuation(p, raw)) return raw;
    const level = width(p.indent);
    for (const k of [...counters.keys()]) if (k > level) counters.delete(k);
    switch (target) {
      case "bullet":
        return `${p.indent}- ${p.text}`;
      case "task":
        return `${p.indent}- [${p.done ? "x" : " "}] ${p.text}`;
      case "numbered": {
        const n = (counters.get(level) ?? 0) + 1;
        counters.set(level, n);
        return `${p.indent}${n}. ${p.text}`;
      }
      case "quote":
        return `${p.indent}> ${p.text}`;
      case "plain":
        return `${p.indent}${p.text}`;
    }
  });
}

/** Wraps text in a Markdown mark, or removes the mark when the text already has it. */
export function toggleWrap(text: string, mark: string): string {
  if (text.length >= mark.length * 2 && text.startsWith(mark) && text.endsWith(mark)) {
    return text.slice(mark.length, text.length - mark.length);
  }
  // Keep surrounding spaces outside the marks, or Markdown won't render them.
  const lead = text.match(/^\s*/)![0];
  const trail = text.match(/\s*$/)![0];
  const core = text.slice(lead.length, text.length - trail.length);
  return core ? `${lead}${mark}${core}${mark}${trail}` : text;
}
