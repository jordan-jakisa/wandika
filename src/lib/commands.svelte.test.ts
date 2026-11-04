import { expect, test } from "vitest";
import { app } from "./app.svelte";
import { matchCommands, registerCommands } from "./commands.svelte";

const labels = (q: string) => matchCommands(q).map((c) => c.label);

test("every typed word starts a word of the name; names that start with it come first", () => {
  expect(labels("new no")[0]).toBe("New note");
  expect(labels("voice")).toEqual(["New voice note"]);
  expect(labels("today")[0]).toBe("Today full screen");
  expect(labels("today")).toContain("Open today's note");
});

test("a screen's commands come and go with it, and some only show when they apply", () => {
  const remove = registerCommands("test", [{ id: "x", label: "Export as PDF", run: () => {} }]);
  expect(labels("export")).toEqual(["Export as PDF"]);
  remove();
  expect(labels("export")).toEqual([]);
  app.status = null;
  expect(labels("sync")).toEqual([]);
});
