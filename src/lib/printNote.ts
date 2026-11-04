// A note as a clean page for PDF export: the Markdown rendered to HTML, with Obsidian's links,
// embeds, highlights, task boxes and callouts. Everything from the note is escaped; raw HTML in
// a note prints as text, and only web and mail links stay clickable.

import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeHref = (url: string) => (/^(https?:|mailto:)/i.test(url.trim()) ? url.trim() : null);
const MARKS = new Set([
  "EmphasisMark",
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "CodeMark",
  "CodeInfo",
  "LinkMark",
  "StrikethroughMark",
  "TaskMarker",
  "TableDelimiter",
  "LinkTitle",
  "LinkLabel",
]);

/** Plain text with Obsidian's highlights and %% comments %%. */
function text(s: string): string {
  let out = "";
  const re = /==([^=\n]+)==|%%[^%]*%%/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    out += esc(s.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) out += `<mark>${esc(m[1])}</mark>`;
  }
  return out + esc(s.slice(at));
}

/** An Obsidian [[link]] prints as its name; an ![[image]] embed as the image. */
const WIKI = /(!?)\[\[([^\]\n]+?)\]\]/;
function wiki(embed: boolean, inner: string): string {
  const [target, alias] = inner.split("|");
  const name = target.split("#")[0].trim();
  if (embed && /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name)) return `<img data-embed="${esc(name)}" alt="${esc(alias ?? name)}">`;
  return `<span class="wikilink">${esc((alias ?? target.replace(/#/g, " › ")).trim())}</span>`;
}

