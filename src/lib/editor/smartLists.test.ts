import assert from "node:assert/strict";
import { test } from "vitest";
import { enterNested, indentItem, moveItemDown, moveItemUp, outdentItem } from "./smartLists.ts";
import { show, viewOf } from "./testing.ts";

test("indenting an item takes its nested items along", () => {
  const view = viewOf("- a\n- b‸\n  - b1\n    - b2\n- c");
  indentItem(view);
  assert.equal(show(view.state), "- a\n  - b‸\n    - b1\n      - b2\n- c");
});

test("an item goes no more than one level deeper than the item above it", () => {
  const view = viewOf("- a\n  - b‸");
  indentItem(view);
  assert.equal(show(view.state), "- a\n  - b‸");
  const first = viewOf("Intro\n- a‸");
  indentItem(first);
  assert.equal(show(first.state), "Intro\n- a‸");
});

test("a list written with tabs is indented with tabs", () => {
  const view = viewOf("- a\n\t- x\n- b‸\n\t- b1");
  indentItem(view);
  assert.equal(show(view.state), "- a\n\t- x\n\t- b‸\n\t\t- b1");
});

test("outdenting an item takes its nested items along, and stops at the left edge", () => {
  const view = viewOf("- a\n  - b‸\n    - b1\n- c");
  outdentItem(view);
  assert.equal(show(view.state), "- a\n- b‸\n  - b1\n- c");
  outdentItem(view);
  assert.equal(show(view.state), "- a\n- b‸\n  - b1\n- c");
});

test("the cursor stays on the same letter when the line moves right", () => {
  const view = viewOf("- a\n‸- b");
  indentItem(view);
  assert.equal(show(view.state), "- a\n  ‸- b");
});

test("moving an item up swaps it with the whole sibling above, nested items and all", () => {
  const view = viewOf("- a\n  - a1\n- b‸\n  - b1\n- c");
  moveItemUp(view);
  assert.equal(show(view.state), "- b‸\n  - b1\n- a\n  - a1\n- c");
  moveItemUp(view);
  assert.equal(show(view.state), "- b‸\n  - b1\n- a\n  - a1\n- c");
});

test("moving an item down swaps it with the whole sibling below", () => {
  const view = viewOf("- a‸\n  - a1\n- b\n  - b1\n- c");
  moveItemDown(view);
  assert.equal(show(view.state), "- b\n  - b1\n- a‸\n  - a1\n- c");
});

test("a nested item moves within its parent; past the last sibling it trades places with the next line", () => {
  const view = viewOf("- p\n  - x\n  - y‸\n- q");
  moveItemUp(view);
  assert.equal(show(view.state), "- p\n  - y‸\n  - x\n- q");
  moveItemDown(view);
  moveItemDown(view);
  assert.equal(show(view.state), "- p\n  - x\n- q\n  - y‸");
});

test("with text selected, the plain line commands run and nested items stay put", () => {
  const view = viewOf("- a\n- «b»\n  - b1");
  indentItem(view);
  assert.equal(view.state.doc.toString(), "- a\n  - b\n  - b1");
  const moved = viewOf("- a\n- «b»\n  - b1");
  moveItemUp(moved);
  assert.equal(moved.state.doc.toString(), "- b\n- a\n  - b1");
});

test("outside a list, Tab and move fall back to the plain commands", () => {
  const view = viewOf("one\ntwo‸");
  moveItemUp(view);
  assert.equal(show(view.state), "two‸\none");
});

test("Enter at the end of an item with nested items adds a new first nested item", () => {
  const view = viewOf("- [ ] Plan‸\n  - [x] Book\n  - [ ] Pack");
  assert.equal(enterNested(view), true);
  assert.equal(show(view.state), "- [ ] Plan\n  - [ ] ‸\n  - [x] Book\n  - [ ] Pack");
});

test("a numbered nested list keeps counting after the new first item", () => {
  const view = viewOf("- Steps‸\n  1. Mix\n  2. Bake\n- Serve");
  enterNested(view);
  assert.equal(show(view.state), "- Steps\n  1. ‸\n  2. Mix\n  3. Bake\n- Serve");
});

test("Enter leaves the usual list continuation to the editor elsewhere", () => {
  assert.equal(enterNested(viewOf("- a‸\n- b")), false);
  assert.equal(enterNested(viewOf("- a‸ more\n  - b")), false);
  assert.equal(enterNested(viewOf("- ‸\n  - b")), false);
});
