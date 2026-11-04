import "@testing-library/jest-dom/vitest";
import { media, note, recordCanvas, resetApp, type Drawing } from "../../test/components-views";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../app.svelte";
import GraphView from "./GraphView.svelte";

// The graph loads d3-force on first use. `failLoad` makes that load fail, as a missing chunk would.
const d3 = vi.hoisted(() => ({ failLoad: false }));
vi.mock("d3-force", async (importOriginal) => {
  if (d3.failLoad) throw new Error("Failed to fetch dynamically imported module");
  return importOriginal();
});

/**
 * Home links Plan and Ideas, Plan links Spec, Ideas links a note not written yet, Lonely links
 * nothing: 5 notes, 3 links; 2 in Projects, 3 at the vault root.
 */
const vault = () => [
  note("Home.md", { links: ["Projects/Plan", "Ideas"] }),
  note("Projects/Plan.md", { links: ["Home", "Spec"] }),
  note("Projects/Spec.md"),
  note("Ideas.md", { links: ["Missing"] }),
  note("Lonely.md"),
];

let canvas: ReturnType<typeof recordCanvas>;

beforeEach(() => {
  resetApp();
  // Reduced motion lays the graph out at once, so every test sees it settled.
  media["(prefers-reduced-motion: reduce)"] = true;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  canvas = recordCanvas();
});
afterEach(() => vi.restoreAllMocks());

const legend = () => screen.getByText(/^\d+ notes, \d+ links$/);

/** Renders and waits until the graph has drawn its notes. */
async function setup(notes = vault()) {
  app.titles = notes;
  const r = render(GraphView);
  if (notes.length) await vi.waitFor(() => expect(canvas.last.labels.length).toBeGreaterThan(0));
  return { ...r, user: userEvent.setup() };
}
const graphCanvas = () => document.querySelector("canvas")!;
/** Where a note's dot is on screen, from what was last drawn. */
function dotOf(title: string, frame: Drawing = canvas.last) {
  const label = frame.labels.find((l) => l.text === title);
  if (!label) throw new Error(`${title} isn't drawn`);
  return frame.dots.find((d) => Math.abs(d.x - label.x) < 0.01)!;
}
const labelOf = (title: string, frame: Drawing = canvas.last) => frame.labels.find((l) => l.text === title);
const titles = (frame: Drawing = canvas.last) => frame.labels.map((l) => l.text).sort();
/** Waits for a frame drawn after `n` frames, and returns it. */
async function nextFrame(n: number) {
  await vi.waitFor(() => expect(canvas.frames.length).toBeGreaterThan(n));
  return canvas.last;
}

async function tap(x: number, y: number) {
  const c = graphCanvas();
  await fireEvent.pointerDown(c, { pointerId: 1, clientX: x, clientY: y });
  await fireEvent.pointerUp(c, { pointerId: 1, clientX: x, clientY: y });
}

// First in the file: the graph module is only loaded once per file, and this load must fail.
test("says so when the graph can't load", async () => {
  d3.failLoad = true;
  try {
    app.titles = vault();
    render(GraphView);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The graph couldn't load.");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  } finally {
    d3.failLoad = false;
  }
});

test("a vault without notes explains how the graph fills", async () => {
  await setup([]);
  expect(await screen.findByText("No notes yet. Link notes with [[ ]] to see them connect here.")).toBeInTheDocument();
  expect(legend()).toHaveTextContent("0 notes, 0 links");
});

test("draws every note with its name and counts notes and links", async () => {
  await setup();
  expect(titles()).toEqual(["Home", "Ideas", "Lonely", "Plan", "Spec"]);
  expect(legend()).toHaveTextContent("5 notes, 3 links");
  expect(screen.getByRole("img", { name: "Graph of 5 notes and 3 links. Type in the filter and press Return to open a note." })).toBe(graphCanvas());
  expect(screen.queryByText(/No notes yet/)).not.toBeInTheDocument();
});

test("the whole graph fits inside the view", async () => {
  await setup();
  for (const d of canvas.last.dots) {
    expect(d.x).toBeGreaterThanOrEqual(0);
    expect(d.x).toBeLessThanOrEqual(800);
    expect(d.y).toBeGreaterThanOrEqual(0);
    expect(d.y).toBeLessThanOrEqual(600);
  }
});

