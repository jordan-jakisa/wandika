import assert from "node:assert/strict";
import { test } from "vitest";
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

test("orphans can be hidden and notes carry their top folder", () => {
  const g = buildGraph(notes, { orphans: false });
  assert.ok(!g.nodes.some((n) => n.id === "Lonely.md"));
  assert.equal(g.nodes.find((n) => n.id === "Projects/Plan.md")!.group, "Projects");
});

test("links ignore case, spaces and a .md ending, and need a whole name", () => {
  const r = resolver(notes);
  assert.equal(r(" HOME "), "Home.md");
  assert.equal(r("Home.md"), "Home.md");
  assert.equal(r("home.MD"), "Home.md");
  assert.equal(r("Hom"), null);
  assert.equal(r("jects/Plan"), null);
  assert.equal(r(""), null);
  assert.equal(r("   "), null);
});

test("a folder link matches the end of a longer path", () => {
  const r = resolver([...notes, { path: "Work/Projects/Deep.md", title: "Deep", links: [] }]);
  assert.equal(r("Projects/Deep"), "Work/Projects/Deep.md");
  assert.equal(r("Work/Projects/Deep"), "Work/Projects/Deep.md");
});

test("encrypted notes and other scripts resolve too", () => {
  const r = resolver([
    { path: "Private/Bank.md.age", title: "Bank", links: [] },
    { path: "Café/日本.md", title: "日本", links: [] },
  ]);
  assert.equal(r("Bank"), "Private/Bank.md.age");
  assert.equal(r("Private/Bank"), "Private/Bank.md.age");
  assert.equal(r("日本"), "Café/日本.md");
  assert.equal(r("café/日本"), "Café/日本.md");
});

test("an empty vault is an empty graph", () => {
  assert.deepEqual(buildGraph([]), { nodes: [], links: [] });
  assert.deepEqual(buildGraph([], { focus: "Home.md" }), { nodes: [], links: [] });
});

test("a link both ways is one line, and degrees count each neighbour once", () => {
  const g = buildGraph([
    { path: "A.md", title: "A", links: ["B", "B", "b"] },
    { path: "B.md", title: "B", links: ["A"] },
  ]);
  assert.equal(g.links.length, 1);
  assert.deepEqual(g.nodes.map((n) => n.degree), [1, 1]);
});

test("ghosts are one per missing name, whatever its case, and count as neighbours", () => {
  const g = buildGraph(
    [
      { path: "A.md", title: "A", links: ["Missing", "missing "] },
      { path: "B.md", title: "B", links: ["MISSING"] },
    ],
    { ghosts: true },
  );
  const ghosts = g.nodes.filter((n) => n.ghost);
  assert.equal(ghosts.length, 1);
  assert.deepEqual(ghosts[0], { id: "ghost:missing", title: "Missing", degree: 2, ghost: true, board: false, group: "" });
  assert.equal(g.links.length, 2);
});

test("boards and folders are marked on their nodes", () => {
  const g = buildGraph([
    { path: "Projects/Launch.md", title: "Launch", links: [], board: true },
    { path: "Root.md", title: "Root", links: [] },
  ]);
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.board, n.group]),
    [
      ["Projects/Launch.md", true, "Projects"],
      ["Root.md", false, ""],
    ],
  );
});

test("depth sets how far the local graph reaches", () => {
  const chain = ["A", "B", "C", "D"].map((t, i, all) => ({ path: `${t}.md`, title: t, links: all[i + 1] ? [all[i + 1]] : [] }));
  const ids = (depth: number) => buildGraph(chain, { focus: "A.md", depth }).nodes.map((n) => n.id);
  assert.deepEqual(ids(0), ["A.md"]);
  assert.deepEqual(ids(1), ["A.md", "B.md"]);
  assert.deepEqual(ids(2), ["A.md", "B.md", "C.md"]);
  assert.deepEqual(ids(9), ["A.md", "B.md", "C.md", "D.md"]);
  // Only the lines between kept notes.
  assert.equal(buildGraph(chain, { focus: "B.md", depth: 1 }).links.length, 2);
});

test("a focus that isn't a note shows the whole graph", () => {
  assert.equal(buildGraph(notes, { focus: "Nope.md" }).nodes.length, 4);
  assert.equal(buildGraph(notes, { focus: null }).nodes.length, 4);
});

test("the local graph keeps an orphan focus even with orphans hidden", () => {
  const g = buildGraph(notes, { focus: "Lonely.md", orphans: false });
  assert.deepEqual(g.nodes.map((n) => n.id), ["Lonely.md"]);
});
