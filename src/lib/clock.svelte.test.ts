import { afterEach, beforeEach, expect, test, vi } from "vitest";

/** A fresh clock, started at `at` local time. */
async function clockAt(at: Date) {
  vi.setSystemTime(at);
  vi.resetModules();
  return (await import("./clock.svelte")).clock;
}

function comeBack(state: DocumentVisibilityState) {
  const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
  spy.mockRestore();
}

const tz = process.env.TZ;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
});

test("today is the local date as YYYY-MM-DD", async () => {
  const clock = await clockAt(new Date(2026, 10, 3, 9, 30));
  expect(clock.today).toBe("2026-11-03");
});

test("single-digit months and days are padded", async () => {
  const clock = await clockAt(new Date(2026, 0, 5, 12));
  expect(clock.today).toBe("2026-01-05");
});

test("it moves on at midnight", async () => {
  const clock = await clockAt(new Date(2026, 10, 3, 23, 59, 50));
  vi.advanceTimersByTime(9_000);
  expect(clock.today).toBe("2026-11-03");
  vi.advanceTimersByTime(3_000);
  expect(clock.today).toBe("2026-11-04");
});

test("and keeps moving on every night after", async () => {
  const clock = await clockAt(new Date(2026, 10, 3, 23, 0));
  vi.advanceTimersByTime(3 * 86_400_000);
  expect(clock.today).toBe("2026-11-06");
});

test("month ends, year ends and leap days", async () => {
  let clock = await clockAt(new Date(2026, 10, 30, 23, 59, 59));
  vi.advanceTimersByTime(5_000);
  expect(clock.today).toBe("2026-12-01");

  clock = await clockAt(new Date(2026, 11, 31, 23, 59, 59));
  vi.advanceTimersByTime(5_000);
  expect(clock.today).toBe("2027-01-01");

  clock = await clockAt(new Date(2028, 1, 28, 23, 59, 59));
  vi.advanceTimersByTime(5_000);
  expect(clock.today).toBe("2028-02-29");
  vi.advanceTimersByTime(86_400_000);
  expect(clock.today).toBe("2028-03-01");
});

test("coming back to the front catches up after the phone slept", async () => {
  const clock = await clockAt(new Date(2026, 10, 3, 22, 0));
  // Timers don't run while the phone sleeps; the clock still moves.
  vi.setSystemTime(new Date(2026, 10, 5, 8, 0));
  expect(clock.today).toBe("2026-11-03");
  comeBack("hidden");
  expect(clock.today).toBe("2026-11-03");
  comeBack("visible");
  expect(clock.today).toBe("2026-11-05");
});

test("the date follows the device's time zone, not UTC", async () => {
  // 2026-11-03 20:00 UTC is already the 4th in Kiribati (UTC+14) and still the 3rd in Hawaii.
  process.env.TZ = "Pacific/Kiritimati";
  let clock = await clockAt(new Date(Date.UTC(2026, 10, 3, 20)));
  expect(clock.today).toBe("2026-11-04");
  process.env.TZ = "Pacific/Honolulu";
  clock = await clockAt(new Date(Date.UTC(2026, 10, 4, 5)));
  expect(clock.today).toBe("2026-11-03");
});

test("midnight is local midnight in another time zone", async () => {
  process.env.TZ = "Africa/Kampala";
  const clock = await clockAt(new Date(Date.UTC(2026, 10, 3, 20, 59, 50)));
  expect(clock.today).toBe("2026-11-03");
  vi.advanceTimersByTime(12_000);
  expect(clock.today).toBe("2026-11-04");
});

test("a daylight saving change doesn't skip or repeat a day", async () => {
  process.env.TZ = "Europe/London";
  // Clocks go back an hour on 25 October 2026.
  const clock = await clockAt(new Date(2026, 9, 24, 23, 0));
  vi.advanceTimersByTime(3_602_000);
  expect(clock.today).toBe("2026-10-25");
  vi.advanceTimersByTime(25 * 3_600_000);
  expect(clock.today).toBe("2026-10-26");
});

test("the heading names the weekday, day and month in the reader's language", async () => {
  const clock = await clockAt(new Date(2026, 10, 3, 0, 30));
  const expected = new Date(2026, 10, 3, 12).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  expect(clock.heading).toBe(expected);
  expect(clock.heading).toContain("Tuesday");
  expect(clock.heading).toContain("November");
  expect(clock.heading).not.toContain("2026");
});

test("the heading follows the date when it moves on", async () => {
  const clock = await clockAt(new Date(2026, 10, 3, 23, 59, 59));
  vi.advanceTimersByTime(5_000);
  expect(clock.heading).toContain("Wednesday");
});
