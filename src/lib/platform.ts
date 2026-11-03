// Which phone we run on. The design is the same on every phone; the platform only decides
// behaviour such as the iOS edge swipe back. Set as data-platform on <html> for CSS too.

export type Platform = "ios" | "android" | "desktop";

function detect(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  // In a plain browser, `?platform=ios` or `?platform=android` previews a phone's conventions.
  if (!("__TAURI_INTERNALS__" in window)) {
    const forced = new URLSearchParams(location.search).get("platform");
    if (forced === "ios" || forced === "android") return forced;
  }
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && "ontouchend" in document)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

export const platform: Platform = detect();
export const isIOS = platform === "ios";
export const isAndroid = platform === "android";

/** The Mac app: its window has the traffic lights over the top of the page (Overlay title bar). */
export const isMac = platform === "desktop" && typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

if (typeof document !== "undefined") {
  document.documentElement.dataset.platform = platform;
  if (isMac) document.documentElement.dataset.os = "mac";
}

/**
 * iOS: reads the Dynamic Type body size (17pt at the default setting) and scales the app's text
 * tokens to match. Called at start and whenever the app comes back to the front.
 */
export function followSystemTextSize() {
  if (!isIOS || typeof document === "undefined") return;
  const probe = document.createElement("span");
  probe.style.cssText = "font: -apple-system-body; position: absolute; visibility: hidden";
  document.body.append(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  // Keep within what the layout can hold: 85% to 160% of the default.
  const scale = Number.isFinite(px) && px > 0 ? Math.min(1.6, Math.max(0.85, px / 17)) : 1;
  document.documentElement.style.setProperty("--text-scale", String(scale));
}
