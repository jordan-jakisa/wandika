import { expect, test, vi } from "vitest";

const plugin = vi.hoisted(() => ({ selectionFeedback: vi.fn(), impactFeedback: vi.fn(), notificationFeedback: vi.fn() }));
vi.mock("@tauri-apps/plugin-haptics", () => plugin);

test("outside the phone apps, haptics do nothing", async () => {
  const { haptic } = await import("./haptics");
  haptic("tap");
  await new Promise((r) => setTimeout(r, 0));
  expect(plugin.impactFeedback).not.toHaveBeenCalled();
});

test("on a phone, each kind maps to the system feedback with that meaning", async () => {
  vi.resetModules();
  vi.doMock("./api", () => ({ native: true }));
  vi.doMock("./platform", () => ({ isIOS: true, isAndroid: false }));
  const { haptic } = await import("./haptics");
  haptic("selection");
  haptic("tap");
  haptic("success");
  await vi.waitFor(() => expect(plugin.notificationFeedback).toHaveBeenCalledWith("success"));
  expect(plugin.selectionFeedback).toHaveBeenCalled();
  expect(plugin.impactFeedback).toHaveBeenCalledWith("light");
});
