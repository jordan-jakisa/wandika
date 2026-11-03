import assert from "node:assert/strict";
import { test } from "vitest";
import { isBoard, LINK, newCard, newLane, parse, serialize, tagsOf, TEMPLATE, tokens } from "./kanban.ts";

test("a new board round-trips unchanged", () => {
  const b = parse(TEMPLATE);
  assert.deepEqual(b.lanes.map((l) => l.title), ["To do", "Doing", "Done"]);
  assert.equal(b.lanes[2].complete, true);
  assert.equal(serialize(b), TEMPLATE);
});

test("cards keep links, tags and extra lines", () => {
  const b = parse(TEMPLATE);
  b.lanes[0].cards.push(newCard("Ship [[Wandika]] #launch"), newCard("Two lines\nsecond"));
  const again = parse(serialize(b));
  assert.equal(again.lanes[0].cards[0].text, "Ship [[Wandika]] #launch");
  assert.equal(again.lanes[0].cards[1].text, "Two lines\nsecond");
  assert.ok(again.tail.includes("kanban:settings"));
});

test("card text splits into text, links and tags", () => {
  assert.deepEqual(
    tokens("Ship [[Wandika|app]] #launch now").map((t) => t.kind),
    ["text", "link", "text", "tag", "text"],
  );
});

test("a board is a note whose frontmatter names the Kanban plugin", () => {
  assert.equal(isBoard(TEMPLATE), true);
  assert.equal(isBoard("---\nkanban-plugin: board\n---\n"), true);
  assert.equal(isBoard("---\ntags: [a]\n  kanban-plugin: basic\n---"), true);
  assert.equal(isBoard("---\ntags: [a]\n---\nkanban-plugin: basic"), false);
  assert.equal(isBoard("# Plan\n\nkanban-plugin: basic"), false);
  assert.equal(isBoard(""), false);
  // Unclosed frontmatter still counts, as Obsidian reads it.
  assert.equal(isBoard("---\nkanban-plugin: basic"), true);
});

test("lanes, done cards and the Complete lane", () => {
  const b = parse("## Ideas\n\n- [ ] One\n* [x] Two\n+ [X] Three\n- [ ]\n\n## Shipped\n\n**Complete**\n- [x] Four\n");
  assert.deepEqual(
    b.lanes.map((l) => [l.title, l.complete, l.cards.map((c) => [c.text, c.done])]),
    [
      ["Ideas", false, [["One", false], ["Two", true], ["Three", true], ["", false]]],
      ["Shipped", true, [["Four", true]]],
    ],
  );
  assert.equal(b.frontmatter, "");
});

test("a card's indented lines belong to it, blank lines don't end it, other text does", () => {
  const b = parse("## L\n\n- [ ] First\n\tsecond\n    third\n\n  fourth\nloose text\n  not a card line\n- [ ] Next\n");
  assert.deepEqual(
    b.lanes[0].cards.map((c) => c.text),
    ["First\nsecond\nthird\nfourth", "Next"],
  );
});

test("the archive and settings after the lanes are kept as written", () => {
  const text = "## L\n\n- [ ] A\n\n\n***\n\n## Archive\n\n- [x] Old\n\n%% kanban:settings\n```\n{}\n```\n%%\n";
  const b = parse(text);
  assert.equal(b.lanes.length, 1);
  assert.ok(b.tail.startsWith("***"));
  assert.ok(b.tail.includes("- [x] Old"));
  assert.equal(serialize(b), text);
});

test("a board with no settings ends with one newline", () => {
  const b = parse("## A\n\n- [ ] One\n\n\n\n\n");
  assert.equal(serialize(b), "## A\n\n- [ ] One\n");
});

test("an empty board has no lanes and saves as nothing", () => {
  const b = parse("");
  assert.deepEqual(b, { frontmatter: "", lanes: [], tail: "" });
  assert.equal(serialize(b), "");
});

test("Windows line endings are read like Unix ones and written back as \\n", () => {
  const b = parse(TEMPLATE.replace(/\n/g, "\r\n").replace("## To do\r\n", "## To do\r\n\r\n- [ ] Card\r\n"));
  assert.equal(b.frontmatter, "---\n\nkanban-plugin: basic\n\n---");
  assert.equal(b.lanes[0].cards[0].text, "Card");
  assert.ok(isBoard(serialize(b)));
  assert.ok(!serialize(b).includes("\r"));
});

test("text above the first lane survives a save", () => {
  const text = "---\n\nkanban-plugin: basic\n\n---\n\nPlanning for **Q4**.\nSee [[Roadmap]].\n\n## To do\n\n- [ ] A\n";
  const b = parse(text);
  assert.equal(b.frontmatter, "---\n\nkanban-plugin: basic\n\n---\n\nPlanning for **Q4**.\nSee [[Roadmap]].");
  assert.equal(b.lanes[0].title, "To do");
  assert.equal(serialize(b), text);
  assert.equal(serialize(parse(serialize(b))), text);
});

test("moving a card keeps its text and takes the lane's done state when saved by the board", () => {
  const b = parse(TEMPLATE);
  const card = newCard("Ship it");
  b.lanes[0].cards.push(card);
  b.lanes[2].cards.push(b.lanes[0].cards.pop()!);
  card.done = b.lanes[2].complete;
  const again = parse(serialize(b));
  assert.deepEqual(again.lanes[2].cards.map((c) => [c.text, c.done]), [["Ship it", true]]);
});

test("new lanes and cards get unique ids", () => {
  const ids = [newLane("A").id, newLane("B").id, newCard("x").id, newCard("x").id, ...parse(TEMPLATE).lanes.map((l) => l.id)];
  assert.equal(new Set(ids).size, ids.length);
  const { id, ...lane } = newLane("Later");
  assert.match(id, /^k\d+$/);
  assert.deepEqual(lane, { title: "Later", complete: false, cards: [] });
  assert.deepEqual({ ...newCard("Two\nlines"), id: "" }, { id: "", text: "Two\nlines", done: false });
});

test("tags are read whole, in any script, and only after a space", () => {
  assert.deepEqual(tagsOf("#launch and #café, #日本 #a/b-c_1 not#tag #1x #Ü"), ["launch", "café", "a/b-c_1"]);
  assert.deepEqual(tagsOf("#naïve #straße"), ["naïve", "straße"]);
  assert.deepEqual(tagsOf(""), []);
  // Repeated calls give the same answer (the shared pattern keeps no state).
  assert.deepEqual(tagsOf("#a"), tagsOf("#a"));
});

test("links show their alias, drop a heading and keep surrounding text", () => {
  assert.deepEqual(tokens("See [[Plan#Goals|the plan]] now"), [
    { kind: "text", text: "See " },
    { kind: "link", target: "Plan", label: "the plan" },
    { kind: "text", text: " now" },
  ]);
  assert.deepEqual(tokens("[[ Plan ]]"), [{ kind: "link", target: "Plan", label: "Plan" }]);
  assert.deepEqual(tokens("#café time"), [
    { kind: "tag", tag: "café" },
    { kind: "text", text: " time" },
  ]);
  assert.deepEqual(tokens("plain"), [{ kind: "text", text: "plain" }]);
  assert.deepEqual(tokens(""), []);
  assert.deepEqual(tokens("[[broken"), [{ kind: "text", text: "[[broken" }]);
});

test("LINK finds targets and aliases", () => {
  const found = [..."[[A]] [[B#h|b]] [[C|c]]".matchAll(LINK)].map((m) => [m[1], m[2] ?? null]);
  assert.deepEqual(found, [
    ["A", null],
    ["B", "b"],
    ["C", "c"],
  ]);
});