test("more links make a bigger dot", async () => {
  await setup();
  expect(dotOf("Home").r).toBeGreaterThan(dotOf("Spec").r);
  expect(dotOf("Spec").r).toBeGreaterThan(dotOf("Lonely").r);
});

describe("tapping", () => {
  test("a dot opens its note", async () => {
    await setup();
    const plan = dotOf("Plan");
    await tap(plan.x, plan.y);
    expect(app.current).toBe("Projects/Plan.md");
    expect(app.tab).toBe("notes");
  });

  test("near a dot still counts, so small dots are easy to hit", async () => {
    await setup();
    const spec = dotOf("Spec");
    await tap(spec.x + spec.r + 3, spec.y);
    expect(app.current).toBe("Projects/Spec.md");
  });

  test("empty space opens nothing", async () => {
    await setup();
    await tap(2, 2);
    expect(app.current).toBeNull();
  });

  test("a note not written yet is created when tapped", async () => {
    const follow = vi.spyOn(app, "follow").mockResolvedValue();
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: /Display/ }));
    await user.click(screen.getByRole("checkbox", { name: "Notes not written yet" }));
    await vi.waitFor(() => expect(labelOf("Missing")).toBeDefined());
    const missing = dotOf("Missing");
    expect(missing.outline).toBe(true);
    await tap(missing.x, missing.y);
    expect(follow).toHaveBeenCalledWith("Missing");
  });

  test("dragging a dot moves it without opening the note", async () => {
    await setup();
    const home = dotOf("Home");
    const c = graphCanvas();
    await fireEvent.pointerDown(c, { pointerId: 1, clientX: home.x, clientY: home.y });
    await fireEvent.pointerMove(c, { pointerId: 1, clientX: home.x + 40, clientY: home.y + 30 });
    await fireEvent.pointerUp(c, { pointerId: 1, clientX: home.x + 40, clientY: home.y + 30 });
    expect(app.current).toBeNull();
  });
});

describe("moving around", () => {
  test("dragging the background pans the view", async () => {
    await setup();
    const before = canvas.last.view;
    const c = graphCanvas();
    await fireEvent.pointerDown(c, { pointerId: 1, clientX: 2, clientY: 2 });
    const n = canvas.frames.length;
    await fireEvent.pointerMove(c, { pointerId: 1, clientX: 52, clientY: 32 });
    const after = (await nextFrame(n)).view;
    expect(after.x - before.x).toBeCloseTo(50);
    expect(after.y - before.y).toBeCloseTo(30);
    expect(after.k).toBeCloseTo(before.k);
    await fireEvent.pointerUp(c, { pointerId: 1 });
    expect(app.current).toBeNull();
  });

  function wheel(deltaY: number, x = 400, y = 300) {
    const e = new WheelEvent("wheel", { deltaY, cancelable: true, bubbles: true });
    Object.defineProperties(e, { offsetX: { value: x }, offsetY: { value: y } });
    graphCanvas().dispatchEvent(e);
    return e;
  }

  test("the wheel zooms around the pointer, and the page doesn't scroll", async () => {
    await setup();
    const before = canvas.last;
    const n = canvas.frames.length;
    const e = wheel(-100, 400, 300);
    expect(e.defaultPrevented).toBe(true);
    const after = await nextFrame(n);
    expect(after.view.k / before.view.k).toBeCloseTo(Math.exp(0.2));
    // The point under the pointer stays put.
    expect((400 - after.view.x) / after.view.k).toBeCloseTo((400 - before.view.x) / before.view.k);
  });

  test("zoom stops at six times and at a tenth", async () => {
    await setup();
    for (let i = 0; i < 40; i++) wheel(-500);
    await vi.waitFor(() => expect(canvas.last.view.k).toBeCloseTo(6));
    for (let i = 0; i < 40; i++) wheel(500);
    await vi.waitFor(() => expect(canvas.last.view.k).toBeCloseTo(0.1));
  });

  test("two fingers pinch to zoom", async () => {
    await setup();
    const k = canvas.last.view.k;
    const c = graphCanvas();
    await fireEvent.pointerDown(c, { pointerId: 1, clientX: 300, clientY: 300 });
    await fireEvent.pointerDown(c, { pointerId: 2, clientX: 500, clientY: 300 });
    const n = canvas.frames.length;
    await fireEvent.pointerMove(c, { pointerId: 2, clientX: 700, clientY: 300 });
    const after = await nextFrame(n);
    expect(after.view.k / k).toBeCloseTo(2);
    await fireEvent.pointerUp(c, { pointerId: 2 });
    await fireEvent.pointerUp(c, { pointerId: 1 });
    expect(app.current).toBeNull();
  });

  test("Fit brings the whole graph back into view", async () => {
    const { user } = await setup();
    const fitted = canvas.last.view;
    for (let i = 0; i < 5; i++) wheel(-500, 10, 10);
    await vi.waitFor(() => expect(canvas.last.view.k).not.toBeCloseTo(fitted.k));
    const n = canvas.frames.length;
    await user.click(screen.getByRole("button", { name: "Fit the graph to the window" }));
    const after = await nextFrame(n);
    expect(after.view.k).toBeCloseTo(fitted.k);
    expect(after.view.x).toBeCloseTo(fitted.x);
  });
});

