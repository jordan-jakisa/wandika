// Drawings: strokes drawn with a pen, a finger or a mouse, kept as an SVG file beside the notes so
// Obsidian, GitHub and any browser show them. The points ride along in the file, so Wandika can
// open a drawing again and change it.

/** x, y and the pen's pressure (0.5 when the input has none). */
export type Point = [x: number, y: number, pressure: number];

export interface Stroke {
  color: string;
  width: number;
  points: Point[];
}

/** Marks a file as a Wandika drawing; only these are opened for editing. */
export const MARK = "data-wandika-drawing";

// The file is shown in any theme and any app, so it carries its own paper and inks.
export const PAPER = "#fbfbf9";
/** Hint text on the paper, which stays light in dark mode. */
export const MUTED = "#59635e";
export const INKS = [
  { label: "Black", color: "#1c2320" },
  { label: "Green", color: "#2e6a4e" },
  { label: "Red", color: "#b03c2c" },
] as const;
export const WIDTHS = [
  { label: "Fine", value: 2.5 },
  { label: "Bold", value: 6 },
] as const;
/** Space around the strokes when a drawing is saved. */
export const PAD = 24;

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A smooth path through the points: quadratic curves through the midpoints. */
export function pathOf(points: Point[]): string {
  if (!points.length) return "";
  const [x0, y0] = points[0];
  if (points.length === 1) return `M${r1(x0)} ${r1(y0)}l0.01 0`;
  let d = `M${r1(x0)} ${r1(y0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += `Q${r1(x)} ${r1(y)} ${r1((x + nx) / 2)} ${r1((y + ny) / 2)}`;
  }
  const [lx, ly] = points[points.length - 1];
  return `${d}L${r1(lx)} ${r1(ly)}`;
}

/** A pen pressed harder draws a thicker line; a finger or a mouse draws the width chosen. */
export function strokeWidth(s: Stroke): number {
  const avg = s.points.reduce((sum, p) => sum + p[2], 0) / Math.max(1, s.points.length);
  return r1(s.width * (0.5 + avg));
}

export function bounds(strokes: Stroke[]) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of strokes) {
    const half = strokeWidth(s) / 2;
    for (const [x, y] of s.points) {
      minX = Math.min(minX, x - half);
      minY = Math.min(minY, y - half);
      maxX = Math.max(maxX, x + half);
      maxY = Math.max(maxY, y + half);
    }
  }
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Is (x, y) within `r` of the stroke's line? The eraser's test. */
export function hits(s: Stroke, x: number, y: number, r: number): boolean {
  const reach = r + strokeWidth(s) / 2;
  const p = s.points;
  if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) <= reach;
  for (let i = 1; i < p.length; i++) {
    const [ax, ay] = p[i - 1];
    const [bx, by] = p[i];
    const len = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len)) : 0;
    if (Math.hypot(ax + t * (bx - ax) - x, ay + t * (by - ay) - y) <= reach) return true;
  }
  return false;
}

/** Only a plain hex colour reaches the file; anything else draws in black. */
const colour = (s: string) => (/^#[0-9a-fA-F]{3,8}$/.test(s) ? s : INKS[0].color);

/** The drawing as an SVG file, cropped to the strokes with a margin, on its own paper. */
export function toSvg(strokes: Stroke[]): string {
  const b = bounds(strokes) ?? { x: 0, y: 0, w: 0, h: 0 };
  const dx = PAD - b.x;
  const dy = PAD - b.y;
  const w = Math.ceil(b.w + PAD * 2);
  const h = Math.ceil(b.h + PAD * 2);
  const paths = strokes.map((s) => {
    const pts = s.points.map(([x, y, p]): Point => [r1(x + dx), r1(y + dy), Math.round(p * 100) / 100]);
    const data = pts.map((p) => p.join(",")).join(" ");
    return `<path d="${pathOf(pts)}" stroke="${colour(s.color)}" stroke-width="${strokeWidth(s)}" data-width="${s.width}" data-points="${data}"/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" ${MARK}="1" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="${PAPER}"/>`,
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round">`,
    ...paths,
    `</g>`,
    `</svg>`,
    "",
  ].join("\n");
}

/** The strokes of a drawing Wandika made, or null for any other SVG. */
export function fromSvg(text: string): Stroke[] | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg.nodeName !== "svg" || !svg.hasAttribute(MARK)) return null;
  return [...svg.querySelectorAll("path[data-points]")].map((el) => ({
    color: el.getAttribute("stroke") ?? INKS[0].color,
    width: Number(el.getAttribute("data-width")) || WIDTHS[0].value,
    points: (el.getAttribute("data-points") ?? "")
      .split(" ")
      .filter(Boolean)
      .map((t) => t.split(",").map(Number) as Point),
  }));
}

/** "Drawing 2026-11-03 1830.svg", the way Obsidian names pasted files. */
export function drawingName(d = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `Drawing ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}.svg`;
}
