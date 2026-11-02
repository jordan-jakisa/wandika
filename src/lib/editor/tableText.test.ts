import assert from "node:assert/strict";
import { test } from "node:test";
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
