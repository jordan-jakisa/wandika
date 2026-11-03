import "@testing-library/jest-dom/vitest";
import { isModal, resetApp, task } from "../../test/components-views";
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../api";
import { app } from "../app.svelte";
import { focus } from "../focus.svelte";
import Dialog from "./Dialog.svelte";
import FocusSession from "./FocusSession.svelte";

beforeEach(() => {
  resetApp();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
});
afterEach(() => {
  focus.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const brief = task("Projects/Launch.md", 4, "Write the brief #work ⏫");

function start(minutes = 25) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(FocusSession);
  focus.start({ text: "Write the brief #work", task: brief }, minutes);
  flushSync();
  return user;
}

const finish = (ms: number) => {
  vi.advanceTimersByTime(ms);
  flushSync();
};

test("stays closed with no session", () => {
  render(FocusSession);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("fills the window with the task, without its tags, and the time left", () => {
  start(25);
  const dialog = screen.getByRole("dialog", { name: "Write the brief" });
  expect(isModal(dialog)).toBe(true);
  expect(screen.getByRole("timer")).toHaveTextContent("25:00");
  finish(61_000);
  expect(screen.getByRole("timer")).toHaveTextContent("23:59");
  expect(screen.getByRole("button", { name: "25 min" })).toHaveAttribute("aria-pressed", "true");
});

test("pause and resume, by button or the space bar", async () => {
  const user = start();
  await user.click(screen.getByRole("button", { name: "Pause" }));
  expect(focus.paused).toBe(true);
  expect(screen.getByText("Paused.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Resume" }));
  expect(focus.paused).toBe(false);
  await user.keyboard(" ");
  expect(focus.paused).toBe(true);
});

test("a length can be picked; it starts the round again", async () => {
  const user = start(25);
  await user.click(screen.getByRole("button", { name: "50 min" }));
  expect(screen.getByRole("timer")).toHaveTextContent("50:00");
});

test("at the end: a break, then another round", async () => {
  const user = start(15);
  finish(15 * 60_000);
  expect(screen.getByRole("status")).toHaveTextContent("Round done.");
  await user.click(screen.getByRole("button", { name: "Take a 5-minute break" }));
  expect(screen.getByRole("timer")).toHaveTextContent("5:00");
  expect(screen.getByText("Breathe. Stretch. Look far away.")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Length" })).not.toBeInTheDocument();
  finish(5 * 60_000);
  expect(screen.getByRole("status")).toHaveTextContent("Break's over.");
  await user.click(screen.getByRole("button", { name: "Another round" }));
  expect(screen.getByRole("timer")).toHaveTextContent("15:00");
  finish(15 * 60_000);
  expect(screen.getByRole("status")).toHaveTextContent("2 rounds done.");
});

test("Mark task done ticks it in the note and closes the room", async () => {
  const toggle = vi.spyOn(api, "taskToggle").mockResolvedValue(true);
  const user = start(15);
  finish(15 * 60_000);
  await user.click(screen.getByRole("button", { name: "Mark task done" }));
  expect(toggle).toHaveBeenCalledWith("Projects/Launch.md", 4, "Write the brief #work ⏫");
  await vi.waitFor(() => expect(focus.active).toBeNull());
  expect(app.toast).toBe("Done. Well spent.");
  expect(app.changed.paths).toEqual(["Projects/Launch.md"]);
});

test("a Google task is ticked in Google Tasks", async () => {
  const toggle = vi.spyOn(api, "remoteTaskToggle").mockResolvedValue();
  vi.spyOn(app, "loadToday").mockResolvedValue();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(FocusSession);
  focus.start({ text: "Renew domain", remote: { id: "r1", source: "google", list_id: "l1", list: "My Tasks", title: "Renew domain", done: false, due: null } }, 15);
  finish(15 * 60_000);
  await user.click(screen.getByRole("button", { name: "Mark task done" }));
  expect(toggle).toHaveBeenCalledWith("google", "l1", "r1", true);
});

test("End and Escape leave the room", async () => {
  const user = start();
  await user.click(screen.getByRole("button", { name: "End" }));
  expect(focus.active).toBeNull();
  flushSync();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  focus.start({ text: "Again" }, 15);
  flushSync();
  render(Dialog);
  // Mid-round, Escape asks first: Keep going stays, End round leaves.
  await user.keyboard("{Escape}");
  await user.click(await screen.findByRole("button", { name: "Keep going" }));
  expect(focus.active).not.toBeNull();
  await user.keyboard("{Escape}");
  await user.click(await screen.findByRole("button", { name: "End round" }));
  await vi.waitFor(() => expect(focus.active).toBeNull());
});
