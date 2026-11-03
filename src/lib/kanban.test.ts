import assert from "node:assert/strict";
import { test } from "vitest";
import { newCard, parse, serialize, TEMPLATE, tokens } from "./kanban.ts";

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
