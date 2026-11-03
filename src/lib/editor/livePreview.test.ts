import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { activeLines, inCode, livePreview } from "./livePreview.ts";
import { decorations, focus, md, mousedown, select, stateOf, viewOf, type Deco } from "./testing.ts";

const setup = (marked: string) => {
  const onOpenLink = vi.fn();
  const onTag = vi.fn();
  const view = viewOf(marked, [md(), livePreview(onOpenLink, onTag)]);
  return { view, onOpenLink, onTag };
};

/** Decorations as `kind:text`, the shortest way to say what the reader sees. */
const seen = (decos: Deco[]) => decos.map((d) => `${d.kind}:${d.text}`);
const hidden = (decos: Deco[]) => decos.filter((d) => d.kind === "hide").map((d) => d.text);
const lineClasses = (decos: Deco[]) => decos.filter((d) => d.from === d.to && d.kind.startsWith("cm-")).map((d) => d.kind);

test("active lines are the lines any selection range touches", () => {
  const state = stateOf("a‸\nb\n«c\nd»\ne");
  assert.deepEqual([...activeLines(state)], [1, 3, 4]);
});

test("an unfocused editor has no active lines", () => {
  assert.deepEqual([...activeLines(stateOf("a‸"), false)], []);
});

test("an empty note's only line is active", () => {
  assert.deepEqual([...activeLines(stateOf("‸"))], [1]);
});

test("inCode finds fenced and indented code, not paragraphs or inline code", () => {
  const state = stateOf("text `code`\n\n```js\nlet a\n```\n\n    indented\n", [md()]);
  const doc = state.doc.toString();
  assert.equal(inCode(state, doc.indexOf("let a")), true);
  assert.equal(inCode(state, doc.indexOf("```js")), true);
  assert.equal(inCode(state, doc.indexOf("indented")), true);
  assert.equal(inCode(state, doc.indexOf("text")), false);
  assert.equal(inCode(state, doc.indexOf("code")), false);
});

test("inCode is false everywhere in an empty note", () => {
  assert.equal(inCode(stateOf("", [md()]), 0), false);
});

test("headings get their level's style and lose their # off the cursor's line", () => {
  const { view } = setup("‸\n## Plan\n###### Six");
  const decos = decorations(view);
  assert.deepEqual(lineClasses(decos), ["cm-h cm-h2", "cm-h cm-h6"]);
  assert.deepEqual(hidden(decos), ["## ", "###### "]);
});

test("on the cursor's line the heading's # shows while editing", async () => {
  const { view } = setup("x\n## Pl‸an");
  await focus(view);
  assert.deepEqual(hidden(decorations(view)), []);
  assert.deepEqual(lineClasses(decorations(view)), ["cm-h cm-h2"]);
});

test("an unfocused editor renders every line, the cursor's line too", () => {
  const { view } = setup("## Pl‸an **b**");
  assert.deepEqual(hidden(decorations(view)), ["## ", "**", "**"]);
});

test("focusing and moving the cursor reveals and hides marks line by line", async () => {
  const { view } = setup("‸*one*\n*two*");
  await focus(view);
  assert.deepEqual(hidden(decorations(view)), ["*", "*"]);
  assert.equal(decorations(view).filter((d) => d.kind === "hide")[0].from, 6);
  select(view, "*one*\n*two*‸");
  assert.equal(decorations(view).filter((d) => d.kind === "hide")[0].from, 0);
});

test("bold, italic, strike and inline code are styled and their marks hidden", () => {
  const { view } = setup("‸\n**b** *i* ~~s~~ `c`");
  const decos = decorations(view);
  assert.deepEqual(
    seen(decos.filter((d) => d.kind !== "hide")),
    ["cm-strong:**b**", "cm-em:*i*", "cm-strike:~~s~~", "cm-inline-code:`c`"],
  );
  assert.deepEqual(hidden(decos), ["**", "**", "*", "*", "~~", "~~", "`", "`"]);
});

test("the backticks of a code fence stay visible and its lines are styled as code", () => {
  const { view } = setup("‸\n```js\nlet *a* = 1\n```");
  const decos = decorations(view);
  assert.deepEqual(hidden(decos), []);
  assert.deepEqual(lineClasses(decos), ["cm-codeblock", "cm-codeblock", "cm-codeblock"]);
  assert.ok(!decos.some((d) => d.kind === "cm-em"));
});