export function noteHtml(markdown: string): string {
  // Properties at the top are for Obsidian and Wandika, not for the page.
  const src = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
  const tree = markdownLanguage.parser.parse(src);
  const slice = (n: SyntaxNode) => src.slice(n.from, n.to);
  const kids = (n: SyntaxNode) => {
    const out: SyntaxNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) out.push(c);
    return out;
  };

  // The Markdown parser reads [[a]] as brackets around a link, so wiki links are cut out first.
  function inline(n: SyntaxNode, from = n.from, to = n.to): string {
    let out = "";
    let pos = from;
    const part = src.slice(from, to);
    // A regex of its own: the nested calls for bold or italics run their own search.
    const re = new RegExp(WIKI.source, "g");
    for (let m = re.exec(part); m; m = re.exec(part)) {
      out += range(n, pos, from + m.index) + wiki(!!m[1], m[2]);
      pos = from + m.index + m[0].length;
    }
    return out + range(n, pos, to);
  }

  function range(n: SyntaxNode, from: number, to: number): string {
    let out = "";
    let pos = from;
    for (const c of kids(n)) {
      if (c.to <= from || c.from >= to) continue;
      const a = Math.max(c.from, from);
      const b = Math.min(c.to, to);
      if (a > pos) out += text(src.slice(pos, a));
      // A node cut by a wiki link prints as its text.
      out += a === c.from && b === c.to ? inlineNode(c) : text(src.slice(a, b));
      pos = b;
    }
    if (pos < to) out += text(src.slice(pos, to));
    return out;
  }

  function inlineNode(n: SyntaxNode): string {
    if (MARKS.has(n.name)) return "";
    switch (n.name) {
      case "Emphasis":
        return `<em>${inline(n)}</em>`;
      case "StrongEmphasis":
        return `<strong>${inline(n)}</strong>`;
      case "Strikethrough":
        return `<del>${inline(n)}</del>`;
      case "InlineCode": {
        const marks = kids(n).filter((c) => c.name === "CodeMark");
        return `<code>${esc(src.slice(marks[0]?.to ?? n.from, marks[1]?.from ?? n.to))}</code>`;
      }
      case "Link": {
        const marks = kids(n).filter((c) => c.name === "LinkMark");
        const url = kids(n).find((c) => c.name === "URL");
        const label = marks.length >= 2 ? inline(n, marks[0].to, marks[1].from) : esc(slice(n));
        const href = url ? safeHref(slice(url)) : null;
        return href ? `<a href="${esc(href)}">${label}</a>` : label;
      }
      case "Image": {
        const marks = kids(n).filter((c) => c.name === "LinkMark");
        const url = kids(n).find((c) => c.name === "URL");
        const alt = marks.length >= 2 ? src.slice(marks[0].to, marks[1].from) : "";
        if (!url) return esc(alt);
        const u = slice(url).trim();
        if (/^https:/i.test(u)) return `<img src="${esc(u)}" alt="${esc(alt)}">`;
        if (/^[a-z]+:/i.test(u)) return esc(alt);
        return `<img data-embed="${esc(decodeURI(u))}" alt="${esc(alt)}">`;
      }
      case "Autolink":
      case "URL": {
        const u = slice(n).replace(/^<|>$/g, "");
        const href = safeHref(u) ?? (/^www\./i.test(u) ? `https://${u}` : null);
        return href ? `<a href="${esc(href)}">${esc(u)}</a>` : esc(u);
      }
      case "Escape":
        return esc(slice(n).slice(1));
      case "Entity":
        return /^&(#\d+|#x[\da-f]+|\w+);$/i.test(slice(n)) ? slice(n) : esc(slice(n));
      case "HardBreak":
        return "<br>";
      case "HTMLTag":
        return /^<br\s*\/?>$/i.test(slice(n)) ? "<br>" : esc(slice(n));
      default:
        return inline(n);
    }
  }

  const blocks = (n: SyntaxNode) =>
    kids(n)
      .map(block)
      .filter(Boolean)
      .join("\n");

  function listItem(n: SyntaxNode): string {
    const parts = kids(n).filter((c) => c.name !== "ListMark");
    const task = parts.find((c) => c.name === "Task");
    if (task) {
      const marker = kids(task).find((c) => c.name === "TaskMarker");
      const done = marker ? /\[[xX]\]/.test(slice(marker)) : false;
      const rest = parts.filter((c) => c.from !== task.from).map(block).join("");
      const label = inline(task, marker?.to ?? task.from).trim();
      return `<li class="task${done ? " done" : ""}"><span class="box" aria-hidden="true">${done ? "☑" : "☐"}</span><span class="label">${label}</span>${rest}</li>`;
    }
    // The item's own text prints without a paragraph's gap; nested lists follow it.
    return `<li>${parts.map((c, i) => (i === 0 && c.name === "Paragraph" ? inline(c).trim() : block(c))).join("")}</li>`;
  }

  function block(n: SyntaxNode): string {
    const h = /^(?:ATX|Setext)Heading(\d)$/.exec(n.name);
    // The note's title is the page's h1, so its headings sit one level lower (h6 stays h6).
    if (h) {
      const level = Math.min(Number(h[1]) + 1, 6);
      return `<h${level}>${inline(n).trim()}</h${level}>`;
    }
    switch (n.name) {
      case "Paragraph":
        return `<p>${inline(n).trim()}</p>`;
      case "Blockquote": {
        const first = kids(n).find((c) => c.name === "Paragraph");
        const callout = first ? /^\[!(\w+)\][+-]?[ \t]*(.*)/.exec(slice(first).replace(/^>\s?/, "")) : null;
        if (callout && first) {
          const lineEnd = src.indexOf("\n", first.from);
          const title = callout[2].trim() || callout[1][0].toUpperCase() + callout[1].slice(1).toLowerCase();
          const body = lineEnd >= 0 && lineEnd < first.to ? `<p>${inline(first, lineEnd + 1).trim()}</p>` : "";
          const rest = kids(n).filter((c) => c.from !== first.from).map(block).filter(Boolean).join("\n");
          return `<aside class="callout"><p class="callout-title">${text(title)}</p>${body}${rest}</aside>`;
        }
        return `<blockquote>${blocks(n)}</blockquote>`;
      }
      case "BulletList":
        return `<ul>${kids(n).map(listItem).join("")}</ul>`;
      case "OrderedList": {
        const start = Number(/^\s*(\d+)/.exec(slice(n))?.[1] ?? 1);
        return `<ol${start !== 1 ? ` start="${start}"` : ""}>${kids(n).map(listItem).join("")}</ol>`;
      }
      case "FencedCode": {
        const info = kids(n).find((c) => c.name === "CodeInfo");
        const code = kids(n).find((c) => c.name === "CodeText");
        const body = code ? slice(code) : "";
        if (info && slice(info).trim().toLowerCase() === "mermaid") return `<div class="diagram" data-source="${esc(body)}"></div>`;
        return `<pre><code>${esc(body)}</code></pre>`;
      }
      case "CodeBlock":
        return `<pre><code>${esc(slice(n).replace(/^( {4}|\t)/gm, ""))}</code></pre>`;
      case "HorizontalRule":
        return "<hr>";
      case "Table": {
        const rows = kids(n).filter((c) => c.name === "TableHeader" || c.name === "TableRow");
        const cells = (r: SyntaxNode, tag: string) =>
          kids(r)
            .filter((c) => c.name === "TableCell")
            .map((c) => `<${tag}>${inline(c).trim()}</${tag}>`)
            .join("");
        const head = rows.find((r) => r.name === "TableHeader");
        const body = rows.filter((r) => r.name === "TableRow");
        return `<table>${head ? `<thead><tr>${cells(head, "th")}</tr></thead>` : ""}<tbody>${body.map((r) => `<tr>${cells(r, "td")}</tr>`).join("")}</tbody></table>`;
      }
      case "HTMLBlock":
        return `<p>${esc(slice(n))}</p>`;
      case "LinkReference":
      case "CommentBlock":
      case "ProcessingInstructionBlock":
        return "";
      default:
        return kids(n).length ? blocks(n) : "";
    }
  }

  return blocks(tree.topNode);
}
