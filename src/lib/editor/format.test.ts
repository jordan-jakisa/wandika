import assert from "node:assert/strict";
import { EditorSelection } from "@codemirror/state";
import { runScopeHandlers, type EditorView } from "@codemirror/view";
import { test } from "vitest";
import { formatting, setLines, wrap } from "./format.ts";
import { mousedown, select, show, viewOf } from "./testing.ts";

const toolbarOf = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-format");
const button = (view: EditorView, label: string) => toolbarOf(view)!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

/** Presses a shortcut such as `Mod-b`, with Ctrl standing in for Mod off a Mac. */
function press(view: EditorView, key: string, opts: { shift?: boolean; keyCode?: number } = {}) {
  const mac = /Mac/.test(navigator.platform);
  const event = new KeyboardEvent("keydown", {
    key,
    keyCode: opts.keyCode,
    shiftKey: !!opts.shift,
    metaKey: mac,
    ctrlKey: !mac,
    bubbles: true,
    cancelable: true,
  });
  return runScopeHandlers(view, event, "editor");
}

test("list buttons convert every line the selection touches and keep them selected", () => {
  const view = viewOf("Mi«lk\nEg»gs\nBread");
  setLines(view, "bullet");
  assert.equal(show(view.state), "«- Milk\n- Eggs»\nBread");
});

test("pressing the same list button twice turns the lines back into text", () => {
  const view = viewOf("«Milk\nEggs»");
  setLines(view, "task");
  assert.equal(show(view.state), "«- [ ] Milk\n- [ ] Eggs»");
  setLines(view, "task");
  assert.equal(show(view.state), "«Milk\nEggs»");
});

test("each selection range converts on its own", () => {
  const view = viewOf("«a»\nb\n«c\nd»");
  setLines(view, "numbered");
  assert.equal(show(view.state), "«1. a»\nb\n«1. c\n2. d»");
});

test("with only a cursor, the line converts and the cursor stays at its end, ready to type", () => {
  const view = viewOf("Mi‸lk\nEggs");
  setLines(view, "bullet");
  assert.equal(show(view.state), "- Milk‸\nEggs");
});

test("a list button on an empty line starts an item", () => {
  const view = viewOf("‸");
  setLines(view, "task");
  assert.equal(show(view.state), "- [ ] ‸");
});

test("list buttons work at the very start and end of a note", () => {
  const start = viewOf("‸first\nlast");
  setLines(start, "quote");
  assert.equal(show(start.state), "> first‸\nlast");
  const end = viewOf("first\nlast‸");
  setLines(end, "quote");
  assert.equal(show(end.state), "first\n> last‸");
});

test("two cursors on one line convert that line once", () => {
  const view = viewOf("a‸b‸c\nd");
  setLines(view, "bullet");
  assert.equal(show(view.state), "- abc‸\nd");
});

test("ranges that share a line convert as one block", () => {
  const view = viewOf("«a\nb»«\nc»\nd");
  setLines(view, "numbered");
  assert.equal(show(view.state), "«1. a\n2. b\n3. c»\nd");
});

test("cursors on separate lines each stay at the end of their line", () => {
  const view = viewOf("a‸\n‸b\nc");
  setLines(view, "bullet");
  assert.equal(show(view.state), "- a‸\n- b‸\nc");
});

test("the main selection stays the main one", () => {
  const view = viewOf("«a»\nb\n«c»");
  view.dispatch({ selection: EditorSelection.create(view.state.selection.ranges, 1) });
  assert.equal(view.state.selection.mainIndex, 1);
  setLines(view, "bullet");
  assert.equal(view.state.selection.mainIndex, 1);
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "- c");
});

test("wrapping toggles a mark around the selection and keeps it selected", () => {
  const view = viewOf("a «word» here");
  wrap(view, "**");
  assert.equal(show(view.state), "a «**word**» here");
  wrap(view, "**");
  assert.equal(show(view.state), "a «word» here");
});

test("wrapping with only a cursor inserts a pair of marks around the cursor", () => {
  const view = viewOf("a ‸b");
  wrap(view, "~~");
  assert.equal(show(view.state), "a ~~‸~~b");
});

test("wrapping applies to every selection range", () => {
  const view = viewOf("«one» and «two» and ‸");
  wrap(view, "`");
  assert.equal(show(view.state), "«`one`» and «`two`» and `‸`");
});

test("wrapping keeps spaces outside the marks and handles unicode", () => {
  const view = viewOf("« café 🎉 »");
  wrap(view, "*");
  assert.equal(show(view.state), "« *café 🎉* »");
});

test("shortcuts: checklist, bullets and numbers", () => {
  const view = viewOf("«a\nb»", formatting);
  assert.ok(press(view, "l"));
  assert.equal(show(view.state), "«- [ ] a\n- [ ] b»");
  assert.ok(press(view, "*", { shift: true, keyCode: 56 }));
  assert.equal(show(view.state), "«- a\n- b»");
  assert.ok(press(view, "&", { shift: true, keyCode: 55 }));
  assert.equal(show(view.state), "«1. a\n2. b»");
});

test("the format bar appears only while text is selected", () => {
  const view = viewOf("a ‸word", formatting);
  assert.equal(toolbarOf(view), null);
  select(view, "a «word»");
  const bar = toolbarOf(view)!;
  assert.equal(bar.getAttribute("role"), "toolbar");
  assert.equal(bar.getAttribute("aria-label"), "Format selection");
  select(view, "a word‸");
  assert.equal(toolbarOf(view), null);
});

test("the format bar has the list buttons, a divider, then the text buttons", () => {
  const view = viewOf("«word»", formatting);
  const bar = toolbarOf(view)!;
  const items = [...bar.children].map((el) => (el.tagName === "BUTTON" ? el.getAttribute("aria-label") : "|"));
  assert.deepEqual(items, [
    "Bulleted list",
    "Numbered list",
    "Checklist",
    "Quote",
    "Plain text",
    "|",
    "Bold",
    "Italic",
    "Strikethrough",
    "Code",
  ]);
  for (const b of bar.querySelectorAll("button")) {
    assert.equal(b.type, "button");
    assert.equal(b.title, b.getAttribute("aria-label"));
    assert.ok(b.querySelector("svg"), `${b.title} has an icon`);
  }
});

test("each list button on the format bar converts the selected lines", () => {
  const view = viewOf("«a\nb»", formatting);
  const steps: [string, string][] = [
    ["Bulleted list", "«- a\n- b»"],
    ["Numbered list", "«1. a\n2. b»"],
    ["Checklist", "«- [ ] a\n- [ ] b»"],
    ["Quote", "«> a\n> b»"],
    ["Plain text", "«a\nb»"],
  ];
  for (const [label, after] of steps) {
    mousedown(button(view, label));
    assert.equal(show(view.state), after, label);
  }
});

test("the format bar follows the selection after a button press", () => {
  const view = viewOf("«a»", formatting);
  mousedown(button(view, "Bulleted list"));
  assert.ok(toolbarOf(view));
});
