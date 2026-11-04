import { expect, test } from "vitest";
import { noteHtml } from "./printNote";

test("headings sit one level under the note's title, and properties don't print", () => {
  expect(noteHtml("---\ntags: [a]\n---\n# Plan\n\nSome *text* and **bold**.")).toBe(
    "<h2>Plan</h2>\n<p>Some <em>text</em> and <strong>bold</strong>.</p>",
  );
});

test("lists, nested lists and task boxes", () => {
  const html = noteHtml("- one\n  - two\n- [x] done\n- [ ] open\n\n3. c\n4. d");
  expect(html).toContain("<ul><li>one<ul><li>two</li></ul></li>");
  expect(html).toContain('<li class="task done"><span class="box" aria-hidden="true">☑</span><span class="label">done</span></li>');
  expect(html).toContain('<li class="task"><span class="box" aria-hidden="true">☐</span><span class="label">open</span></li>');
  expect(html).toContain('<ol start="3"><li>c</li><li>d</li></ol>');
});

test("Obsidian links print as their names, highlights as marks, comments not at all", () => {
  expect(noteHtml("See [[Projects/Plan|the plan]], [[Ideas#Later]] and ==this== %%hidden%%.")).toBe(
    '<p>See <span class="wikilink">the plan</span>, <span class="wikilink">Ideas › Later</span> and <mark>this</mark> .</p>',
  );
});

test("a link after bold text prints once", () => {
  expect(noteHtml("Pack **light** and see [[Plan|the plan]].")).toBe(
    '<p>Pack <strong>light</strong> and see <span class="wikilink">the plan</span>.</p>',
  );
});

test("vault images are marked for loading; web images and links stay, other schemes don't", () => {
  const html = noteHtml("![[Sketch.svg]] ![alt](attachments/a%20b.png) ![w](https://x.org/i.png)\n\n[site](https://x.org) [bad](javascript:alert(1))");
  expect(html).toContain('<img data-embed="Sketch.svg" alt="Sketch.svg">');
  expect(html).toContain('<img data-embed="attachments/a b.png" alt="alt">');
  expect(html).toContain('<img src="https://x.org/i.png" alt="w">');
  expect(html).toContain('<a href="https://x.org">site</a>');
  expect(html).toContain(" bad</p>");
  expect(html).not.toContain("javascript");
});

test("HTML in a note prints as text, never as markup", () => {
  const html = noteHtml('<script>alert(1)</script>\n\nHi <img src=x onerror="alert(1)"> there<br>');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("<br>");
});

test("code, tables, quotes, callouts and diagrams", () => {
  const html = noteHtml(
    "```js\nlet a = 1 < 2\n```\n\n| A | B |\n|---|---|\n| 1 | *2* |\n\n> quoted\n\n> [!tip] Remember\n> Pack light\n\n```mermaid\ngraph TD; A-->B\n```",
  );
  expect(html).toContain("<pre><code>let a = 1 &lt; 2</code></pre>");
  expect(html).toContain("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><em>2</em></td></tr></tbody></table>");
  expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
  expect(html).toContain('<aside class="callout"><p class="callout-title">Remember</p><p>Pack light</p></aside>');
  expect(html).toContain('<div class="diagram" data-source="graph TD; A--&gt;B"></div>');
});
