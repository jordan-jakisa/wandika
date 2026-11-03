// Today's date for screens that stay open overnight: it moves on at midnight and whenever the app
// comes back to the front.

// Built by hand: the "en-CA" locale trick for YYYY-MM-DD has changed format between ICU releases.
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

class Clock {
  /** YYYY-MM-DD in local time. */
  today = $state(iso(new Date()));

  constructor() {
    if (typeof window === "undefined") return;
    const tick = () => {
      const now = iso(new Date());
      if (now !== this.today) this.today = now;
    };
    const untilMidnight = () => {
      const next = new Date();
      next.setHours(24, 0, 1, 0);
      setTimeout(() => {
        tick();
        untilMidnight();
      }, next.getTime() - Date.now());
    };
    untilMidnight();
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && tick());
  }

  /** "Tuesday 3 November", for headings. */
  get heading() {
    return new Date(`${this.today}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  }
}

export const clock = new Clock();
