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

if (typeof document !== "undefined") document.documentElement.dataset.platform = platform;
