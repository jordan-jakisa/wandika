import assert from "node:assert/strict";
import type { EditorView } from "@codemirror/view";
import { test } from "vitest";
import { properties } from "./properties.ts";
import { blur, decorations, focus, mousedown, select, show, viewOf } from "./testing.ts";

const FM = "---\ntitle: Kampala trip\ntags: [travel, \"#uganda\"]\naliases:\n  - Trip\nlink: \"[[Plan|the plan]]\"\nowner: \"[[Jo]]\"\ndue:\n---";
const setup = (marked: string) => viewOf(marked, [properties]);
const panel = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-properties");
const rows = (view: EditorView) =>
  [...panel(view)!.querySelectorAll(".cm-prop")].map((row) => {
    const value = row.querySelector(".cm-prop-value")!;
    const chips = [...value.querySelectorAll(".cm-prop-chip")].map((c) => c.textContent);
    return [row.querySelector(".cm-prop-key")!.textContent, chips.length ? chips : value.textContent];
  });

test("frontmatter shows as a list of properties", () => {
  const view = setup(`${FM}\nBody‸`);
  assert.deepEqual(decorations(view).map((d) => [d.kind, d.text]), [["Properties", FM]]);
  assert.deepEqual(rows(view), [
    ["title", "Kampala trip"],
    ["tags", ["#travel", "#uganda"]],
    ["aliases", ["Trip"]],
    ["link", "the plan"],
    ["owner", "Jo"],
    ["due", "Empty"],
  ]);
});

test("the panel is a labelled group that says how to edit it", () => {
  const view = setup(`${FM}\nBody‸`);
  assert.equal(panel(view)!.getAttribute("role"), "group");
  assert.equal(panel(view)!.getAttribute("aria-label"), "Properties. Move the cursor here, or click, to edit them.");
});

test("an empty value is marked as empty", () => {
  const view = setup("---\ndue:\n---\n‸");
  assert.ok(panel(view)!.querySelector(".cm-prop-value")!.classList.contains("cm-prop-empty"));
});

test("a property with several values shows chips; one value shows as text", () => {
  const view = setup("---\npeople: [Ann, Bob]\nplace: [Kampala]\n---\n‸");
  assert.deepEqual(rows(view), [
    ["people", ["Ann", "Bob"]],
    ["place", "Kampala"],
  ]);
});

test("empty frontmatter shows a Properties label", () => {
  const view = setup("---\n---\nBody‸");
  assert.equal(panel(view)!.textContent, "Properties");
  assert.equal(panel(view)!.querySelectorAll(".cm-prop").length, 0);
});

test("frontmatter with only comments shows a Properties label", () => {
  const view = setup("---\n# nothing yet\n---\n‸");
  assert.equal(panel(view)!.textContent, "Properties");
});

test("unicode keys and values show as written", () => {
  const view = setup("---\ntítulo: Café ☕\n---\n‸");
  assert.deepEqual(rows(view), [["título", "Café ☕"]]);
});

test("a note without frontmatter has no panel", () => {
  for (const doc of ["‸", "Body‸", "--- \na: 1\n---‸", "\n---\na: 1\n---‸"]) {
    assert.deepEqual(decorations(setup(doc)), [], JSON.stringify(doc));
  }
});

test("frontmatter that never closes is left as text", () => {
  assert.deepEqual(decorations(setup("---\na: 1\nBody‸")), []);
});

test("frontmatter is only looked for in the first 200 lines", () => {
  const long = Array.from({ length: 200 }, (_, i) => `k${i}: v`).join("\n");
  assert.deepEqual(decorations(setup(`---\n${long}\n---\n‸`)), []);
  const fits = Array.from({ length: 197 }, (_, i) => `k${i}: v`).join("\n");
  assert.equal(decorations(setup(`---\n${fits}\n---\n‸`)).length, 1);
});

test("the YAML shows while the focused cursor is in it", async () => {
  const view = setup(`${FM}\nBody‸`);
  await focus(view);
  assert.ok(panel(view));
  select(view, `---\ntitle: Kam‸pala trip${FM.slice(23)}\nBody`);
  assert.ok(!panel(view));
  select(view, `${FM}‸\nBody`);
  assert.ok(!panel(view), "the end of the closing --- is still in the frontmatter");
  select(view, `${FM}\n‸Body`);
  assert.ok(panel(view));
});

test("an unfocused editor shows the panel even with the cursor in the YAML", async () => {
  const view = setup(`---\nti‸tle: x\n---\nBody`);
  assert.ok(panel(view));
  await focus(view);
  assert.ok(!panel(view));
  await blur(view);
  assert.ok(panel(view));
});

test("tapping the panel puts the cursor at the end of the first property", async () => {
  const view = setup(`${FM}\nBody‸`);
  await focus(view);
  assert.ok(mousedown(panel(view)!).defaultPrevented);
  assert.equal(show(view.state), `---\ntitle: Kampala trip‸${FM.slice(23)}\nBody`);
  assert.ok(!panel(view));
});

test("tapping an empty frontmatter's panel puts the cursor on its closing line", async () => {
  const view = setup("---\n---\nBody‸");
  await focus(view);
  mousedown(panel(view)!);
  assert.equal(show(view.state), "---\n---‸\nBody");
  assert.ok(!panel(view));
});

test("editing the YAML updates the panel", () => {
  const view = setup("---\na: 1\n---\n‸");
  view.dispatch({ changes: { from: 7, to: 8, insert: "2" } });
  assert.deepEqual(rows(view), [["a", "2"]]);
});

test("typing frontmatter at the top of a note turns it into a panel", () => {
  const view = setup("‸Body");
  view.dispatch({ changes: { from: 0, insert: "---\na: 1\n---\n" } });
  assert.ok(panel(view));
});
