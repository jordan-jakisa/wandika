import assert from "node:assert/strict";
import { renderAsync } from "pele/lazy";
import { beforeEach, test, vi } from "vitest";
import { diagrams } from "./diagrams.ts";
import { blur, decorations, focus, md, mousedown, select, viewOf } from "./testing.ts";

// Pele draws with real layout, which jsdom doesn't have; these tests cover what happens around it.
vi.mock("pele/lazy", () => ({ renderAsync: vi.fn() }));

beforeEach(() => {
  vi.mocked(renderAsync).mockReset().mockImplementation(async (source: string) => ({ svg: `<svg data-source="${source.length}"></svg>` }) as never);
});

const FLOW = "```mermaid\ngraph TD\n  A --> B\n```";
const setup = (marked: string) => viewOf(marked, [md(), diagrams]);
const boxes = (view: { dom: HTMLElement }) => [...view.dom.querySelectorAll<HTMLElement>(".cm-diagram")];

test("a mermaid block draws as a diagram while the cursor is elsewhere", async () => {
  const view = setup(`Intro‸\n\n${FLOW}\n\nAfter`);
  assert.deepEqual(decorations(view).map((d) => [d.kind, d.text]), [["Diagram", FLOW]]);
  const [box] = boxes(view);
  assert.equal(box.getAttribute("role"), "img");
  assert.equal(box.getAttribute("aria-label"), "Diagram: graph TD");
  assert.equal(box.title, "Click to edit the diagram");
  await vi.waitFor(() => assert.ok(box.querySelector("svg")));
});

test("Pele gets the block's source, a unique id prefix and no links or images", async () => {
  setup(`‸\n\n${FLOW}\n\n${FLOW.replace("A --> B", "B --> C")}`);
  const calls = vi.mocked(renderAsync).mock.calls;
  await vi.waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls.map((c) => c[0]), ["graph TD\n  A --> B", "graph TD\n  B --> C"]);
  const [a, b] = calls.map((c) => c[1]!);
  assert.equal(a.responsive, true);
  assert.equal(a.links, false);
  assert.equal(a.images, false);
  assert.match(a.idPrefix!, /^d\d+-$/);
  assert.notEqual(a.idPrefix, b.idPrefix);
});

test("a diagram that fails to render says why", async () => {
  vi.mocked(renderAsync).mockRejectedValue(new Error("Parse error on line 2"));
  const [box] = boxes(setup(`‸\n\n${FLOW}`));
  await vi.waitFor(() => assert.equal(box.textContent, "This diagram has an error: Parse error on line 2"));
  assert.ok(box.classList.contains("cm-diagram-error"));
});

test("the language name is matched without regard to case or spaces", () => {
  const view = setup("‸\n\n``` Mermaid \ngraph TD\n```");
  assert.equal(boxes(view).length, 1);
});

test("other code blocks stay code", () => {
  const view = setup("‸\n\n```js\nlet a\n```\n\n```\ngraph TD\n```\n\n    graph TD");
  assert.deepEqual(decorations(view), []);
});

test("an empty mermaid block stays as text", () => {
  const view = setup("‸\n\n```mermaid\n  \n```\n\n```mermaid\n```");
  assert.deepEqual(decorations(view), []);
});

test("an unclosed mermaid block draws to the end of the note", () => {
  const view = setup("‸\n\n```mermaid\ngraph TD");
  assert.deepEqual(decorations(view).map((d) => d.text), ["```mermaid\ngraph TD"]);
});

test("a tilde fence works too", () => {
  const view = setup("‸\n\n~~~mermaid\ngraph TD\n~~~");
  assert.equal(boxes(view).length, 1);
});

test("the source shows while the focused cursor is in the block", async () => {
  const view = setup(`‸\n\n${FLOW}`);
  await focus(view);
  select(view, `\n\n\`\`\`mermaid\ngraph‸ TD\n  A --> B\n\`\`\``);
  assert.deepEqual(decorations(view), []);
  select(view, `\n\n${FLOW}‸`);
  assert.deepEqual(decorations(view), [], "the end of the closing fence is still in the block");
  select(view, `‸\n\n${FLOW}`);
  assert.equal(boxes(view).length, 1);
});

test("a selection reaching into the block shows its source", async () => {
  const view = setup(`«a\n\n\`\`\`»mermaid\ngraph TD\n\`\`\``);
  await focus(view);
  assert.deepEqual(decorations(view), []);
});

test("an unfocused editor draws the diagram even with the cursor in it", () => {
  const view = setup(`‸${FLOW}`);
  assert.equal(boxes(view).length, 1);
});

test("the diagram draws again when the editor loses focus with the cursor inside", async () => {
  const view = setup(`‸\n\n${FLOW}`);
  await focus(view);
  select(view, `\n\n\`\`\`mermaid\ngraph‸ TD\n  A --> B\n\`\`\``);
  assert.equal(boxes(view).length, 0);
  await blur(view);
  assert.equal(boxes(view).length, 1);
});

test("clicking a diagram puts the cursor in its source to edit it", async () => {
  const view = setup(`‸\n\n${FLOW}`);
  const e = mousedown(boxes(view)[0]);
  assert.ok(e.defaultPrevented);
  assert.equal(view.state.selection.main.head, 2 + 4);
  await vi.waitFor(() => assert.equal(boxes(view).length, 0));
});

test("diagrams reserve room before they are drawn", () => {
  const view = setup(`‸\n\n${FLOW}`);
  const deco = view.state.field(diagrams).iter().value!;
  assert.equal(deco.spec.widget.estimatedHeight, 240);
  assert.equal(deco.spec.block, true);
});

test("editing elsewhere does not draw the diagram again", async () => {
  const view = setup(`‸\n\n${FLOW}`);
  view.dispatch({ changes: { from: 0, insert: "Hello" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(vi.mocked(renderAsync).mock.calls.length, 1);
  assert.equal(boxes(view).length, 1);
});

test("editing the source draws the new diagram", async () => {
  const view = setup(`‸\n\n${FLOW}`);
  const at = view.state.doc.toString().indexOf("B");
  view.dispatch({ changes: { from: at, to: at + 1, insert: "C" } });
  const calls = vi.mocked(renderAsync).mock.calls;
  await vi.waitFor(() => assert.deepEqual(calls.map((c) => c[0]), ["graph TD\n  A --> B", "graph TD\n  A --> C"]));
});

test("a note without diagrams draws none", () => {
  assert.deepEqual(decorations(setup("‸")), []);
});
