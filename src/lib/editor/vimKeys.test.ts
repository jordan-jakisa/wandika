import assert from "node:assert/strict";
import { getCM } from "@replit/codemirror-vim";
import { EditorView } from "@codemirror/view";
import { test, vi } from "vitest";

vi.mock("pele/lazy", () => ({ renderAsync: vi.fn(async () => ({ svg: "<svg></svg>" })) }));
vi.mock("../api", () => ({ api: { resolveLink: vi.fn(async () => null), noteRead: vi.fn() } }));
import { app } from "../app.svelte";
import { extensions } from "./setup.ts";
import { vimNow, vimSlot, setVim } from "./vimKeys.ts";
import { viewOf } from "./testing.ts";

test("Vim keys turn on and off in the open note, and new notes start the same way", async () => {
  const view = viewOf("hello", [vimSlot.of(vimNow())]);
  assert.equal(getCM(view), null);
  const save = vi.fn();
  await setVim(() => view, true, save);
  assert.ok(getCM(view), "Vim is on in the open note");
  const next = viewOf("next", [vimSlot.of(vimNow())]);
  assert.ok(getCM(next), "a note opened after starts with Vim");
  assert.equal(app.vimMode, "normal", "the status bar shows the mode");
  await setVim(() => view, false, save);
  assert.equal(getCM(view), null);
  assert.equal(app.vimMode, null);
});

test("in the note editor, ⌥-click adds a cursor and a plain click doesn't", () => {
  const view = viewOf("a\nb", extensions({ getTitles: () => [], onOpenLink() {}, onTag() {}, onChange() {}, getPath: () => "A.md", onFiles() {} }));
  const adds = view.state.facet(EditorView.clickAddsSelectionRange);
  assert.equal(adds.some((f) => f(new MouseEvent("mousedown", { altKey: true }))), true);
  assert.equal(adds.some((f) => f(new MouseEvent("mousedown"))), false);
});

test("line numbers come and go with the setting, beside the note", async () => {
  const { numbersFor, numbersSlot } = await import("./setup.ts");
  const view = viewOf("one\ntwo", [numbersSlot.of(numbersFor(false))]);
  assert.equal(view.dom.querySelector(".cm-lineNumbers"), null);
  view.dispatch({ effects: numbersSlot.reconfigure(numbersFor(true)) });
  assert.ok(view.dom.querySelector(".cm-lineNumbers"));
  assert.ok(view.dom.classList.contains("cm-numbered"));
  view.dispatch({ effects: numbersSlot.reconfigure(numbersFor(false)) });
  assert.equal(view.dom.querySelector(".cm-lineNumbers"), null);
});
