import assert from "node:assert/strict";
import { test } from "vitest";
import { parseProperties, renderLite, section } from "./noteText.ts";

const note = "---\ntags: [a]\n---\n# Plan\nIntro\n## Goals\n- Ship\n### Detail\nmore\n## Risks\nRain ^r1\n";

test("an embed picks a heading's section or a block by its id", () => {
  assert.equal(section(note, "Goals"), "## Goals\n- Ship\n### Detail\nmore");
  assert.equal(section(note, "^r1"), "Rain");
  assert.equal(section(note, "Nope"), "");
  assert.ok(!section(note, undefined).includes("tags"));
});

test("embedded Markdown is escaped before it becomes HTML", () => {
  const { html } = renderLite("<script>x</script> **bold** [[Plan|the plan]]\n- [x] done");
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("the plan"));
  assert.ok(html.includes("☑ done"));
});

test("an embedded callout keeps its title", () => {
  assert.ok(renderLite("> [!tip]\n> Long-press a note").html.includes(">Tip<"));
});

test("frontmatter reads as properties: scalars, inline lists and dash lists", () => {
  const yaml = 'title: "Kampala trip"\ntags: [travel, uganda]\naliases:\n  - Trip\n  - Safari\ndue: 2026-11-20\nempty:';
  assert.deepEqual(parseProperties(yaml), [
    { key: "title", values: ["Kampala trip"] },
    { key: "tags", values: ["travel", "uganda"] },
    { key: "aliases", values: ["Trip", "Safari"] },
    { key: "due", values: ["2026-11-20"] },
    { key: "empty", values: [] },
  ]);
});

test("without a part, an embed shows the whole note minus its frontmatter", () => {
  assert.equal(section("# Plan\nIntro", undefined), "# Plan\nIntro");
  assert.equal(section("---\na: 1\n---\nBody", undefined), "Body");
  assert.equal(section("", undefined), "");
});

test("a heading's section runs to the next heading of the same or a higher level", () => {
  assert.equal(section(note, "Plan"), "# Plan\nIntro\n## Goals\n- Ship\n### Detail\nmore\n## Risks\nRain ^r1\n");
  assert.equal(section(note, "Detail"), "### Detail\nmore");
  assert.equal(section(note, "Risks"), "## Risks\nRain ^r1\n");
});

test("heading names match without regard to case or spacing", () => {
  assert.equal(section(note, "  goals "), "## Goals\n- Ship\n### Detail\nmore");
  assert.equal(section("## Café ☕\nyes", "café ☕"), "## Café ☕\nyes");
});

test("a block id keeps trailing spaces out and a missing id gives nothing", () => {
  assert.equal(section("Rain ^r1  \nnext", "^r1"), "Rain  ");
  assert.equal(section("Rain ^r1", "^r2"), "");
  assert.equal(section("Rain^r1", "^r1"), "");
});

test("embedded lines render as headings, lists, quotes and paragraphs", () => {
  const { html, more } = renderLite("## Title\n\n- one\n  * two\n3) three\n> quoted\nplain");
  assert.equal(
    html,
    '<div class="h h2">Title</div>' +
      '<div class="gap"></div>' +
      '<div class="li" style="--depth:0">• one</div>' +
      '<div class="li" style="--depth:2">• two</div>' +
      '<div class="li" style="--depth:0">3) three</div>' +
      '<div class="q">quoted</div>' +
      "<p>plain</p>",
  );
  assert.equal(more, false);
});

test("open tasks get an empty box and done tasks a ticked one", () => {
  assert.equal(renderLite("- [ ] todo").html, '<div class="li" style="--depth:0">☐ todo</div>');
  assert.equal(renderLite("  - [X] done").html, '<div class="li done" style="--depth:2">☑ done</div>');
});

test("code fences show their lines as escaped preformatted text", () => {
  assert.equal(renderLite("```js\nif (a < b) {}\n# not a heading\n```\nafter").html, "<pre>if (a &lt; b) {}</pre><pre># not a heading</pre><p>after</p>");
});

test("an embed shows forty lines by default and says when there is more", () => {
  const long = Array.from({ length: 41 }, (_, i) => `line ${i + 1}`).join("\n");
  const shown = renderLite(long);
  assert.equal(shown.more, true);
  assert.ok(shown.html.includes("line 40"));
  assert.ok(!shown.html.includes("line 41"));
  assert.equal(renderLite(long, 41).more, false);
  assert.equal(renderLite("a\nb", 1).html, "<p>a</p>");
});

test("an empty embed renders as a single gap", () => {
  assert.deepEqual(renderLite(""), { html: '<div class="gap"></div>', more: false });
});

test("inline marks render, and links show their alias or the note's own name", () => {
  const { html } = renderLite("`a<b` **b** *i* ~~s~~ [[Folder/Note#Part]] [[X|alias]] ![[pic.png|200]]");
  assert.equal(html, "<p><code>a&lt;b</code> <strong>b</strong> <em>i</em> <s>s</s> Note alias pic.png</p>");
});

test("quotes in embedded text are escaped", () => {
  assert.equal(renderLite('say "hi" & <wave>').html, "<p>say &quot;hi&quot; &amp; &lt;wave&gt;</p>");
});

test("a callout without a title shows its type, capitalised, and fold marks are dropped", () => {
  assert.equal(renderLite("> [!warning]- Mind the gap").html, '<div class="q title">Mind the gap</div>');
  assert.equal(renderLite("> [!note]+").html, '<div class="q title">Note</div>');
});

test("properties: quotes, comments, colons in values and stray list items", () => {
  const yaml = "- orphan\n# comment\nurl: https://example.com/a:b\nname: 'Jo'\nlist: ['a', \"b\", ]\nnone: []\nkids:\n  -\n  - one";
  assert.deepEqual(parseProperties(yaml), [
    { key: "url", values: ["https://example.com/a:b"] },
    { key: "name", values: ["Jo"] },
    { key: "list", values: ["a", "b"] },
    { key: "none", values: [] },
    { key: "kids", values: ["one"] },
  ]);
});

test("properties: nested keys are skipped and empty YAML gives none", () => {
  assert.deepEqual(parseProperties(""), []);
  assert.deepEqual(parseProperties("place:\n  city: Kampala"), [{ key: "place", values: [] }]);
});

test("properties keep unicode keys and values", () => {
  assert.deepEqual(parseProperties("título: Café ☕"), [{ key: "título", values: ["Café ☕"] }]);
});
