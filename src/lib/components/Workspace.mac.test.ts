import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";
import { githubVault, resetApp, setWidth, status } from "../../test/components-workspace";
import { api } from "../api";
import { app } from "../app.svelte";
import Workspace from "./Workspace.svelte";

// The Mac app: the window's traffic lights sit over the top of the page.
vi.mock("../platform", async (real) => ({ ...(await real<typeof import("../platform")>()), isMac: true }));

beforeEach(async () => {
  resetApp();
  app.status = status();
  await app.refreshFiles();
  vi.spyOn(api, "today").mockResolvedValue({ events: [], mail: [], tasks: [], remote_tasks: [], errors: {} });
  setWidth(1200);
});

const main = () => within(document.querySelector<HTMLElement>("main.main")!);

test("on a Mac the empty screen names the shortcuts, with sync only for a synced vault", () => {
  const { unmount } = render(Workspace);
  expect(main().getByText("Search with ⌘K. New note with ⌘N.")).toBeInTheDocument();
  unmount();
  app.status = status({ vault: githubVault, known: [githubVault] });
  render(Workspace);
  expect(main().getByText("Search with ⌘K. New note with ⌘N. Sync with ⌘S.")).toBeInTheDocument();
});

test("on a Mac every column drags the window from its top strip", () => {
  render(Workspace);
  expect(document.querySelectorAll(".drag-strip[data-tauri-drag-region]").length).toBeGreaterThanOrEqual(1);
  expect(document.querySelector(".side-head[data-tauri-drag-region]")).toBeInTheDocument();
  expect(screen.getAllByText(app.vault!.name).some((e) => e.hasAttribute("data-tauri-drag-region"))).toBe(true);
});

test("⌘⇧P opens the palette on its commands; ⌘1 goes to the file list", async () => {
  const { fireEvent } = await import("@testing-library/svelte");
  render(Workspace);
  await fireEvent.keyDown(window, { key: "P", metaKey: true, shiftKey: true });
  expect(app.switcherOpen).toBe(true);
  expect(await screen.findByRole("listbox", { name: "Commands" })).toBeInTheDocument();
  app.switcherOpen = false;
  await new Promise((r) => setTimeout(r, 400));
  await fireEvent.keyDown(window, { key: "1", metaKey: true });
  await vi.waitFor(() => expect(document.activeElement?.closest(".tree")).not.toBeNull());
});
