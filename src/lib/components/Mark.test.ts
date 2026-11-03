import { render } from "@testing-library/svelte";
import { expect, test } from "vitest";
import Mark from "./Mark.svelte";

test("draws the mark as one svg", () => {
  const { container } = render(Mark);
  expect(container.querySelectorAll("svg")).toHaveLength(1);
});
