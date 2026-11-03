// Helpers shared by the tests.

import { vi } from "vitest";

/**
 * Waits for `p` under fake timers, moving the clock on in small steps until it settles, so the
 * mock backend's pauses (40 ms a call, longer for a sync) pass without real waiting.
 */
export async function settle<T>(p: Promise<T>, step = 50): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; !done && i < 2000; i++) await vi.advanceTimersByTimeAsync(step);
  return p;
}

/** Makes every localStorage write fail, as in private mode or with full storage. */
export function storageFull() {
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Quota exceeded", "QuotaExceededError");
  });
}
