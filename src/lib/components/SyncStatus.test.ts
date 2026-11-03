import "@testing-library/jest-dom/vitest";
import { localStatus, resetApp, statusFixture } from "../../test/components-views";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../app.svelte";
import SyncStatus from "./SyncStatus.svelte";

beforeEach(() => {
  resetApp();
  app.status = statusFixture();
  vi.spyOn(app, "sync").mockResolvedValue();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const set = (state: Partial<typeof app>) => {
  Object.assign(app, state);
  flushSync();
};

describe("a vault on this device only", () => {
  test("says so and points to Settings to connect GitHub", async () => {
    const user = userEvent.setup();
    app.status = localStatus();
    render(SyncStatus);
    const button = screen.getByRole("button", { name: "On this device only" });
    expect(button).toHaveAttribute("title", "Connect this vault to GitHub in Settings");
    await user.click(button);
    expect(app.settingsOpen).toBe(true);
    expect(app.settingsSection).toBe("vault");
    expect(app.sync).not.toHaveBeenCalled();
  });
});

describe("a GitHub vault", () => {
  test("before the first sync", () => {
    render(SyncStatus);
    expect(screen.getByRole("button", { name: "Not synced yet. Sync now" })).toHaveTextContent("Not synced yet");
  });

  test("says how long ago it last synced", () => {
    app.lastSync = Date.now() - 10_000;
    render(SyncStatus);
    expect(screen.getByRole("button")).toHaveTextContent("Synced just now");
    set({ lastSync: Date.now() - 5 * 60_000 });
    expect(screen.getByRole("button")).toHaveTextContent("Synced 5 min ago");
    set({ lastSync: Date.now() - 3 * 3_600_000 });
    expect(screen.getByRole("button")).toHaveTextContent("Synced 3 h ago");
  });

  test("keeps the time current while it stays on screen", async () => {
    vi.useFakeTimers();
    app.lastSync = Date.now();
    render(SyncStatus);
    expect(screen.getByRole("button")).toHaveTextContent("Synced just now");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(screen.getByRole("button")).toHaveTextContent("Synced 2 min ago");
  });

  test("a tap syncs now", async () => {
    const user = userEvent.setup();
    app.lastSync = Date.now();
    render(SyncStatus);
    await user.click(screen.getByRole("button", { name: "Synced just now. Sync now" }));
    expect(app.sync).toHaveBeenCalledWith(true);
    expect(app.toast).toBeNull();
  });
});

describe("syncing", () => {
  test("a quick sync doesn't flicker the line", async () => {
    vi.useFakeTimers();
    app.lastSync = Date.now();
    render(SyncStatus);
    set({ syncing: true });
    await vi.advanceTimersByTimeAsync(400);
    expect(screen.getByRole("button")).toHaveTextContent("Synced just now");
    expect(screen.getByRole("button")).toBeDisabled();
    set({ syncing: false });
    await vi.advanceTimersByTimeAsync(400);
    expect(screen.getByRole("button")).toHaveTextContent("Synced just now");
  });

  test("a sync that takes half a second says Syncing…", async () => {
    vi.useFakeTimers();
    app.lastSync = Date.now();
    render(SyncStatus);
    set({ syncing: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(screen.getByRole("button", { name: "Syncing… Sync now" })).toHaveTextContent("Syncing…");
    expect(screen.getByRole("button")).toBeDisabled();
    set({ syncing: false });
    expect(screen.getByRole("button")).toHaveTextContent("Synced just now");
    expect(screen.getByRole("button")).toBeEnabled();
  });

  test("shows how far a long sync has got, announced politely", () => {
    app.syncing = true;
    app.syncProgress = { phase: "uploading", done: 312, total: 2597 };
    render(SyncStatus);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Uploading 312 of 2,597 files");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-live", "polite");
    set({ syncProgress: { phase: "checking", done: 0, total: 0 } });
    expect(button).toHaveTextContent("Comparing your notes with GitHub…");
    set({ syncProgress: { phase: "downloading", done: 0, total: 0 } });
    expect(screen.getByRole("button")).toHaveTextContent("Downloading your notes…");
    set({ syncProgress: { phase: "saving", done: 0, total: 0 } });
    expect(screen.getByRole("button")).toHaveTextContent("Saving to GitHub…");
  });
});

describe("offline", () => {
  test("says changes are kept here, in amber, and a tap retries quietly", async () => {
    const user = userEvent.setup();
    app.syncError = { code: "offline", message: "You're offline." };
    render(SyncStatus);
    const button = screen.getByRole("button", { name: "Offline. Changes are saved here. Sync now" });
    expect(button).toHaveClass("warn");
    expect(button).not.toHaveClass("fail");
    await user.click(button);
    expect(app.sync).toHaveBeenCalledWith(true);
    expect(app.toast).toBeNull();
  });
});

describe("a failed sync", () => {
  test.each([
    ["github_rate_limit", "GitHub is busy. Tap to retry"],
    ["github_down", "GitHub is down. Tap to retry"],
    ["github_not_found", "Repository not found. Tap to choose"],
    ["github_auth", "GitHub sign-in expired. Tap to sign in"],
    ["no_access", "No access to the folder"],
    ["disk_full", "Device is out of space"],
    ["something_new", "Couldn't sync. Tap to retry"],
  ])("%s reads “%s”", (code, text) => {
    app.syncError = { code, message: "The full sentence." };
    render(SyncStatus);
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent(text);
    expect(button).toHaveClass("fail");
    expect(button).toHaveAttribute("title", "The full sentence.");
  });

  test.each([
    ["github_not_found", "vault"],
    ["github_auth", "account"],
  ])("a %s failure opens the Settings page that fixes it instead of retrying", async (code, page) => {
    const user = userEvent.setup();
    const open = vi.spyOn(app, "openSettings").mockImplementation(() => {});
    app.syncError = { code, message: "The full sentence." };
    render(SyncStatus);
    await user.click(screen.getByRole("button"));
    expect(open).toHaveBeenCalledWith(page);
    expect(app.sync).not.toHaveBeenCalled();
  });

  test("a tap shows the full sentence and tries again", async () => {
    const user = userEvent.setup();
    app.syncError = { code: "github_down", message: "GitHub isn't answering. Wandika will try again in a few minutes." };
    render(SyncStatus);
    await user.click(screen.getByRole("button", { name: "GitHub is down. Tap to retry. Sync now" }));
    expect(app.toast).toBe("GitHub isn't answering. Wandika will try again in a few minutes.");
    expect(app.sync).toHaveBeenCalledWith(true);
  });

  test("clears once a sync succeeds", () => {
    app.syncError = { code: "github_down", message: "Down." };
    render(SyncStatus);
    set({ syncError: null, lastSync: Date.now() });
    expect(screen.getByRole("button")).toHaveTextContent("Synced just now");
    expect(screen.getByRole("button")).not.toHaveClass("fail");
  });
});
