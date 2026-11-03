import assert from "node:assert/strict";
import { acceptCompletion, currentCompletions, startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { runScopeHandlers, type EditorView } from "@codemirror/view";
import { test, vi } from "vitest";
import type { NoteMeta } from "../types";
import { extensions } from "./setup.ts";
import { mousedown, show, viewOf } from "./testing.ts";

vi.mock("pele/lazy", () => ({ renderAsync: vi.fn(async () => ({ svg: "<svg></svg>" })) }));
vi.mock("../api", () => ({ api: { resolveLink: vi.fn(async () => null), noteRead: vi.fn() } }));

const titles = [
  { path: "Plan.md", title: "Plan" },
  { path: "Trips/2026/Kampala.md", title: "Kampala" },
] as NoteMeta[];

function setup(marked: string) {
  const opts = {
    getTitles: () => titles,
    onOpenLink: vi.fn(),
    onTag: vi.fn(),
    onChange: vi.fn(),
    getPath: () => "Here.md",
    onFiles: vi.fn(),
  };
  const view = viewOf(marked, extensions(opts));
  return { view, opts };
}

/** Opens note suggestions and waits until they can be accepted. */
async function suggest(view: EditorView) {
  startCompletion(view);
  await vi.waitFor(() => assert.ok(currentCompletions(view.state).length > 0));
  // Completions ignore an accept that comes too soon after they open.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return currentCompletions(view.state);
}

function press(view: EditorView, key: string) {
  const mac = /Mac/.test(navigator.platform);
  const event = new KeyboardEvent("keydown", { key, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
  return runScopeHandlers(view, event, "editor");
}

test("typing [[ suggests every note by name, with its folder", async () => {
  const { view } = setup("See [[‸");
  const options = await suggest(view);
  assert.deepEqual(options.map((o) => [o.label, o.detail]), [
    ["Kampala", "Trips/2026"],
    ["Plan", ""],
  ]);
});

test("choosing a note completes the link and puts the cursor after it", async () => {
  const { view } = setup("See [[Kam‸");
  await suggest(view);
  assert.ok(acceptCompletion(view));
  assert.equal(show(view.state), "See [[Kampala]]‸");
});

test("choosing a note inside closed brackets does not add a second pair", async () => {
  const { view } = setup("See [[Pl‸]] now");
  await suggest(view);
  assert.ok(acceptCompletion(view));
  assert.equal(show(view.state), "See [[Plan]]‸ now");
});

test("no note suggestions outside a link or after its alias bar", async () => {
  for (const doc of ["Plain ‸", "[[Plan|al‸", "[single‸"]) {
    const { view } = setup(doc);
    startCompletion(view);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(currentCompletions(view.state), [], doc);
  }
});

test("every edit reports the whole note; moving the cursor does not", () => {
  const { view, opts } = setup("ab‸");
  view.dispatch({ selection: { anchor: 0 } });
  assert.equal(opts.onChange.mock.calls.length, 0);
  view.dispatch({ changes: { from: 0, insert: "x" } });
  assert.deepEqual(opts.onChange.mock.calls, [["xab"]]);
});

test("the editor asks for spellcheck, autocorrect and sentence capitals", () => {
  const { view } = setup("‸");
  assert.equal(view.contentDOM.getAttribute("spellcheck"), "true");
  assert.equal(view.contentDOM.getAttribute("autocorrect"), "on");
  assert.equal(view.contentDOM.getAttribute("autocapitalize"), "sentences");
});

test("an empty note shows how to start", () => {
  const { view } = setup("‸");
  assert.equal(view.dom.querySelector(".cm-placeholder")!.textContent, "Start writing. Type [[ to link a note.");
});

test("several cursors are allowed", () => {
  const { view } = setup("a‸ b‸");
  assert.equal(view.state.selection.ranges.length, 2);
});

test("shortcuts for formatting and undo are wired up", () => {
  const { view } = setup("«word»");
  assert.ok(press(view, "b"));
  assert.equal(view.state.doc.toString(), "**word**");
  assert.ok(undo(view));
  assert.equal(view.state.doc.toString(), "word");
});

test("Tab indents a list item", () => {
  const { view } = setup("- a\n- b‸");
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  assert.ok(runScopeHandlers(view, event, "editor"));
  assert.equal(view.state.doc.toString(), "- a\n  - b");
});

test("a full note renders every part together", () => {
  const doc = [
    "---",
    "tags: [a]",
    "---",
    "# Title‸",
    "",
    "Some **bold** text with [[Plan]] and #tag.",
    "",
    "- [ ] task",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | #cell |",
    "",
    "```mermaid",
    "graph TD",
    "```",
    "",
    "![[Plan#Goals]]",
  ].join("\n");
  const { view } = setup(doc);
  for (const cls of [".cm-properties", ".cm-h1", ".cm-strong", ".cm-wikilink", ".cm-tag", "input.cm-task", ".cm-table", ".cm-diagram", ".cm-note-embed"]) {
    assert.ok(view.dom.querySelector(cls), cls);
  }
});

test("links and tags open through the app's handlers, in the text and in tables", () => {
  const { view, opts } = setup("‸\n[[Plan]] #todo\n\n| a |\n|---|\n| #cell |");
  mousedown(view.dom.querySelector(".cm-line .cm-wikilink")!);
  mousedown(view.dom.querySelector(".cm-line .cm-tag")!);
  mousedown(view.dom.querySelector(".cm-table .cm-tag")!);
  assert.deepEqual(opts.onOpenLink.mock.calls, [["Plan"]]);
  assert.deepEqual(opts.onTag.mock.calls, [["todo"], ["cell"]]);
});
