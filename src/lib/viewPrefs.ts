// Small view choices kept on this device: "Show done" in Tasks, the graph's display options.

const KEY = "wandika.views";

export function readView<T extends object>(name: string, defaults: T): T {
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}")[name] ?? {}) };
  } catch {
    return defaults;
  }
}

export function saveView(name: string, value: object) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    all[name] = value;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}