describe("hover", () => {
  test("pointing at a note lights it and its neighbours and fades the rest", async () => {
    await setup();
    const plan = dotOf("Plan");
    const n = canvas.frames.length;
    await fireEvent.pointerMove(graphCanvas(), { pointerId: 1, clientX: plan.x, clientY: plan.y });
    expect(graphCanvas().style.cursor).toBe("pointer");
    const frame = await nextFrame(n);
    expect(labelOf("Plan", frame)!.alpha).toBe(1);
    expect(labelOf("Home", frame)!.alpha).toBe(1);
    expect(labelOf("Spec", frame)!.alpha).toBe(1);
    expect(labelOf("Lonely", frame)!.alpha).toBeLessThanOrEqual(0.2);
    expect(dotOf("Ideas", frame).alpha).toBe(0.2);
  });

  test("leaving the canvas clears the highlight", async () => {
    await setup();
    const plan = dotOf("Plan");
    await fireEvent.pointerMove(graphCanvas(), { pointerId: 1, clientX: plan.x, clientY: plan.y });
    await vi.waitFor(() => expect(labelOf("Lonely")!.alpha).toBeLessThanOrEqual(0.2));
    const n = canvas.frames.length;
    await fireEvent.pointerLeave(graphCanvas(), { pointerId: 1 });
    const frame = await nextFrame(n);
    expect(labelOf("Lonely", frame)!.alpha).toBe(1);
  });
});

describe("filter", () => {
  test("Return opens the best matching note", async () => {
    const { user } = await setup();
    await user.type(screen.getByRole("searchbox", { name: "Filter notes in the graph; Return opens the best match" }), "pl{Enter}");
    expect(app.current).toMatch(/Plan/);
  });

  test("typing fades every note whose name doesn't match", async () => {
    const { user } = await setup();
    const n = canvas.frames.length;
    await user.type(screen.getByRole("searchbox", { name: "Filter notes in the graph; Return opens the best match" }), "pl");
    const frame = await nextFrame(n);
    expect(dotOf("Plan", frame).alpha).toBe(1);
    expect(dotOf("Home", frame).alpha).toBe(0.2);
    await user.clear(screen.getByRole("searchbox"));
    await vi.waitFor(() => expect(dotOf("Home").alpha).toBe(1));
  });
});

