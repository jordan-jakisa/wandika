import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetSheets, sheetBack, sheetOpened } from "./backstack";

beforeEach(() => {
  resetSheets();
  Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
  history.replaceState(null, "");
});
afterEach(() => vi.useRealTimers());

test("a sheet takes one history entry; back closes the top sheet only", () => {
  const first = vi.fn();
  const second = vi.fn();
  sheetOpened(first);
  sheetOpened(second);
  expect(history.state).toMatchObject({ wandika: "sheet" });
  expect(sheetBack()).toBe(true);
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});

test("a sheet that closes by itself gives its entry back, and that step isn't a back", () => {
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  const close = vi.fn();
  const release = sheetOpened(close);
  release();
  expect(back).toHaveBeenCalledTimes(1);
  expect(sheetBack()).toBe(true);
  expect(close).not.toHaveBeenCalled();
  expect(sheetBack()).toBe(false);
});

test("a sheet that asks first and stays open keeps its place in history", () => {
  vi.useFakeTimers();
  sheetOpened(() => {});
  const push = vi.spyOn(history, "pushState");
  sheetBack();
  vi.runAllTimers();
  expect(push).toHaveBeenCalledWith(expect.objectContaining({ wandika: "sheet" }), "");
});

test("on a wide screen there's no history to keep", () => {
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  const push = vi.spyOn(history, "pushState");
  sheetOpened(() => {});
  expect(push).not.toHaveBeenCalled();
  expect(sheetBack()).toBe(false);
});
