import { afterEach, expect, test } from "vitest";
import { push } from "./transitions";

const node = document.createElement("div");
const root = document.documentElement;

afterEach(() => root.style.removeProperty("--dur-base"));

test("a pushed screen takes the base duration from CSS", () => {
  root.style.setProperty("--dur-base", "240ms");
  expect(push(node).duration).toBe(240);
  expect(push(node, {}).duration).toBe(240);
});

test("turned off, or with reduced motion, it is instant", () => {
  root.style.setProperty("--dur-base", "240ms");
  expect(push(node, { enabled: false }).duration).toBe(0);
  root.style.setProperty("--dur-base", "0ms");
  expect(push(node).duration).toBe(0);
});

test("it slides from the right edge to its place", () => {
  const t = push(node);
  expect(t.css(0)).toBe("transform: translateX(calc(0px + 1 * (100% - 0px)))");
  expect(t.css(0.5)).toBe("transform: translateX(calc(0px + 0.5 * (100% - 0px)))");
  expect(t.css(1)).toBe("transform: translateX(calc(0px + 0 * (100% - 0px)))");
});

test("on the way out it starts from where the swipe let go", () => {
  const t = push(node, { from: 120 });
  expect(t.css(1)).toBe("transform: translateX(calc(120px + 0 * (100% - 120px)))");
  expect(t.css(0)).toBe("transform: translateX(calc(120px + 1 * (100% - 120px)))");
});

test("it eases out: fast at first, settling at the end", () => {
  const { easing } = push(node);
  expect(easing(0)).toBe(0);
  expect(easing(1)).toBe(1);
  expect(easing(0.5)).toBeCloseTo(0.875);
  expect(easing(0.25)).toBeGreaterThan(0.25);
  for (let t = 0; t < 1; t += 0.1) expect(easing(t + 0.1)).toBeGreaterThan(easing(t));
});
