// Small view choices kept on this device: "Show done" in Tasks, the graph's display options.

const KEY = "wandika.views";

/** Everything saved, or nothing when storage is unreadable or holds something else. */
function all(): Record<string, unknown> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The saved choices for `name`; each one missing, or of the wrong type, falls back to its default. */
export function readView<T extends object>(name: string, defaults: T): T {
  const saved = all()[name];
  const out = { ...defaults } as Record<string, unknown>;
  if (!saved || typeof saved !== "object") return out as T;
  for (const [k, v] of Object.entries(defaults)) {
    const s = (saved as Record<string, unknown>)[k];
    if (typeof s === typeof v && s !== null) out[k] = s;
  }
  return out as T;
}

export function saveView(name: string, value: object) {
  const views = all();
  views[name] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(views));
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}