describe("around this note", () => {
  test("is off until a note has been opened", async () => {
    await setup();
    const around = screen.getByRole("button", { name: "Around this note" });
    expect(around).toBeDisabled();
    expect(around).toHaveAttribute("title", "Open a note first");
    expect(screen.getByRole("button", { name: "Whole vault" })).toHaveAttribute("aria-pressed", "true");
  });

  test("shows the open note and its neighbours, deeper with Depth", async () => {
    app.graphFocus = "Projects/Plan.md";
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Around this note" }));
    expect(screen.getByRole("button", { name: "Around this note" })).toHaveAttribute("aria-pressed", "true");
    await vi.waitFor(() => expect(legend()).toHaveTextContent("3 notes, 2 links"));
    await vi.waitFor(() => expect(titles()).toEqual(["Home", "Plan", "Spec"]));
    await user.selectOptions(screen.getByRole("combobox", { name: "Depth" }), "2");
    await vi.waitFor(() => expect(legend()).toHaveTextContent("4 notes, 3 links"));
    await user.click(screen.getByRole("button", { name: "Whole vault" }));
    await vi.waitFor(() => expect(legend()).toHaveTextContent("5 notes, 3 links"));
    expect(screen.queryByRole("combobox", { name: "Depth" })).not.toBeInTheDocument();
  });

  test("the open note is ringed so it stands out", async () => {
    app.graphFocus = "Projects/Plan.md";
    await setup();
    const plan = dotOf("Plan");
    expect(canvas.last.dots.some((d) => d.outline && Math.abs(d.x - plan.x) < 0.01 && d.r > plan.r)).toBe(true);
    const home = dotOf("Home");
    expect(canvas.last.dots.some((d) => d.outline && Math.abs(d.x - home.x) < 0.01)).toBe(false);
  });

  test("opens around the note when asked for from the note", async () => {
    app.graphFocus = "Projects/Spec.md";
    app.graphLocal = true;
    await setup();
    expect(screen.getByRole("button", { name: "Around this note" })).toHaveAttribute("aria-pressed", "true");
    await vi.waitFor(() => expect(legend()).toHaveTextContent("2 notes, 1 links"));
  });

  test("a note without links says so", async () => {
    app.graphFocus = "Lonely.md";
    app.graphLocal = true;
    await setup();
    expect(await screen.findByText("This note has no links yet.")).toBeInTheDocument();
  });
});

describe("display options", () => {
  test("Display opens and closes the panel", async () => {
    const { user } = await setup();
    const button = screen.getByRole("button", { name: /Display/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Graph display" })).toBeInTheDocument();
    await user.click(button);
    expect(screen.queryByRole("group", { name: "Graph display" })).not.toBeInTheDocument();
  });

  test("notes without links can be hidden", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: /Display/ }));
    await user.click(screen.getByRole("checkbox", { name: "Notes without links" }));
    await vi.waitFor(() => expect(legend()).toHaveTextContent("4 notes, 3 links"));
    await vi.waitFor(() => expect(titles()).not.toContain("Lonely"));
  });

  test("notes not written yet can be shown", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: /Display/ }));
    await user.click(screen.getByRole("checkbox", { name: "Notes not written yet" }));
    await vi.waitFor(() => expect(legend()).toHaveTextContent("6 notes, 4 links"));
  });

  test("around a note, every neighbour shows, so the unlinked option is off", async () => {
    app.graphFocus = "Home.md";
    app.graphLocal = true;
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: /Display/ }));
    expect(screen.getByRole("checkbox", { name: "Notes without links" })).toBeDisabled();
  });

  test("dot size grows the dots", async () => {
    const { user } = await setup();
    const r = dotOf("Home").r;
    await user.click(screen.getByRole("button", { name: /Display/ }));
    const n = canvas.frames.length;
    await fireEvent.input(screen.getByRole("slider", { name: "Dot size" }), { target: { value: "2" } });
    const frame = await nextFrame(n);
    expect(dotOf("Home", frame).r / r).toBeCloseTo(2);
  });

  test("longer links spread the notes out, without rebuilding the graph", async () => {
    const { user } = await setup();
    const spread = (f: Drawing) => Math.hypot(dotOf("Home", f).x - dotOf("Plan", f).x, dotOf("Home", f).y - dotOf("Plan", f).y) / f.view.k;
    const before = spread(canvas.last);
    await user.click(screen.getByRole("button", { name: /Display/ }));
    const n = canvas.frames.length;
    await fireEvent.input(screen.getByRole("slider", { name: "Link distance" }), { target: { value: "200" } });
    const after = await nextFrame(n);
    expect(spread(after)).toBeGreaterThan(before * 1.3);
    expect(legend()).toHaveTextContent("5 notes, 3 links");
  });

  test("with reduced motion, a slider settles the layout at once instead of animating it", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: /Display/ }));
    await fireEvent.input(screen.getByRole("slider", { name: "Spacing" }), { target: { value: "300" } });
    await new Promise((r) => setTimeout(r, 30));
    const n = canvas.frames.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(canvas.frames.length).toBe(n);
  });

  test("choices are remembered on this device", async () => {
    const first = await setup();
    await first.user.click(screen.getByRole("button", { name: /Display/ }));
    await first.user.click(screen.getByRole("checkbox", { name: "Notes not written yet" }));
    await first.user.click(screen.getByRole("checkbox", { name: "Colour by folder" }));
    first.unmount();
    const second = await setup();
    await second.user.click(screen.getByRole("button", { name: /Display/ }));
    expect(screen.getByRole("checkbox", { name: "Notes not written yet" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Colour by folder" })).not.toBeChecked();
    await vi.waitFor(() => expect(legend()).toHaveTextContent("6 notes, 4 links"));
  });
});

describe("folders", () => {
  test("a legend lists folders by size, each in its own colour", async () => {
    await setup();
    const folders = screen.getByRole("group", { name: "Folders" });
    const buttons = within(folders).getAllByRole("button");
    expect(buttons.map((b) => b.textContent!.replace(/\s+/g, " ").trim())).toEqual(["Vault root 3", "Projects 2"]);
    expect(dotOf("Home").fill).not.toBe(dotOf("Plan").fill);
    expect(dotOf("Home").fill).toBe(dotOf("Lonely").fill);
  });

  test("picking a folder fades the others; picking it again shows all", async () => {
    const { user } = await setup();
    const projects = screen.getByRole("button", { name: /Projects/ });
    const n = canvas.frames.length;
    await user.click(projects);
    expect(projects).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Vault root/ })).toHaveClass("dim");
    const frame = await nextFrame(n);
    expect(dotOf("Plan", frame).alpha).toBe(1);
    expect(dotOf("Home", frame).alpha).toBe(0.2);
    await user.click(projects);
    await vi.waitFor(() => expect(dotOf("Home").alpha).toBe(1));
  });

  test("one folder needs no legend", async () => {
    await setup([note("A.md", { links: ["B"] }), note("B.md")]);
    expect(screen.queryByRole("group", { name: "Folders" })).not.toBeInTheDocument();
  });

  test("colour by folder off: one colour, no legend", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: /Display/ }));
    const n = canvas.frames.length;
    await user.click(screen.getByRole("checkbox", { name: "Colour by folder" }));
    const frame = await nextFrame(n);
    expect(screen.queryByRole("group", { name: "Folders" })).not.toBeInTheDocument();
    expect(dotOf("Home", frame).fill).toBe(dotOf("Plan", frame).fill);
  });
});

