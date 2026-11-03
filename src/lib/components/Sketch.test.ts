import "@testing-library/jest-dom/vitest";
import { resetApp } from "../../test/components-views";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../api";
import { app } from "../app.svelte";
import { toSvg } from "../sketch";
import Dialog from "./Dialog.svelte";
import Sketch from "./Sketch.svelte";

beforeEach(resetApp);
afterEach(() => vi.restoreAllMocks());

function open(edit: { target: string; from: string } | null = null) {
  const user = userEvent.setup();
  render(Dialog);
  const r = render(Sketch);
  const saved = vi.fn();
  app.drawing = { note: "Projects/Plan.md", edit, saved };
  flushSync();
  return { user, saved, pad: r.container.querySelector("svg.pad")! };
}

function draw(pad: Element, from: [number, number], to: [number, number], pointerType = "touch", id = 1) {
  fireEvent.pointerDown(pad, { pointerId: id, pointerType, clientX: from[0], clientY: from[1], pressure: 0.5 });
  fireEvent.pointerMove(pad, { pointerId: id, pointerType, clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2, pressure: 0.5 });
  fireEvent.pointerMove(pad, { pointerId: id, pointerType, clientX: to[0], clientY: to[1], pressure: 0.5 });
  fireEvent.pointerUp(pad, { pointerId: id, pointerType, clientX: to[0], clientY: to[1] });
}
const strokes = (pad: Element) => pad.querySelectorAll("path").length;

test("stays closed until a drawing is asked for, then opens full screen with an empty page", () => {
  const { container } = render(Sketch);
  expect(container.querySelector("dialog")).not.toHaveAttribute("open");
  container.remove();
  open();
  expect(screen.getByRole("dialog", { name: "Drawing" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Empty drawing" })).toBeInTheDocument();
  expect(screen.getByText("Draw with your pen, finger or mouse")).toBeInTheDocument();
});

test("a finger, a pen or a mouse draws a stroke; Undo takes it back", async () => {
  const { user, pad } = open();
  draw(pad, [10, 10], [100, 80], "touch");
  draw(pad, [20, 20], [60, 140], "mouse");
  expect(strokes(pad)).toBe(2);
  expect(screen.getByRole("img", { name: "Drawing with 2 strokes" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(strokes(pad)).toBe(1);
});

test("once a pen has drawn, a resting palm draws nothing", () => {
  const { pad } = open();
  draw(pad, [10, 10], [100, 80], "pen");
  draw(pad, [20, 200], [200, 220], "touch", 2);
  expect(strokes(pad)).toBe(1);
});

test("the eraser removes a stroke it passes over; Clear empties the page and can be undone", async () => {
  const { user, pad } = open();
  draw(pad, [0, 50], [200, 50]);
  draw(pad, [0, 150], [200, 150]);
  await user.click(screen.getByRole("button", { name: "Eraser" }));
  expect(screen.getByRole("button", { name: "Eraser" })).toHaveAttribute("aria-pressed", "true");
  draw(pad, [100, 40], [100, 60]);
  expect(strokes(pad)).toBe(1);
  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(strokes(pad)).toBe(0);
  await user.click(screen.getByRole("button", { name: "Undo" }));
  expect(strokes(pad)).toBe(1);
});

test("picking an ink or a line width draws with it", async () => {
  const { user, pad } = open();
  await user.click(screen.getByRole("radio", { name: "Red" }));
  await user.click(screen.getByRole("radio", { name: "Bold" }));
  draw(pad, [10, 10], [100, 80]);
  const path = pad.querySelector("path")!;
  expect(path).toHaveAttribute("stroke", "#b03c2c");
  expect(path).toHaveAttribute("stroke-width", "6");
});

test("Done saves the drawing as an SVG beside the note and says where it went", async () => {
  const save = vi.spyOn(api, "attachmentSave").mockResolvedValue("attachments/Drawing 2026-11-03 0900.svg");
  const { user, pad, saved } = open();
  draw(pad, [10, 10], [100, 80]);
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(save).toHaveBeenCalledTimes(1);
  const [note, name, blob] = save.mock.calls[0];
  expect(note).toBe("Projects/Plan.md");
  expect(name).toMatch(/^Drawing \d{4}-\d{2}-\d{2} \d{4}\.svg$/);
  expect(await (blob as Blob).text()).toContain("data-wandika-drawing");
  expect(saved).toHaveBeenCalledWith("attachments/Drawing 2026-11-03 0900.svg");
  await waitFor(() => expect(app.drawing).toBeNull());
});

test("Done on an empty page saves nothing; Cancel after drawing asks first", async () => {
  const save = vi.spyOn(api, "attachmentSave");
  const { user } = open();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(save).not.toHaveBeenCalled();
  expect(app.drawing).toBeNull();
  app.drawing = { note: "Projects/Plan.md", edit: null };
  flushSync();
  draw(document.querySelector("svg.pad")!, [10, 10], [100, 80]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("dialog", { name: "Discard this drawing?" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(app.drawing).toBeNull());
});

test("a drawing opens again with its strokes, and Done saves over the same file", async () => {
  const svg = toSvg([{ color: "#1c2320", width: 2.5, points: [[0, 0, 0.5], [50, 50, 0.5]] }]);
  vi.spyOn(api, "attachmentRead").mockResolvedValue(new TextEncoder().encode(svg).slice().buffer as ArrayBuffer);
  const write = vi.spyOn(api, "drawingWrite").mockResolvedValue();
  const { user, pad } = open({ target: "Drawing.svg", from: "Projects/Plan.md" });
  expect(screen.getByRole("dialog", { name: "Edit drawing" })).toBeInTheDocument();
  await waitFor(() => expect(strokes(pad)).toBe(1));
  draw(pad, [10, 100], [100, 100]);
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(write).toHaveBeenCalledWith("Drawing.svg", "Projects/Plan.md", expect.stringContaining("data-wandika-drawing"));
  expect((write.mock.calls[0][2].match(/<path /g) ?? []).length).toBe(2);
});

test("an SVG from elsewhere isn't opened for drawing, and says why", async () => {
  vi.spyOn(api, "attachmentRead").mockResolvedValue(new TextEncoder().encode("<svg><circle/></svg>").buffer as ArrayBuffer);
  open({ target: "Logo.svg", from: "" });
  expect(await screen.findByRole("alert")).toHaveTextContent("Only drawings made in Wandika can be changed here.");
});
