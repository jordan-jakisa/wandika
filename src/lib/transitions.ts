// Screen motion on phones: a pushed screen slides in from the right and slides back out; the
// screen it came from stays put underneath. Durations come from CSS, so reduced motion is instant.

import { duration } from "./motion";

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Slides in from the right edge (or from where a swipe let go, for the way out). */
export function push(_node: Element, { from = 0, enabled = true }: { from?: number; enabled?: boolean } = {}) {
  return {
    duration: enabled ? duration("--dur-base") : 0,
    easing: easeOut,
    css: (t: number) => `transform: translateX(calc(${from}px + ${1 - t} * (100% - ${from}px)))`,
  };
}