test("a Markdown link shows only its text and carries its address", () => {
  const { view } = setup("‸\nGo [home](https://x.com) now");
  const decos = decorations(view);
  assert.deepEqual(seen(decos.filter((d) => d.kind !== "hide")), ["cm-md-link:[home](https://x.com)"]);
  assert.deepEqual(hidden(decos), ["[", "](https://x.com)"]);
  const link = view.dom.querySelector<HTMLElement>(".cm-md-link")!;
  assert.equal(link.dataset.href, "https://x.com");
});

test("on the cursor's line a link shows its Markdown", async () => {
  const { view } = setup("[home](https://x.com)‸");
  await focus(view);
  assert.deepEqual(hidden(decorations(view)), []);
  assert.ok(view.dom.querySelector(".cm-md-link"));
});

test("task markers become checkboxes in place of the dash", () => {
  const { view } = setup("‸\n- [ ] open\n- [x] done");
  const decos = decorations(view);
  const boxes = [...view.dom.querySelectorAll<HTMLInputElement>("input.cm-task")];
  assert.deepEqual(boxes.map((b) => b.checked), [false, true]);
  assert.deepEqual(boxes.map((b) => b.getAttribute("aria-label")), ["Mark as done", "Mark as not done"]);
  assert.deepEqual(hidden(decos), ["- ", "- "]);
  assert.deepEqual(seen(decos.filter((d) => d.kind === "cm-task-done")), ["cm-task-done:done"]);
});

test("a capital X is a ticked box", () => {
  const { view } = setup("‸\n- [X] done");
  assert.equal(view.dom.querySelector<HTMLInputElement>("input.cm-task")!.checked, true);
});

test("clicking a checkbox ticks and unticks the task in the text", () => {
  const { view } = setup("‸\n- [ ] milk");
  view.dom.querySelector<HTMLInputElement>("input.cm-task")!.click();
  assert.equal(view.state.doc.toString(), "\n- [x] milk");
  view.dom.querySelector<HTMLInputElement>("input.cm-task")!.click();
  assert.equal(view.state.doc.toString(), "\n- [ ] milk");
});

test("a checkbox does not take the cursor on mousedown", () => {
  const { view } = setup("‸\n- [ ] milk");
  assert.ok(mousedown(view.dom.querySelector("input.cm-task")!).defaultPrevented);
});

test("the task marker shows as text while the cursor is in it", async () => {
  const { view } = setup("- [‸ ] milk");
  await focus(view);
  assert.ok(!view.dom.querySelector("input.cm-task"));
});

test("a ticked task with no text gets no strike-through", () => {
  const { view } = setup("‸\n- [x] ");
  assert.ok(view.dom.querySelector("input.cm-task"));
  assert.ok(!decorations(view).some((d) => d.kind === "cm-task-done"));
});

test("bullets of every style become a dot; numbers stay as text", () => {
  const { view } = setup("‸\n- a\n* b\n+ c\n\n1. d");
  const decos = decorations(view);
  assert.equal(view.dom.querySelectorAll(".cm-bullet").length, 3);
  assert.equal(view.dom.querySelector(".cm-bullet")!.textContent, "•");
  assert.deepEqual(seen(decos.filter((d) => d.kind === "cm-list-mark")), ["cm-list-mark:1."]);
});

test("nested bullets each get a dot", () => {
  const { view } = setup("‸\n- a\n  - b\n    - c");
  assert.equal(view.dom.querySelectorAll(".cm-bullet").length, 3);
});

test("on the cursor's line a bullet shows as typed", async () => {
  const { view } = setup("- a‸");
  await focus(view);
  assert.ok(!view.dom.querySelector(".cm-bullet"));
  assert.deepEqual(seen(decorations(view).filter((d) => d.kind === "cm-list-mark")), ["cm-list-mark:-"]);
});

test("quotes are styled line by line and lose their >", () => {
  const { view } = setup("‸\n> one\n> two");
  const decos = decorations(view);
  assert.deepEqual(lineClasses(decos), ["cm-quote", "cm-quote"]);
  assert.deepEqual(hidden(decos), ["> ", "> "]);
});

