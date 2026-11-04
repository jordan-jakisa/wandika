// PDF export: the note is laid out as a clean page in a print-only part of the document, with its
// images and diagrams in place, then the system takes it from there (see `api.notePrint`).

import { api } from "./api";
import { imageUrl } from "./attachments";
import { noteHtml } from "./printNote";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The print-only part of the page, made the first time it's needed. */
function printRoot() {
  let root = document.getElementById("print-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "print-root";
    document.body.append(root);
  }
  return root;
}

/** Lays out note `path` with its `title` and `markdown` for printing. Exported for tests. */
export async function layOut(path: string, title: string, markdown: string) {
  const root = printRoot();
  root.innerHTML = `<article class="print-note"><h1>${esc(title)}</h1>${noteHtml(markdown)}</article>`;
  const images = [...root.querySelectorAll<HTMLImageElement>("img[data-embed]")].map(async (img) => {
    try {
      img.src = await imageUrl(img.dataset.embed!, path);
      await img.decode().catch(() => {});
    } catch {
      // A picture that isn't on this device yet prints as its name.
      img.replaceWith(document.createTextNode(img.alt));
    }
  });
  const diagrams = [...root.querySelectorAll<HTMLElement>(".diagram[data-source]")].map(async (box, i) => {
    try {
      const { renderAsync } = await import("pele/lazy");
      const { svg } = await renderAsync(box.dataset.source!, { idPrefix: `p${i}-`, responsive: true, links: false, images: false });
      box.innerHTML = svg;
    } catch {
      box.outerHTML = `<pre><code>${esc(box.dataset.source!)}</code></pre>`;
    }
  });
  await Promise.all([...images, ...diagrams]);
  return root;
}

/** Exports a note as a PDF. The PDF's name is the note's title. */
export async function exportPdf(path: string, title: string, markdown: string) {
  await layOut(path, title, markdown);
  const before = document.title;
  document.title = title;
  try {
    await api.notePrint(title);
  } finally {
    // The Mac's print panel reads the title when it opens; give it back after.
    setTimeout(() => (document.title = before), 1500);
  }
}
