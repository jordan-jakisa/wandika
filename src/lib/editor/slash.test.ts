import assert from "node:assert/strict";
import { autocompletion, currentCompletions, startCompletion, acceptCompletion, selectedCompletion } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { EditorView } from "@codemirror/view";
import { test, vi } from "vitest";
import { slashCommands, type SlashActions } from "./slash.ts";
import { show, viewOf } from "./testing.ts";

function setup(marked: string, actions: SlashActions = {}) {
  return viewOf(marked, [markdown({ base: markdownLanguage }), autocompletion({ override: [slashCommands(actions)] })]);
}

async function open(view: EditorView) {
  startCompletion(view);
  await vi.waitFor(() => assert.ok(currentCompletions(view.state).length > 0));
  await new Promise((r) => setTimeout(r, 100));
  return currentCompletions(view.state).map((c) => c.label);
}

async function choose(view: EditorView, label: string) {
  const labels = await open(view);
  assert.ok(labels.includes(label), `${label} in ${labels}`);
  assert.equal(selectedCompletion(view.state)?.label, label);
  assert.ok(acceptCompletion(view));
}

test("/ at a line start lists the commands, text first", async () => {
  const labels = await open(setup("/‸"));
  assert.deepEqual(labels.slice(0, 3), ["Heading 1", "Heading 2", "Heading 3"]);
  assert.ok(labels.includes("Table") && labels.includes("Today's date"));
});

test("a few letters find a command by its name or another word for it", async () => {
  assert.deepEqual(await open(setup("/todo‸")), ["Checklist"]);
  assert.deepEqual(await open(setup("/h2‸")), ["Heading 2"]);
  assert.deepEqual(await open(setup("/head 3‸")), ["Heading 3"]);
});

test("a heading or list command turns the line into one, keeping its words", async () => {
  const view = setup("Groceries /h1‸");
  await choose(view, "Heading 1");
  assert.equal(show(view.state), "# Groceries‸");
  const list = setup("- milk /todo‸");
  await choose(list, "Checklist");
  assert.equal(show(list.state), "- [ ] milk‸");
});

test("a table goes on its own lines with the cursor in its first cell", async () => {
  const view = setup("Plan /table‸");
  await choose(view, "Table");
  assert.equal(show(view.state), "Plan\n| Column | Column |\n| --- | --- |\n| ‸ |  |");
});

test("a code block puts the cursor inside it", async () => {
  const view = setup("/code‸");
  await choose(view, "Code block");
  assert.equal(show(view.state), "```\n‸\n```");
});

test("picture, drawing, voice and template commands ask the note, and only when it offers them", async () => {
  assert.ok(!(await open(setup("/‸"))).includes("Voice note"));
  const voice = vi.fn();
  const view = setup("/voice‸", { voice });
  await choose(view, "Voice note");
  assert.equal(voice.mock.calls.length, 1);
  assert.equal(show(view.state), "‸");
});

test("no commands inside a word, a path or code", async () => {
  for (const doc of ["and/or‸", "see docs/‸", "```\n/‸\n```"]) {
    const view = setup(doc);
    startCompletion(view);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(currentCompletions(view.state).length, 0, doc);
  }
});
