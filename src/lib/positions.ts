// Where each note was left: scroll position and cursor, kept on this device for the last 200 notes.

export interface Position {
  top: number;
  anchor: number;
  head: number;
}

const KEY = "wandika.positions";
const LIMIT = 200;

function load(): Map<string, Position> {
  try {
    return new Map(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
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
