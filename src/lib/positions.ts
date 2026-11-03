// Where each note was left: scroll position and cursor, kept on this device for the last 200 notes.

export interface Position {
  top: number;
  anchor: number;
  head: number;
}

const KEY = "wandika.positions";
const LIMIT = 200;

const isPosition = (p: unknown): p is Position =>
  !!p && typeof p === "object" && ["top", "anchor", "head"].every((k) => typeof (p as Record<string, unknown>)[k] === "number");

function load(): Map<string, Position> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(saved)) return new Map();
    // Anything but [path, position] pairs (an older format, a hand edit) is dropped, not trusted.
    return new Map(saved.filter((e): e is [string, Position] => Array.isArray(e) && typeof e[0] === "string" && isPosition(e[1])));
  } catch {
    return new Map();
  }
}

export const positions = typeof localStorage === "undefined" ? new Map<string, Position>() : load();

export function remember(path: string, pos: Position) {
  positions.delete(path);
  positions.set(path, pos);
  while (positions.size > LIMIT) positions.delete(positions.keys().next().value!);
  try {
    localStorage.setItem(KEY, JSON.stringify([...positions]));
  } catch {
    // Storage full or private: positions last for this session only.
  }
}
