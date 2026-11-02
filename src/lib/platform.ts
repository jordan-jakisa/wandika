// Which phone conventions to follow. iOS gets Apple's patterns (Liquid Glass tab bar, large titles,
// "‹ Notes" back buttons); Android gets Material 3 (navigation bar with a pill indicator, top app
// bar, floating action button). Set as data-platform on <html> so CSS can follow it too.

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
