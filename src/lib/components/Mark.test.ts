import { render } from "@testing-library/svelte";
import { expect, test } from "vitest";
import Mark from "./Mark.svelte";

test("draws the mark as one svg", () => {
  const { container } = render(Mark);
  expect(container.querySelectorAll("svg")).toHaveLength(1);
});

test("is 40px by default and takes a size", () => {
  const { container } = render(Mark);
  expect(container.querySelector("svg")).toHaveAttribute("width", "40");
  const big = render(Mark, { size: 96 }).container.querySelector("svg");
  expect(big).toHaveAttribute("width", "96");
  expect(big).toHaveAttribute("height", "96");
});

test("is decoration, hidden from screen readers", () => {
  const { container } = render(Mark);
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});

test("draws in the accent colour so it follows the theme", () => {
  const { container } = render(Mark);
  expect(container.querySelector("rect")).toHaveAttribute("fill", "var(--papyrus)");
  expect(container.querySelector("polyline")).toHaveAttribute("stroke", "var(--on-papyrus)");
});