test("callouts get their tone, a first and last line, and a title", () => {
  const { view } = setup("‸\n> [!warning] Mind the gap\n> body\n> end");
  const decos = decorations(view);
  assert.deepEqual(lineClasses(decos), [
    "cm-callout cm-callout-amber cm-callout-first",
    "cm-callout cm-callout-amber",
    "cm-callout cm-callout-amber cm-callout-last",
  ]);
  const title = view.dom.querySelector(".cm-callout-title")!;
  assert.equal(title.textContent, "Mind the gap");
  assert.ok(decos.some((d) => d.kind === "CalloutTitle" && d.text === "[!warning] Mind the gap"));
});

test("a callout without a title shows its type; fold marks are hidden too", () => {
  const { view } = setup("‸\n> [!TIP]-");
  assert.equal(view.dom.querySelector(".cm-callout-title")!.textContent, "Tip");
  assert.deepEqual(lineClasses(decorations(view)), ["cm-callout cm-callout-accent cm-callout-first cm-callout-last"]);
});

test("callout types map to tones, and unknown types are info", () => {
  const tones: Record<string, string> = { tip: "accent", faq: "amber", bug: "alarm", cite: "quiet", note: "info", whatever: "info" };
  for (const [type, tone] of Object.entries(tones)) {
    const { view } = setup(`‸\n> [!${type}]`);
    assert.ok(lineClasses(decorations(view))[0].startsWith(`cm-callout cm-callout-${tone}`), type);
  }
});

test("on the cursor's line a callout shows its Markdown", async () => {
  const { view } = setup("> [!note] Hi‸");
  await focus(view);
  assert.ok(!view.dom.querySelector(".cm-callout-title"));
});

test("a thematic break becomes a rule except on the cursor's line", async () => {
  const { view } = setup("‸\n\n---\n\n***");
  assert.equal(view.dom.querySelectorAll(".cm-hr-line").length, 2);
  await focus(view);
  select(view, "\n\n---‸\n\n***");
  assert.equal(view.dom.querySelectorAll(".cm-hr-line").length, 1);
});

test("wikilinks show their name and carry their target", () => {
  const { view } = setup("‸\nSee [[Plan]] and [[Trips/Kampala|the trip]].");
  const decos = decorations(view);
  assert.deepEqual(seen(decos.filter((d) => d.kind === "cm-wikilink")), [
    "cm-wikilink:[[Plan]]",
    "cm-wikilink:[[Trips/Kampala|the trip]]",
  ]);
  assert.deepEqual(hidden(decos), ["[[", "]]", "[[", "Trips/Kampala|", "]]"]);
  const links = [...view.dom.querySelectorAll<HTMLElement>(".cm-wikilink")];
  assert.deepEqual(links.map((l) => l.dataset.target), ["Plan", "Trips/Kampala"]);
});

test("on the cursor's line a wikilink shows its brackets", async () => {
  const { view } = setup("[[Plan]]‸");
  await focus(view);
  assert.deepEqual(hidden(decorations(view)), []);
  assert.ok(view.dom.querySelector(".cm-wikilink"));
});

test("an embed is not a link", () => {
  const { view } = setup("‸\n![[photo.png]]");
  assert.ok(!view.dom.querySelector(".cm-wikilink"));
});

test("tags are styled and carry their name", () => {
  const { view } = setup("‸\n#todo and #a/b-c, not C# or #1");
  const tags = [...view.dom.querySelectorAll<HTMLElement>(".cm-tag")];
  assert.deepEqual(tags.map((t) => [t.textContent, t.dataset.tag]), [
    ["#todo", "todo"],
    ["#a/b-c", "a/b-c"],
  ]);
});

test("a heading's own # is not a tag, but a tag in a heading is", () => {
  const { view } = setup("‸\n# Title #tag");
  const tags = [...view.dom.querySelectorAll<HTMLElement>(".cm-tag")];
  assert.deepEqual(tags.map((t) => t.dataset.tag), ["tag"]);
});

test("frontmatter is dimmed and never rendered as Markdown", async () => {
  const doc = "---\ntitle: *x* [[Plan]] #tag\n---\n‸Body";
  const { view } = setup(doc);
  await focus(view);
  select(view, "---\ntitle: *x* [[Plan]] #tag\n---\nBody‸");
  const decos = decorations(view);
  const frontmatter = decos.filter((d) => d.from < view.state.doc.line(4).from);
  assert.deepEqual(seen(frontmatter), ["cm-frontmatter:", "cm-frontmatter:", "cm-frontmatter:"]);
});

