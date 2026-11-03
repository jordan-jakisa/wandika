import { beforeEach, expect, test, vi } from "vitest";
import { storageFull } from "../test/lib";
import { readView, saveView } from "./viewPrefs";

const KEY = "wandika.views";
const graph = { ghosts: false, orphans: true, dotSize: 1, depth: 1 };

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test("nothing saved gives the defaults", () => {
  expect(readView("graph", graph)).toEqual(graph);
});

test("a saved view comes back, each view on its own", () => {
  saveView("graph", { ...graph, ghosts: true, dotSize: 2 });
  saveView("tasks", { showDone: true });
  expect(readView("graph", graph)).toEqual({ ...graph, ghosts: true, dotSize: 2 });
  expect(readView("tasks", { showDone: false })).toEqual({ showDone: true });
});

test("a choice added since the view was saved takes its default", () => {
  saveView("graph", { ghosts: true });
  expect(readView("graph", graph)).toEqual({ ...graph, ghosts: true });
});

test("a value of the wrong type takes its default", () => {
  localStorage.setItem(KEY, JSON.stringify({ graph: { ghosts: "yes", dotSize: "big", depth: null, orphans: false } }));
  expect(readView("graph", graph)).toEqual({ ...graph, orphans: false });
});

test("the defaults themselves are never changed", () => {
  const defaults = { showDone: false };
  readView("tasks", defaults).showDone = true;
  localStorage.setItem(KEY, "not json");
  readView("tasks", defaults).showDone = true;
  expect(defaults.showDone).toBe(false);
});

test.each([["not json"], ["null"], ["[]"], ["7"], ['{"graph": "text"}'], ['{"graph": [true]}']])(
  "damaged storage (%s) gives the defaults, and saving works again",
  (raw) => {
    localStorage.setItem(KEY, raw);
    expect(readView("graph", graph)).toEqual(graph);
    saveView("tasks", { showDone: true });
    expect(readView("tasks", { showDone: false })).toEqual({ showDone: true });
  },
);

test("storage that refuses writes breaks nothing", () => {
  storageFull();
  expect(() => saveView("tasks", { showDone: true })).not.toThrow();
  expect(readView("tasks", { showDone: false })).toEqual({ showDone: false });
});

test("storage that can't be read gives the defaults", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  expect(readView("graph", graph)).toEqual(graph);
  expect(() => saveView("graph", graph)).not.toThrow();
});
