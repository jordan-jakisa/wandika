// Tips that show once per device, at the moment they help, never as a tour up front.

const KEY = "wandika.tips";

function seen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return new Set(["*"]);
  }
}

/** Calls `show` with the tip's text the first time `id` comes up on this device. */
export function tip(id: string, text: string, show: (text: string) => void) {
  const s = seen();
  if (s.has(id) || s.has("*")) return;
  s.add(id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    return;
  }
  show(text);
}

export const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
