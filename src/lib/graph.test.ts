import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph, resolver } from "./graph.ts";

const notes = [
  { path: "Home.md", title: "Home", links: ["Plan", "Projects/Plan", "Missing", "Home"] },
  { path: "Projects/Plan.md", title: "Plan", links: ["Home"] },
  { path: "Archive/Plan.md", title: "Plan", links: [] },
  { path: "Lonely.md", title: "Lonely", links: [] },
];

test("links resolve like Obsidian: shortest path for a bare name, exact for a path", () => {
  const r = resolver(notes);
  assert.equal(r("plan"), "Archive/Plan.md");
  assert.equal(r("Projects/Plan"), "Projects/Plan.md");
  assert.equal(r("Nope"), null);
});

test("graph dedupes links and drops self links", () => {
  const g = buildGraph(notes);
  assert.equal(g.nodes.length, 4);
  assert.equal(g.links.length, 2);
  assert.equal(g.nodes.find((n) => n.id === "Home.md")!.degree, 2);
});

test("ghost nodes appear only when asked for", () => {
  assert.ok(buildGraph(notes, { ghosts: true }).nodes.some((n) => n.ghost && n.title === "Missing"));
});

test("local graph keeps the focus and its neighbours", () => {
  const g = buildGraph(notes, { focus: "Projects/Plan.md", depth: 1 });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["Home.md", "Projects/Plan.md"]);
});
