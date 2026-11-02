import assert from "node:assert/strict";
import { test } from "node:test";
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
