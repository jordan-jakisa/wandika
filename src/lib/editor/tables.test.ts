import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { tables } from "./tables.ts";
import { blur, decorations, focus, md, mousedown, select, show, viewOf } from "./testing.ts";

const TABLE = "| Name | Age |\n|:--|--:|\n| **Ann** | 30 |\n| [[Bob]] |";
const doc = `Intro‸\n\n${TABLE}\n\nAfter`;

const setup = (marked: string, onOpenLink = vi.fn(), onTag = vi.fn()) => {
  const view = viewOf(marked, [md(), tables(onOpenLink, onTag)]);
  return { view, onOpenLink, onTag };
};

const tableIn = (view: { dom: HTMLElement }) => view.dom.querySelector<HTMLTableElement>(".cm-table");

test("a table renders as a real table while the cursor is elsewhere", () => {
  const { view } = setup(doc);
  const decos = decorations(view).filter((d) => d.kind === "Table");
  assert.equal(decos.length, 1);
  assert.equal(decos[0].text, TABLE);
  const table = tableIn(view)!;
  assert.deepEqual([...table.tHead!.rows[0].cells].map((c) => c.textContent), ["Name", "Age"]);
  assert.equal(table.tBodies[0].rows.length, 2);
});

test("cells take the column's alignment and render inline Markdown", () => {
  const { view } = setup(doc);
  const table = tableIn(view)!;
  const [ann, age] = [...table.tBodies[0].rows[0].cells];
  assert.equal(ann.innerHTML, "<strong>Ann</strong>");
  assert.equal(ann.style.textAlign, "left");
  assert.equal(age.style.textAlign, "right");
});

test("short rows are padded and long rows trimmed to the header", () => {
  const { view } = setup("x‸\n\n| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |");
  const rows = [...tableIn(view)!.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.textContent));
  assert.deepEqual(rows, [["1", ""], ["1", "2"]]);
});

test("a table with only a header row renders an empty body", () => {
  const { view } = setup("x‸\n\n| a | b |\n|---|---|");
  const table = tableIn(view)!;
  assert.equal(table.tHead!.rows[0].cells.length, 2);
  assert.equal(table.tBodies[0].rows.length, 0);
});

test("text that only looks like a table stays text", () => {
  const { view } = setup("x‸\n\n| a | b |\nno delimiter row");
  assert.equal(tableIn(view), null);
});

test("each body row knows where its source line starts", () => {
  const { view } = setup(doc);
  const rows = [...tableIn(view)!.tBodies[0].rows];
  const text = view.state.doc.toString();
  assert.equal(rows[0].dataset.pos, String(text.indexOf("| **Ann**")));
  assert.equal(rows[1].dataset.pos, String(text.indexOf("| [[Bob]]")));
});

test("the source shows while the focused cursor is in the table", async () => {
  const { view } = setup(doc);
  await focus(view);
  assert.ok(tableIn(view));
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("Ann") } });
  assert.equal(tableIn(view), null);
  assert.equal(decorations(view).filter((d) => d.kind === "Table").length, 0);
  select(view, `Intro‸\n\n${TABLE}\n\nAfter`);
  assert.ok(tableIn(view));
});

test("the table renders again when the editor loses focus with the cursor inside", async () => {
  const { view } = setup(doc);
  await focus(view);
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("Ann") } });
  assert.equal(tableIn(view), null);
  await blur(view);
  assert.ok(tableIn(view));
});

test("an unfocused editor renders the table even with the cursor in it", () => {
  const { view } = setup(`${TABLE}‸`);
  assert.ok(tableIn(view));
});

test("selecting across the table from outside shows its source", async () => {
  const { view } = setup(`«Intro\n\n| Name»${TABLE.slice(6)}`);
  await focus(view);
  assert.equal(tableIn(view), null);
});

test("clicking a row puts the cursor at the start of that row's source", async () => {
  const { view } = setup(doc);
  await focus(view);
  const row = tableIn(view)!.tBodies[0].rows[0];
  const e = mousedown(row.cells[1]);
  assert.ok(e.defaultPrevented);
  assert.equal(view.state.selection.main.head, view.state.doc.toString().indexOf("| **Ann**"));
  assert.equal(tableIn(view), null);
});

test("clicking the header puts the cursor at the start of the table", async () => {
  const { view } = setup(doc);
  await focus(view);
  mousedown(tableIn(view)!.tHead!.rows[0].cells[0]);
  assert.equal(view.state.selection.main.head, view.state.doc.toString().indexOf("| Name"));
});

test("clicking a wikilink in a cell opens the note and leaves the cursor", async () => {
  const { view, onOpenLink } = setup(doc);
  await focus(view);
  mousedown(tableIn(view)!.querySelector(".cm-wikilink")!);
  assert.deepEqual(onOpenLink.mock.calls, [["Bob"]]);
  assert.equal(show(view.state), doc);
});

test("clicking a web link in a cell asks the app to open the address", () => {
  const { view } = setup("x‸\n\n| a |\n|---|\n| [site](https://example.com) |");
  const opened = vi.fn();
  const listener = (e: Event) => opened((e as CustomEvent).detail);
  window.addEventListener("wandika:open-url", listener);
  try {
    mousedown(tableIn(view)!.querySelector(".cm-md-link")!);
  } finally {
    window.removeEventListener("wandika:open-url", listener);
  }
  assert.deepEqual(opened.mock.calls, [["https://example.com"]]);
});

test("clicking a tag in a cell shows that tag", () => {
  const { view, onTag } = setup("x‸\n\n| a |\n|---|\n| #todo |");
  mousedown(tableIn(view)!.querySelector(".cm-tag")!);
  assert.deepEqual(onTag.mock.calls, [["todo"]]);
  assert.equal(view.state.selection.main.head, 1);
});

test("two tables render as two widgets", () => {
  const { view } = setup(`x‸\n\n${TABLE}\n\ntext\n\n${TABLE}`);
  assert.equal(view.dom.querySelectorAll(".cm-table").length, 2);
});

test("editing a table updates what the widget shows", () => {
  const { view } = setup(doc);
  const at = view.state.doc.toString().indexOf("30");
  view.dispatch({ changes: { from: at, to: at + 2, insert: "31" } });
  assert.equal(tableIn(view)!.tBodies[0].rows[0].cells[1].textContent, "31");
});

test("an empty note has no tables", () => {
  const { view } = setup("‸");
  assert.deepEqual(decorations(view), []);
});
