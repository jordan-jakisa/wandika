// Durations live in CSS (app.css, --dur-*). Script timers read them from there, so the two never
// drift apart, and reduced motion (every duration 0) applies to both.

export function duration(token: "--dur-instant" | "--dur-quick" | "--dur-base" | "--dur-slow"): number {
  if (typeof document === "undefined") return 0;
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token)) || 0;
}
