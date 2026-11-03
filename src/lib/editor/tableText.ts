// Pure helpers for Markdown tables, kept free of CodeMirror so they can be unit-tested.

export type Align = "left" | "center" | "right" | null;

/** Splits a table row on unescaped pipes outside code spans; `\|` becomes a literal pipe. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "`") code = !code;
    if (c === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

export function alignOf(cell: string): Align {
  const c = cell.trim();
  if (!/^:?-+:?$/.test(c)) return null;
  if (c.startsWith(":") && c.endsWith(":")) return "center";
  if (c.endsWith(":")) return "right";
  if (c.startsWith(":")) return "left";
  return null;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The inline Markdown a table cell can hold, as escaped HTML. */
export function inline(md: string): string {
  return md
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (/^`[^`]*`$/.test(part)) return `<code>${escape(part.slice(1, -1))}</code>`;
      return escape(part)
        .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) =>
          `<span class="cm-wikilink" data-target="${target.trim()}">${(alias ?? target).trim()}</span>`)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) =>
          `<span class="cm-md-link" data-href="${href}">${text}</span>`)
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
        .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>")
        .replace(/~~(.+?)~~/g, "<s>$1</s>")
        .replace(/(^|\s)#([A-Za-z][\w/-]*)/g, '$1<span class="cm-tag" data-tag="$2">#$2</span>');
    })
    .join("");
}
