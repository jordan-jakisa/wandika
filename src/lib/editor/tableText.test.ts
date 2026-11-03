import assert from "node:assert/strict";
import { test } from "vitest";
import { alignOf, inline, splitRow } from "./tableText.ts";

test("rows split on pipes outside code and escapes", () => {
  assert.deepEqual(splitRow("| `00_Inbox/` | Capture | a \\| b |"), ["`00_Inbox/`", "Capture", "a | b"]);
  assert.deepEqual(splitRow("| `a|b` | c |"), ["`a|b`", "c"]);
  assert.deepEqual(splitRow("no | outer | pipes"), ["no", "outer", "pipes"]);
});

test("delimiter cells give alignment", () => {
  assert.deepEqual(["---", ":--", "--:", ":-:"].map(alignOf), [null, "left", "right", "center"]);
});

test("cells render inline Markdown as escaped HTML", () => {
  assert.equal(inline("**Triage** now"), "<strong>Triage</strong> now");
  assert.equal(inline("`<b>`"), "<code>&lt;b&gt;</code>");
  assert.equal(inline("<script>"), "&lt;script&gt;");
  assert.equal(inline("[[Home|home]]"), '<span class="cm-wikilink" data-target="Home">home</span>');
});

test("empty cells are kept, and a row without pipes is one cell", () => {
  assert.deepEqual(splitRow("| a || b |"), ["a", "", "b"]);
  assert.deepEqual(splitRow("| |"), [""]);
  assert.deepEqual(splitRow("just text"), ["just text"]);
  assert.deepEqual(splitRow(""), [""]);
});

test("an escaped pipe at the end of a row stays in the last cell", () => {
  assert.deepEqual(splitRow("| a | b \\|"), ["a", "b |"]);
});

test("cells keep unicode and lose surrounding spaces", () => {
  assert.deepEqual(splitRow("|  Café ☕ |\t日本 |"), ["Café ☕", "日本"]);
});

test("a backslash before anything but a pipe stays", () => {
  assert.deepEqual(splitRow("| C:\\path | \\n |"), ["C:\\path", "\\n"]);
});

test("delimiter cells with spaces still give alignment; other text gives none", () => {
  assert.equal(alignOf("  :---:  "), "center");
  assert.equal(alignOf("-"), null);
  assert.equal(alignOf(":-"), "left");
  assert.equal(alignOf(""), null);
  assert.equal(alignOf("abc"), null);
  assert.equal(alignOf(":"), null);
  assert.equal(alignOf("-:-"), null);
});

test("cells render emphasis, strike and underscore bold", () => {
  assert.equal(inline("*it* and __b__ and ~~gone~~"), "<em>it</em> and <strong>b</strong> and <s>gone</s>");
});

test("a star inside a word is not emphasis", () => {
  assert.equal(inline("2*3*4"), "2*3*4");
  assert.equal(inline("a * b"), "a * b");
});

test("wikilinks drop their heading and keep an alias", () => {
  assert.equal(inline("[[Note#Part]]"), '<span class="cm-wikilink" data-target="Note">Note</span>');
  assert.equal(inline("[[ Note | shown ]]"), '<span class="cm-wikilink" data-target="Note">shown</span>');
});

test("Markdown links keep their address, escaped", () => {
  assert.equal(
    inline("[site](https://x.com/?a=1&b=2)"),
    '<span class="cm-md-link" data-href="https://x.com/?a=1&amp;b=2">site</span>',
  );
});

test("a quote in a link target cannot break out of the attribute", () => {
  assert.equal(inline('[[a"b]]'), '<span class="cm-wikilink" data-target="a&quot;b">a&quot;b</span>');
});

test("marks inside code are left as written", () => {
  assert.equal(inline("`**a**` **b**"), "<code>**a**</code> <strong>b</strong>");
});

test("an empty cell renders as nothing", () => {
  assert.equal(inline(""), "");
});
