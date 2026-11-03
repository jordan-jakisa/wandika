// Durations live in CSS (app.css, --dur-*). Script timers read them from there, so the two never
// drift apart, and reduced motion (every duration 0) applies to both.

export function duration(token: "--dur-instant" | "--dur-quick" | "--dur-base" | "--dur-slow"): number {
  if (typeof document === "undefined") return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const n = parseFloat(value) || 0;
  // CSS allows "0.24s" as well as "240ms"; timers want milliseconds.
  return /\ds$/.test(value) ? n * 1000 : n;
}
