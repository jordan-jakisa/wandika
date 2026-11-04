import { beforeEach, expect, test } from "vitest";
import { display, fromEvent, shortcuts, usable } from "./shortcuts.svelte";

beforeEach(() => shortcuts.reset());

const press = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

test("a key press reads by the key's place, so ⇧8 is 8 and the - key works", () => {
  expect(fromEvent(press({ key: "*", code: "Digit8", ctrlKey: true, shiftKey: true }))).toBe("Mod-Shift-8");
  expect(fromEvent(press({ key: "-", code: "Minus", ctrlKey: true }))).toBe("Mod--");
  expect(fromEvent(press({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBeNull();
  expect(fromEvent(press({ key: "F6", code: "F6" }))).toBe("F6");
});

test("presses match the table, defaults and changes alike, in their own group only", () => {
  expect(shortcuts.match(press({ key: "k", code: "KeyK", ctrlKey: true }), ["App"])).toBe("search");
  expect(shortcuts.match(press({ key: "b", code: "KeyB", ctrlKey: true }), ["App"])).toBeNull();
  expect(shortcuts.match(press({ key: "b", code: "KeyB", ctrlKey: true }), ["Editing"])).toBe("bold");
  shortcuts.set("bold", ["Mod-Shift-b"]);
  expect(shortcuts.match(press({ key: "b", code: "KeyB", ctrlKey: true }), ["Editing"])).toBeNull();
  expect(shortcuts.match(press({ key: "B", code: "KeyB", ctrlKey: true, shiftKey: true }), ["Editing"])).toBe("bold");
});

test("a shortcut set back to its default is no longer a change, and changes are kept", () => {
  shortcuts.set("daily", ["Alt-Mod-d"]);
  expect(JSON.parse(localStorage.getItem("wandika.shortcuts")!)).toEqual({ daily: ["Alt-Mod-d"] });
  shortcuts.set("daily", ["Mod-d"]);
  expect(shortcuts.isChanged("daily")).toBe(false);
});

test("a shortcut needs a modifier unless it's a function key, and reads plainly", () => {
  expect(usable("t")).toBe(false);
  expect(usable("Shift-t")).toBe(false);
  expect(usable("F8")).toBe(true);
  expect(usable("Alt-t")).toBe(true);
  expect(display("Alt-ArrowUp")).toMatch(/↑$/);
  expect(display("Mod-Enter")).toMatch(/Return$/);
});
