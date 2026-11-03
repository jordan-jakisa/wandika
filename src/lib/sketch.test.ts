import { describe, expect, test } from "vitest";
import { MARK, PAD, PAPER, bounds, drawingName, fromSvg, hits, pathOf, strokeWidth, toSvg, type Stroke } from "./sketch";

const line = (points: [number, number][], width = 2.5, color = "#1c2320"): Stroke => ({
  color,
  width,
  points: points.map(([x, y]) => [x, y, 0.5]),
});

describe("strokes", () => {
  test("a path curves through the midpoints, and a dot is still drawn", () => {
    expect(pathOf([[10, 10, 0.5]])).toBe("M10 10l0.01 0");
    expect(pathOf([[0, 0, 0.5], [10, 0, 0.5]])).toBe("M0 0L10 0");
    expect(pathOf([[0, 0, 0.5], [10, 10, 0.5], [20, 0, 0.5]])).toBe("M0 0Q10 10 15 5L20 0");
    expect(pathOf([])).toBe("");
  });

  test("a pen pressed harder draws thicker; a finger draws the chosen width", () => {
    expect(strokeWidth(line([[0, 0]], 4))).toBe(4);
    expect(strokeWidth({ color: "#000", width: 4, points: [[0, 0, 1], [1, 1, 1]] })).toBe(6);
    expect(strokeWidth({ color: "#000", width: 4, points: [[0, 0, 0.1]] })).toBe(2.4);
  });

  test("bounds take the line's width into account; nothing drawn has none", () => {
    expect(bounds([line([[10, 20], [30, 40]], 4)])).toEqual({ x: 8, y: 18, w: 24, h: 24 });
    expect(bounds([])).toBeNull();
  });

  test("the eraser finds a stroke near its line, not far from it", () => {
    const s = line([[0, 0], [100, 0]]);
    expect(hits(s, 50, 8, 10)).toBe(true);
    expect(hits(s, 50, 30, 10)).toBe(false);
    expect(hits(s, 130, 0, 10)).toBe(false);
    expect(hits(line([[5, 5]]), 9, 9, 10)).toBe(true);
  });
});

describe("the file", () => {
  test("is an SVG on its own paper, cropped to the strokes with a margin, marked as Wandika's", () => {
    const svg = toSvg([line([[100, 100], [200, 150]], 4, "#2e6a4e")]);
    expect(svg).toContain(`${MARK}="1"`);
    const w = 100 + 4 + PAD * 2;
    const h = 50 + 4 + PAD * 2;
    expect(svg).toContain(`width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"`);
    expect(svg).toContain(`fill="${PAPER}"`);
    expect(svg).toContain('stroke="#2e6a4e" stroke-width="4"');
  });

  test("opens again with the same strokes, moved to the crop", () => {
    const strokes = [line([[100, 100], [150, 120], [200, 150]], 6, "#b03c2c"), line([[120, 300]])];
    const back = fromSvg(toSvg(strokes))!;
    expect(back).toHaveLength(2);
    expect(back[0].color).toBe("#b03c2c");
    expect(back[0].width).toBe(6);
    const shift = PAD - (100 - 3);
    expect(back[0].points[0]).toEqual([100 + shift, PAD - (100 - 3) + 100, 0.5]);
    expect(toSvg(back)).toBe(toSvg(strokes));
  });

  test("any other SVG is not a drawing", () => {
    expect(fromSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')).toBeNull();
    expect(fromSvg("not svg")).toBeNull();
  });

  test("a colour can't carry markup into the file", () => {
    expect(toSvg([line([[0, 0], [1, 1]], 2, '#000" onload="x')])).toContain('stroke="#1c2320"');
  });

  test("named like Obsidian's pasted files", () => {
    expect(drawingName(new Date(2026, 10, 3, 9, 5))).toBe("Drawing 2026-11-03 0905.svg");
  });
});
