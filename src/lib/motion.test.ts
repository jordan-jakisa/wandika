import { afterEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { duration } from "./motion";

const root = document.documentElement;

afterEach(() => {
  for (const t of ["--dur-instant", "--dur-quick", "--dur-base", "--dur-slow", "--dur-close"]) root.style.removeProperty(t);
});

test("reads a duration in milliseconds from CSS", () => {
  root.style.setProperty("--dur-base", "240ms");
  root.style.setProperty("--dur-quick", " 160ms ");
  expect(duration("--dur-base")).toBe(240);
  expect(duration("--dur-quick")).toBe(160);
});

test("a duration written in seconds is turned into milliseconds", () => {
  root.style.setProperty("--dur-slow", "0.36s");
  expect(duration("--dur-slow")).toBe(360);
});

test("reduced motion (0ms) is no time at all", () => {
  root.style.setProperty("--dur-instant", "0ms");
  expect(duration("--dur-instant")).toBe(0);
});

test("a missing or unreadable token is 0", () => {
  expect(duration("--dur-slow")).toBe(0);
  root.style.setProperty("--dur-slow", "fast");
  expect(duration("--dur-slow")).toBe(0);
});

describe("easing and sheet closing", () => {
  test("bezier follows CSS's cubic-bezier: ends fixed, ease-out runs ahead early", async () => {
    const { bezier } = await import("./motion");
    const ease = bezier(0.32, 0.72, 0, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.25)).toBeGreaterThan(0.5);
    const linear = bezier(0, 0, 1, 1);
    expect(linear(0.4)).toBeCloseTo(0.4, 3);
  });

  test("with no motion a sheet closes at once; with motion it leaves first", async () => {
    vi.useFakeTimers();
    const { closeSheet } = await import("./motion");
    const el = document.createElement("dialog");
    document.body.append(el);
    el.showModal = el.showModal ?? (() => el.setAttribute("open", ""));
    el.setAttribute("open", "");
    Object.defineProperty(el, "open", { get: () => el.hasAttribute("open"), configurable: true });
    el.close = () => el.removeAttribute("open");
    const done = vi.fn();
    closeSheet(el, done);
    expect(done).toHaveBeenCalledTimes(1);
    document.documentElement.style.setProperty("--dur-close", "240ms");
    el.setAttribute("open", "");
    closeSheet(el, done);
    expect(el).toHaveClass("closing");
    vi.advanceTimersByTime(240);
    expect(el.hasAttribute("open")).toBe(false);
    expect(el).not.toHaveClass("closing");
    expect(done).toHaveBeenCalledTimes(2);
    document.documentElement.style.removeProperty("--dur-close");
    vi.useRealTimers();
  });
});
