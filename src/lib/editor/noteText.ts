// Plain helpers for embedded notes: pick the part of a note an embed asks for, and turn a few
// lines of Markdown into safe, simple HTML for reading in place.

/** `Note#Heading` gives that section; `Note#^id` the line carrying that block id. */
export function section(text: string, sub: string | undefined): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  if (!sub) return body;
  const lines = body.split("\n");
  if (sub.startsWith("^")) {
    const line = lines.find((l) => l.trimEnd().endsWith(` ${sub}`) || l.trim() === sub);
    return line ? line.replace(` ${sub}`, "") : "";
  }
  const want = sub.trim().toLowerCase();
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === want);
  if (start < 0) return "";
  const level = /^#+/.exec(lines[start])![0].length;
  let end = start + 1;
  while (end < lines.length && !(/^#{1,6}\s/.test(lines[end]) && /^#+/.exec(lines[end])![0].length <= level)) end++;
  return lines.slice(start, end).join("\n");
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string) {
  return escape(s)
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_, t: string) => t.split("#")[0].split("/").pop()!)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>");
}

/** Up to `max` lines of Markdown as HTML. Everything is escaped before any tag is added. */
export function renderLite(md: string, max = 40): { html: string; more: boolean } {
  const lines = md.split("\n");
  const out: string[] = [];
  let fence = false;
  for (const raw of lines.slice(0, max)) {
    if (/^\s*```/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      out.push(`<pre>${escape(raw)}</pre>`);
      continue;
    }
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if (!line.trim()) out.push('<div class="gap"></div>');
    else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) out.push(`<div class="h h${m[1].length}">${inline(m[2])}</div>`);
    else if ((m = /^(\s*)[-*+] \[([ xX])\] (.*)$/.exec(line)))
      out.push(`<div class="li${m[2] === " " ? "" : " done"}" style="--depth:${m[1].length}">${m[2] === " " ? "☐" : "☑"} ${inline(m[3])}</div>`);
    else if ((m = /^(\s*)[-*+] (.*)$/.exec(line))) out.push(`<div class="li" style="--depth:${m[1].length}">• ${inline(m[2])}</div>`);
    else if ((m = /^(\s*)(\d+[.)]) (.*)$/.exec(line))) out.push(`<div class="li" style="--depth:${m[1].length}">${m[2]} ${inline(m[3])}</div>`);
    else if ((m = /^>\s?(.*)$/.exec(line))) {
      // A callout's first line shows its title, or its type when it has none.
      const callout = /^\[!([\w-]+)\][+-]?\s*(.*)$/.exec(m[1]);
      const text = callout ? callout[2] || callout[1][0].toUpperCase() + callout[1].slice(1) : m[1];
      out.push(`<div class="q${callout ? " title" : ""}">${inline(text)}</div>`);
    }
    else out.push(`<p>${inline(line)}</p>`);
  }
  return { html: out.join(""), more: lines.length > max };
}
