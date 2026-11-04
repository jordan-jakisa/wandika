import "@testing-library/jest-dom/vitest";
import "../../test/components-views";
import { fireEvent, render, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import Resizer from "./Resizer.svelte";

/** Moves land once per screen frame. */
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function setup(over: Partial<{ edge: "left" | "right"; value: number }> = {}) {
  const onchange = vi.fn();
  const props = { edge: "right" as const, value: 260, min: 200, max: 400, initial: 260, label: "Resize the sidebar", onchange, ...over };
  const r = render(Resizer, props);
  return { ...r, onchange, handle: within(r.container).getByRole("separator", { name: "Resize the sidebar" }) };
}

test("is a focusable vertical separator that reports its width and limits", () => {
  const { handle } = setup();
  expect(handle).toHaveAttribute("aria-orientation", "vertical");
  expect(handle).toHaveAttribute("aria-valuenow", "260");
  expect(handle).toHaveAttribute("aria-valuemin", "200");
  expect(handle).toHaveAttribute("aria-valuemax", "400");
  expect(handle).toHaveAttribute("tabindex", "0");
});

test("follows the new width when the column changes", async () => {
  const { handle, rerender } = setup();
  await rerender({ value: 300 });
  expect(handle).toHaveAttribute("aria-valuenow", "300");
});

describe("keyboard", () => {
  test("arrows grow and shrink a right-edge column by 16, Shift by 48", async () => {
    const user = userEvent.setup();
    const { handle, onchange } = setup();
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(onchange).toHaveBeenLastCalledWith(276);
    await user.keyboard("{ArrowLeft}");
    expect(onchange).toHaveBeenLastCalledWith(244);
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onchange).toHaveBeenLastCalledWith(308);
  });

  test("a left-edge column grows with the left arrow", async () => {
    const user = userEvent.setup();
    const { handle, onchange } = setup({ edge: "left" });
    handle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(onchange).toHaveBeenLastCalledWith(276);
    await user.keyboard("{ArrowRight}");
    expect(onchange).toHaveBeenLastCalledWith(244);
  });

  test("Home and End jump to the limits", async () => {
    const user = userEvent.setup();
    const { handle, onchange } = setup();
    handle.focus();
    await user.keyboard("{Home}");
    expect(onchange).toHaveBeenLastCalledWith(200);
    await user.keyboard("{End}");
    expect(onchange).toHaveBeenLastCalledWith(400);
  });

  test("never goes past the limits", async () => {
    const user = userEvent.setup();
    const { handle, onchange } = setup({ value: 395 });
    handle.focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onchange).toHaveBeenLastCalledWith(400);
    const low = setup({ value: 205 });
    low.handle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(low.onchange).toHaveBeenLastCalledWith(200);
  });

  test("other keys are left alone", async () => {
    const user = userEvent.setup();
    const { handle, onchange } = setup();
    handle.focus();
    await user.keyboard("{ArrowUp}a{Tab}");
    expect(onchange).not.toHaveBeenCalled();
  });
});

describe("pointer", () => {
  test("dragging away from a right-edge column widens it", async () => {
    const { handle, onchange } = setup();
    await fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    await fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140 });
    await frame();
    expect(onchange).toHaveBeenLastCalledWith(300);
    await fireEvent.pointerMove(handle, { pointerId: 1, clientX: 70 });
    await frame();
    expect(onchange).toHaveBeenLastCalledWith(230);
  });

  test("dragging a left-edge handle to the left widens its column", async () => {
    const { handle, onchange } = setup({ edge: "left" });
    await fireEvent.pointerDown(handle, { pointerId: 1, clientX: 500 });
    await fireEvent.pointerMove(handle, { pointerId: 1, clientX: 450 });
    await frame();
    expect(onchange).toHaveBeenLastCalledWith(310);
  });

  test("a drag clamps to the limits", async () => {
    const { handle, onchange } = setup();
    await fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    await fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    await frame();
    expect(onchange).toHaveBeenLastCalledWith(400);
    await fireEvent.pointerMove(handle, { pointerId: 1, clientX: -900 });
    await frame();
    expect(onchange).toHaveBeenLastCalledWith(200);
  });

  test("captures the pointer so the drag keeps going off the handle", async () => {
    const { handle } = setup();
    const capture = vi.spyOn(handle, "setPointerCapture");
    await fireEvent.pointerDown(handle, { pointerId: 7, clientX: 0 });
    expect(capture).toHaveBeenCalledWith(7);
  });

  test("moving without pressing, or after letting go, changes nothing", async () => {
    const { handle, onchange } = setup();
    await fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140 });
    await frame();
    expect(onchange).not.toHaveBeenCalled();
    await fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    await fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 });
    await fireEvent.pointerMove(handle, { pointerId: 1, clientX: 160 });
    await frame();
    expect(onchange).not.toHaveBeenCalled();
  });

  test("a cancelled pointer ends the drag", async () => {
    const { handle, onchange } = setup();
    await fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    await fireEvent.pointerCancel(handle, { pointerId: 1 });
    await fireEvent.pointerMove(handle, { pointerId: 1, clientX: 160 });
    await frame();
    expect(onchange).not.toHaveBeenCalled();
  });

  test("shows it is being dragged while held", async () => {
    const { handle } = setup();
    await fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 });
    expect(handle).toHaveClass("dragging");
    await fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handle).not.toHaveClass("dragging");
  });
});

test("double-click resets to the starting width", async () => {
  const user = userEvent.setup();
  const { handle, onchange } = setup({ value: 380 });
  await user.dblClick(handle);
  expect(onchange).toHaveBeenLastCalledWith(260);
});

test("says how to use it on hover", () => {
  const { handle } = setup();
  expect(handle).toHaveAttribute("title", "Drag to resize. Double-click to reset.");
});
