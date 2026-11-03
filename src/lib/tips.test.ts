import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { storageFull } from "../test/lib";
import { tip } from "./tips";

const KEY = "wandika.tips";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a tip shows the first time only", () => {
  const show = vi.fn();
  tip("long-press", "Press and hold a note.", show);
  tip("long-press", "Press and hold a note.", show);
  expect(show).toHaveBeenCalledTimes(1);
  expect(show).toHaveBeenCalledWith("Press and hold a note.");
});

test("each tip is counted on its own and remembered on this device", () => {
  const show = vi.fn();
  tip("a", "A", show);
  tip("b", "B", show);
  expect(show).toHaveBeenCalledTimes(2);
  expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a", "b"]);
  tip("a", "A", show);
  expect(show).toHaveBeenCalledTimes(2);
});

test("a tip that can't be remembered isn't shown, so it can't repeat every time", () => {
  storageFull();
  const show = vi.fn();
  tip("a", "A", show);
  expect(show).not.toHaveBeenCalled();
});

test("damaged storage shows no tips rather than all of them again", () => {
  for (const raw of ["not json", "{}", "5"]) {
    localStorage.setItem(KEY, raw);
    const show = vi.fn();
    tip("a", "A", show);
    expect(show, raw).not.toHaveBeenCalled();
  }
});

test("storage that can't be read shows no tips", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("denied", "SecurityError");
  });
  const show = vi.fn();
  tip("a", "A", show);
  expect(show).not.toHaveBeenCalled();
});

test("touch is true on a phone's coarse pointer, false otherwise or without matchMedia", async () => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)" }));
  vi.resetModules();
  expect((await import("./tips")).touch).toBe(true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.resetModules();
  expect((await import("./tips")).touch).toBe(false);
  vi.stubGlobal("matchMedia", undefined);
  vi.resetModules();
  expect((await import("./tips")).touch).toBe(false);
});
