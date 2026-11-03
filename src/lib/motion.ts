// Durations live in CSS (app.css, --dur-*). Script timers read them from there, so the two never
// drift apart, and reduced motion (every duration 0) applies to both.

export function duration(token: "--dur-instant" | "--dur-quick" | "--dur-base" | "--dur-slow"): number {
  if (typeof document === "undefined") return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const n = parseFloat(value) || 0;
  // CSS allows "0.24s" as well as "240ms"; timers want milliseconds.
  return /\ds$/.test(value) ? n * 1000 : n;
}

/** A cubic-bezier easing from a CSS token (`--ease-sheet`), for script-driven motion. */
export function easing(token: "--ease-out" | "--ease-in" | "--ease-sheet"): (t: number) => number {
  const raw = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(token);
  const m = raw.match(/cubic-bezier\(([^)]+)\)/);
  const [x1, y1, x2, y2] = m ? m[1].split(",").map(Number) : [0.2, 0, 0, 1];
  return bezier(x1, y1, x2, y2);
}

/** CSS's cubic-bezier: solves x for t by Newton's method, then returns y. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  const slope = (a: number, b: number, t: number) => 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t * t;
  return (x: number) => {
    if (x <= 0 || x >= 1) return x;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= (at(x1, x2, t) - x) / d;
    }
    return at(y1, y2, Math.min(1, Math.max(0, t)));
  };
}

/** Closes a dialog after its leaving animation (`.closing` in app.css); at once with reduced motion. */
export function closeSheet(el: HTMLDialogElement, done?: () => void) {
  const ms = duration("--dur-base");
  if (!ms || !el.open) {
    el.close();
    done?.();
    return;
  }
  el.classList.add("closing");
  setTimeout(() => {
    el.classList.remove("closing");
    el.close();
    done?.();
  }, ms);
}
