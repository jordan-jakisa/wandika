import { beforeEach, expect, test, vi } from "vitest";
import { storageFull } from "../test/lib";

const KEY = "wandika.positions";

/** A fresh module that loads whatever is in storage now. */
async function fresh() {
  vi.resetModules();
  return import("./positions");
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test("starts empty", async () => {
  const { positions } = await fresh();
  expect(positions.size).toBe(0);
});

test("a position is remembered and survives a restart", async () => {
  const first = await fresh();
  first.remember("Notes/Plan.md", { top: 120, anchor: 5, head: 9 });
  first.remember("Café/日本.md", { top: 0, anchor: 0, head: 0 });
  const { positions } = await fresh();
  expect(positions.get("Notes/Plan.md")).toEqual({ top: 120, anchor: 5, head: 9 });
  expect(positions.get("Café/日本.md")).toEqual({ top: 0, anchor: 0, head: 0 });
});

test("remembering again replaces the old position", async () => {
  const { positions, remember } = await fresh();
  remember("a.md", { top: 1, anchor: 1, head: 1 });
  remember("a.md", { top: 2, anchor: 2, head: 2 });
  expect(positions.size).toBe(1);
  expect(positions.get("a.md")!.top).toBe(2);
});

test("only the last 200 notes are kept, oldest out first", async () => {
  const { positions, remember } = await fresh();
  for (let i = 0; i < 205; i++) remember(`n${i}.md`, { top: i, anchor: 0, head: 0 });
  expect(positions.size).toBe(200);
  expect(positions.has("n4.md")).toBe(false);
  expect(positions.has("n5.md")).toBe(true);
  // Opening an old note again makes it the newest.
  remember("n5.md", { top: 5, anchor: 0, head: 0 });
  remember("new.md", { top: 0, anchor: 0, head: 0 });
  expect(positions.has("n5.md")).toBe(true);
  expect(positions.has("n6.md")).toBe(false);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(200);
});

test.each([["not json"], ["{}"], ["5"], ['"text"'], ["[1, 2]"], ["null"]])("damaged storage (%s) starts empty", async (raw) => {
  localStorage.setItem(KEY, raw);
  const { positions, remember } = await fresh();
  expect(positions.size).toBe(0);
  remember("a.md", { top: 1, anchor: 2, head: 3 });
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([["a.md", { top: 1, anchor: 2, head: 3 }]]);
});

test("entries that aren't positions are dropped, good ones kept", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify([
      ["good.md", { top: 1, anchor: 2, head: 3 }],
      ["null.md", null],
      ["text.md", "top"],
      ["half.md", { top: 1 }],
      [7, { top: 1, anchor: 2, head: 3 }],
    ]),
  );
  const { positions } = await fresh();
  expect([...positions.keys()]).toEqual(["good.md"]);
});

test("storage that refuses writes keeps positions for this session", async () => {
  const { positions, remember } = await fresh();
  storageFull();
  expect(() => remember("a.md", { top: 1, anchor: 1, head: 1 })).not.toThrow();
  expect(positions.get("a.md")!.top).toBe(1);
});