test("frontmatter stays as typed while the cursor is inside it", async () => {
  const { view } = setup("---\nti‸tle: x\n---\nBody");
  await focus(view);
  assert.ok(!view.dom.querySelector(".cm-hr-line"));
  assert.deepEqual(hidden(decorations(view)), []);
});

test("Markdown right after the frontmatter renders as usual", () => {
  const { view } = setup("---\na: 1\n---\n# Title **b**‸");
  assert.deepEqual(lineClasses(decorations(view)), ["cm-frontmatter", "cm-frontmatter", "cm-frontmatter", "cm-h cm-h1"]);
  assert.deepEqual(hidden(decorations(view)), ["# ", "**", "**"]);
});

test("a note that starts with --- but never closes it has no frontmatter", () => {
  const { view } = setup("---\n‸Body");
  assert.ok(!decorations(view).some((d) => d.kind === "cm-frontmatter"));
});

test("unicode text around marks keeps the right ranges", () => {
  const { view } = setup("‸\n🎉 **café** [[Ünïcode]] #日本");
  const decos = decorations(view);
  assert.deepEqual(seen(decos.filter((d) => d.kind === "cm-strong" || d.kind === "cm-wikilink")), [
    "cm-strong:**café**",
    "cm-wikilink:[[Ünïcode]]",
  ]);
});

test("an empty note draws nothing", () => {
  const { view } = setup("‸");
  assert.deepEqual(decorations(view), []);
});

test("typing updates the decorations", () => {
  const { view } = setup("‸");
  view.dispatch({ changes: { from: 0, insert: "\n**b**" } });
  assert.ok(decorations(view).some((d) => d.kind === "cm-strong"));
});

test("clicking a wikilink off the cursor's line opens the note", () => {
  const { view, onOpenLink } = setup("‸\n[[Plan|the plan]]");
  const e = mousedown(view.dom.querySelector(".cm-wikilink")!);
  assert.deepEqual(onOpenLink.mock.calls, [["Plan"]]);
  assert.ok(e.defaultPrevented);
});

test("clicking a wikilink on the cursor's line places the cursor; Cmd or Ctrl click opens it", async () => {
  const { view, onOpenLink } = setup("[[Plan]]‸");
  await focus(view);
  const link = view.dom.querySelector(".cm-wikilink")!;
  mousedown(link);
  assert.equal(onOpenLink.mock.calls.length, 0);
  mousedown(link, { metaKey: true });
  mousedown(link, { ctrlKey: true });
  assert.deepEqual(onOpenLink.mock.calls, [["Plan"], ["Plan"]]);
});

test("clicking a web link asks the app to open its address", () => {
  const { view } = setup("‸\n[site](https://example.com)");
  const opened = vi.fn();
  const listener = (e: Event) => opened((e as CustomEvent).detail);
  window.addEventListener("wandika:open-url", listener);
  try {
    mousedown(view.dom.querySelector(".cm-md-link")!);
  } finally {
    window.removeEventListener("wandika:open-url", listener);
  }
  assert.deepEqual(opened.mock.calls, [["https://example.com"]]);
});

test("clicking a tag shows it, except a plain click on the cursor's line", async () => {
  const { view, onTag } = setup("‸\n#todo");
  mousedown(view.dom.querySelector(".cm-tag")!);
  assert.deepEqual(onTag.mock.calls, [["todo"]]);
  await focus(view);
  select(view, "\n#todo‸");
  mousedown(view.dom.querySelector(".cm-tag")!);
  assert.equal(onTag.mock.calls.length, 1);
  mousedown(view.dom.querySelector(".cm-tag")!, { ctrlKey: true });
  assert.deepEqual(onTag.mock.calls, [["todo"], ["todo"]]);
});

test("clicking plain text opens nothing", () => {
  const { view, onOpenLink, onTag } = setup("‸\nplain");
  mousedown(view.dom.querySelectorAll(".cm-line")[1]);
  assert.equal(onOpenLink.mock.calls.length + onTag.mock.calls.length, 0);
});
