import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";
import { resetApp, setWidth, status } from "../../test/components-workspace";
import { api } from "../api";
import { app } from "../app.svelte";
import TaskRow from "./TaskRow.svelte";
import Workspace from "./Workspace.svelte";

// A touch screen: the tips about touch gestures are for it.
vi.mock("../tips", async (real) => ({ ...(await real<typeof import("../tips")>()), touch: true }));

beforeEach(async () => {
  resetApp();
  localStorage.clear();
  app.status = status();
  await app.refreshFiles();
  vi.spyOn(api, "today").mockResolvedValue({ events: [], mail: [], tasks: [], remote_tasks: [], errors: {} });
  setWidth(400);
});

test("after a few notes, the Notes list teaches its long-press menu, once, while it's on screen", async () => {
  app.notesOpened = 3;
  app.current = "Welcome.md";
  render(Workspace);
  expect(app.toast).not.toBe("Tip: press and hold a note in the list for rename, encrypt and more.");
  app.current = null;
  await vi.waitFor(() => expect(app.toast).toBe("Tip: press and hold a note in the list for rename, encrypt and more."));
  app.toast = null;
  app.current = "Welcome.md";
  app.current = null;
  await new Promise((r) => setTimeout(r, 0));
  expect(app.toast).toBeNull();
});

test("the first task row with swipe actions teaches the swipe, once", async () => {
  const row = { done: false, where: "Projects", onToggle: vi.fn(async () => {}), onArchive: vi.fn(), onDelete: vi.fn() };
  render(TaskRow, { text: "First", ...row });
  expect(app.toast).toBe("Tip: swipe a task right to pin it, or left to archive or delete it.");
  app.toast = null;
  render(TaskRow, { text: "Second", ...row });
  expect(app.toast).toBeNull();
  screen.getByText("Second");
});
