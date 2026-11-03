import assert from "node:assert/strict";
import { autocompletion, completionStatus } from "@codemirror/autocomplete";
import * as commands from "@codemirror/commands";
import { history } from "@codemirror/commands";
import { test } from "vitest";
import { show, viewOf } from "./testing.ts";
import { heading, indentLess, indentMore, lines, link, redo, tag, undo } from "./writing.ts";

test("the link button puts the cursor between [[ and ]]", () => {
  const view = viewOf("See ‸");
  link(view);
  assert.equal(show(view.state), "See [[‸]]");
});

test("the link button wraps selected text, keeping it selected", () => {
  const view = viewOf("See «Plan» now");
  link(view);
  assert.equal(show(view.state), "See [[«Plan»]] now");
});

test("the link button opens note suggestions", () => {
  const view = viewOf("‸", [autocompletion({ override: [() => ({ from: 0, options: [{ label: "Plan" }] })] })]);
  link(view);
  assert.notEqual(completionStatus(view.state), null);
});

test("the link button works on every cursor", () => {
  const view = viewOf("a‸ b‸");
  link(view);
  assert.equal(show(view.state), "a[[‸]] b[[‸]]");
});

test("the tag button adds a # after a space, at a line start and at the note start", () => {
  const spaced = viewOf("todo ‸");
  tag(spaced);
  assert.equal(show(spaced.state), "todo #‸");
  const lineStart = viewOf("a\n‸");
  tag(lineStart);
  assert.equal(show(lineStart.state), "a\n#‸");
  const empty = viewOf("‸");
  tag(empty);
  assert.equal(show(empty.state), "#‸");
});

test("the tag button adds a space first when the cursor touches a word", () => {
  const view = viewOf("todo‸");
  tag(view);
  assert.equal(show(view.state), "todo #‸");
});

test("the tag button turns a selected word into a tag", () => {
  const view = viewOf("a «work» b");
  tag(view);
  assert.equal(show(view.state), "a #«work» b");
});

test("list buttons on the writing toolbar leave the cursor at the end of the line", () => {
  const view = viewOf("Bu‸y milk\nnext");
  lines(view, "task");
  assert.equal(show(view.state), "- [ ] Buy milk‸\nnext");
  lines(view, "task");
  assert.equal(show(view.state), "Buy milk‸\nnext");
});

test("list buttons on an empty line start an item to type into", () => {
  const view = viewOf("‸");
  lines(view, "bullet");
  assert.equal(show(view.state), "- ‸");
});

test("list buttons keep a selection selected", () => {
  const view = viewOf("«a\nb»");
  lines(view, "numbered");
  assert.equal(show(view.state), "«1. a\n2. b»");
});

test("the heading button cycles the cursor's line and leaves the cursor at its end", () => {
  const view = viewOf("Pl‸an\nnext");
  heading(view);
  assert.equal(show(view.state), "# Plan‸\nnext");
  heading(view);
  heading(view);
  assert.equal(show(view.state), "### Plan‸\nnext");
  heading(view);
  assert.equal(show(view.state), "Plan‸\nnext");
});

test("the heading button on an empty note starts a heading", () => {
  const view = viewOf("‸");
  heading(view);
  assert.equal(show(view.state), "# ‸");
});

test("the heading button acts on the line where a selection ends", () => {
  const view = viewOf("«one\ntwo»");
  heading(view);
  assert.equal(show(view.state), "one\n# two‸");
});

test("indent, outdent, undo and redo are CodeMirror's own commands", () => {
  assert.equal(indentMore, commands.indentMore);
  assert.equal(indentLess, commands.indentLess);
  assert.equal(undo, commands.undo);
  assert.equal(redo, commands.redo);
});

test("toolbar edits can be undone and redone", () => {
  const view = viewOf("x‸", [history()]);
  link(view);
  assert.equal(show(view.state), "x[[‸]]");
  undo(view);
  assert.equal(view.state.doc.toString(), "x");
  redo(view);
  assert.equal(view.state.doc.toString(), "x[[]]");
});

test("indent and outdent move a list item a level", () => {
  const view = viewOf("- a\n- b‸");
  indentMore(view);
  assert.equal(view.state.doc.toString(), "- a\n  - b");
  indentLess(view);
  assert.equal(view.state.doc.toString(), "- a\n- b");
});
