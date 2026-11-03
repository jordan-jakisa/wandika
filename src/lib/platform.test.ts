import { afterEach, describe, expect, test, vi } from "vitest";
import { noTouch } from "../test/lib";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC = IPAD;
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** The platform module as it loads with this user agent, page address and app. */
async function load(ua: string, { search = "", tauri = false, touch = true } = {}) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  history.replaceState(null, "", "/" + search);
  if (tauri) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const restore = touch ? () => {} : noTouch();
  try {
    vi.resetModules();
    return await import("./platform");
  } finally {
    restore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete document.documentElement.dataset.platform;
  document.documentElement.style.removeProperty("--text-scale");
});

describe("detecting the platform", () => {
  test("iPhone", async () => {
    const p = await load(IPHONE);
    expect(p.platform).toBe("ios");
    expect(p.isIOS).toBe(true);
    expect(p.isAndroid).toBe(false);
  });

  test("an iPad says Macintosh but has touch", async () => {
    expect((await load(IPAD, { touch: true })).platform).toBe("ios");
  });

  test("Android", async () => {
    const p = await load(ANDROID);
    expect(p.platform).toBe("android");
    expect(p.isAndroid).toBe(true);
    expect(p.isIOS).toBe(false);
  });

  test("a Mac without touch, and other computers, are desktop", async () => {
    expect((await load(MAC, { touch: false })).platform).toBe("desktop");
    expect((await load(WINDOWS, { touch: false })).platform).toBe("desktop");
  });

  test("it is written on <html> for CSS", async () => {
    await load(ANDROID);
    expect(document.documentElement.dataset.platform).toBe("android");
  });

  test("in a browser, ?platform= previews a phone's conventions", async () => {
    expect((await load(WINDOWS, { search: "?platform=ios", touch: false })).platform).toBe("ios");
    expect((await load(WINDOWS, { search: "?platform=android", touch: false })).platform).toBe("android");
    expect((await load(WINDOWS, { search: "?platform=symbian", touch: false })).platform).toBe("desktop");
  });

  test("inside the app the real device decides, not the address", async () => {
    expect((await load(ANDROID, { search: "?platform=ios", tauri: true })).platform).toBe("android");
  });
});

describe("followSystemTextSize", () => {
  /** The size the system reports for its body text. */
  function bodyText(fontSize: string) {
    const real = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) =>
      el instanceof HTMLSpanElement ? ({ fontSize } as CSSStyleDeclaration) : real(el, pseudo),
    );
  }
  const scale = () => document.documentElement.style.getPropertyValue("--text-scale");

  test("scales the text with Dynamic Type on iOS", async () => {
    const p = await load(IPHONE);
    bodyText("17px");
    p.followSystemTextSize();
    expect(scale()).toBe("1");
    bodyText("21.25px");
    p.followSystemTextSize();
    expect(scale()).toBe("1.25");
  });

  test("keeps within 85% and 160% of the default", async () => {
    const p = await load(IPHONE);
    bodyText("53px");
    p.followSystemTextSize();
    expect(scale()).toBe("1.6");
    bodyText("11px");
    p.followSystemTextSize();
    expect(scale()).toBe("0.85");
  });

  test("an unreadable size keeps the default scale", async () => {
    const p = await load(IPHONE);
    for (const size of ["", "auto", "0px"]) {
      bodyText(size);
      p.followSystemTextSize();
      expect(scale(), size).toBe("1");
    }
  });

  test("leaves no probe behind", async () => {
    const p = await load(IPHONE);
    bodyText("17px");
    const before = document.body.children.length;
    p.followSystemTextSize();
    expect(document.body.children.length).toBe(before);
  });

  test("does nothing on other platforms", async () => {
    const p = await load(ANDROID);
    bodyText("30px");
    p.followSystemTextSize();
    expect(scale()).toBe("");
  });
});
