import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { VaultTask } from "./types";

async function fresh() {
  vi.resetModules();
  return import("./focus.svelte");
}

const task: VaultTask = { path: "Plan.md", title: "Plan", line: 2, text: "Write the brief", done: false, due: null, details: "" };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

test("a round counts down from the chosen length and ends once, with the chime", async () => {
  const { focus } = await fresh();
  const ended = vi.fn();
  focus.onEnd = ended;
  focus.start({ text: "Write the brief", task }, 15);
  expect(focus.left).toBe(15 * 60_000);
  expect(focus.phase).toBe("focus");
  vi.advanceTimersByTime(60_000);
  expect(focus.left).toBe(14 * 60_000);
  vi.advanceTimersByTime(14 * 60_000);
  expect(focus.left).toBe(0);
  expect(focus.finished).toBe(true);
  expect(focus.rounds).toBe(1);
  vi.advanceTimersByTime(60_000);
  expect(ended).toHaveBeenCalledTimes(1);
  expect(ended).toHaveBeenCalledWith("focus");
});

test("time left follows the clock, so a sleeping app still ends on time", async () => {
  const { focus } = await fresh();
  focus.start({ text: "x" }, 25);
  // The interval doesn't fire while the clock jumps, as when the Mac sleeps.
  vi.setSystemTime(Date.now() + 10 * 60_000);
  vi.advanceTimersByTime(250);
  expect(focus.left).toBe(15 * 60_000 - 250);
});

test("pause holds the time; resume carries on from there", async () => {
  const { focus } = await fresh();
  focus.start({ text: "x" }, 25);
  vi.advanceTimersByTime(5 * 60_000);
  focus.pause();
  const held = focus.left;
  vi.advanceTimersByTime(30 * 60_000);
  expect(focus.left).toBe(held);
  expect(focus.finished).toBe(false);
  focus.resume();
  vi.advanceTimersByTime(60_000);
  expect(focus.left).toBe(held - 60_000);
});

test("after a round: a five-minute break, then another round of the same length", async () => {
  const { focus, BREAK_MINUTES } = await fresh();
  focus.start({ text: "x", task }, 50);
  vi.advanceTimersByTime(50 * 60_000);
  focus.takeBreak();
  expect([focus.phase, focus.left, focus.finished]).toEqual(["break", BREAK_MINUTES * 60_000, false]);
  vi.advanceTimersByTime(BREAK_MINUTES * 60_000);
  expect(focus.finished).toBe(true);
  expect(focus.rounds).toBe(1); // a break is not a round
  focus.again();
  expect([focus.phase, focus.left]).toEqual(["focus", 50 * 60_000]);
  vi.advanceTimersByTime(50 * 60_000);
  expect(focus.rounds).toBe(2);
});

test("the chosen length is remembered on this device; odd lengths fall back to 25", async () => {
  let { focus } = await fresh();
  focus.start({ text: "x" }, 50);
  focus.stop();
  ({ focus } = await fresh());
  expect(focus.minutes).toBe(50);
  focus.start({ text: "x" }, 7);
  expect(focus.minutes).toBe(25);
});

test("changing the length starts the round again; stop clears everything", async () => {
  const { focus } = await fresh();
  focus.start({ text: "x", task });
  vi.advanceTimersByTime(60_000);
  focus.setLength(15);
  expect(focus.left).toBe(15 * 60_000);
  focus.stop();
  expect([focus.active, focus.rounds, focus.paused, focus.finished]).toEqual([null, 0, false, false]);
  vi.advanceTimersByTime(60 * 60_000);
  expect(focus.left).toBe(15 * 60_000); // a stopped timer doesn't tick
});

test("a new task starts its round count again", async () => {
  const { focus } = await fresh();
  focus.start({ text: "One", task });
  vi.advanceTimersByTime(25 * 60_000);
  expect(focus.rounds).toBe(1);
  focus.start({ text: "Two" });
  expect(focus.rounds).toBe(0);
});

test("clock text reads like a timer", async () => {
  const { clockText } = await fresh();
  expect(clockText(25 * 60_000)).toBe("25:00");
  expect(clockText(59_001)).toBe("1:00");
  expect(clockText(9_000)).toBe("0:09");
  expect(clockText(0)).toBe("0:00");
  expect(clockText(62 * 60_000)).toBe("1:02:00");
});