describe("keeping up with the vault", () => {
  test("a new link appears", async () => {
    await setup();
    app.titles = [...vault().slice(0, 4), note("Lonely.md", { links: ["Home"] })];
    flushSync();
    await vi.waitFor(() => expect(legend()).toHaveTextContent("5 notes, 4 links"));
  });

  test("a sync that only changed note text leaves the graph where it was", async () => {
    await setup();
    const before = dotOf("Home");
    app.titles = vault().map((n) => ({ ...n, modified: 99 }));
    flushSync();
    await new Promise((r) => setTimeout(r, 50));
    expect(dotOf("Home").x).toBeCloseTo(before.x);
    expect(dotOf("Home").y).toBeCloseTo(before.y);
  });

  test("notes keep their places when the graph grows", async () => {
    await setup();
    const home = dotOf("Home");
    const spec = dotOf("Spec");
    const dx = spec.x - home.x;
    app.titles = [...vault(), note("New.md")];
    flushSync();
    await vi.waitFor(() => expect(legend()).toHaveTextContent("6 notes, 3 links"));
    await vi.waitFor(() => expect(labelOf("New")).toBeDefined());
    // The view refits, but the layout itself only settles; neighbours stay on the same side.
    expect(Math.sign(dotOf("Spec").x - dotOf("Home").x)).toBe(Math.sign(dx));
  });
});

test("with motion on, the layout settles over time and stops when the view closes", async () => {
  delete media["(prefers-reduced-motion: reduce)"];
  const { unmount } = await setup();
  await vi.waitFor(() => expect(canvas.frames.length).toBeGreaterThan(3));
  unmount();
  const n = canvas.frames.length;
  await new Promise((r) => setTimeout(r, 100));
  expect(canvas.frames.length).toBe(n);
});

