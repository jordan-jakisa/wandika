import assert from "node:assert/strict";
import { test } from "node:test";
import { renderLite, section } from "./noteText.ts";

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
