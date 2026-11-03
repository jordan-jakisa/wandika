import "@testing-library/jest-dom/vitest";
import { isModal, resetApp, task } from "../../test/components-views";
import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, AppError } from "../api";
import { app } from "../app.svelte";
import { focus } from "../focus.svelte";
import Dialog from "./Dialog.svelte";
import TaskEditor from "./TaskEditor.svelte";

beforeEach(resetApp);
afterEach(() => vi.restoreAllMocks());

function open(text: string, details = "") {
  const user = userEvent.setup();
  render(TaskEditor);
  app.editingTask = task("Projects/Launch.md", 4, text, { details });
  flushSync();
  return user;
}

test("stays closed until a task is picked", () => {
  render(TaskEditor);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("opens with the task's name, due date, priority, pin and notes filled in", () => {
  open("Test on the phone #testing 📌 ⏫ 📅 2026-11-05", "Pixel and iPhone");
  expect(isModal(screen.getByRole("dialog", { name: "Edit task" }))).toBe(true);
  expect(screen.getByLabelText("Task")).toHaveValue("Test on the phone #testing");
  expect(screen.getByLabelText("Due")).toHaveValue("2026-11-05");
  expect(screen.getByLabelText("Priority")).toHaveValue("high");
  expect(screen.getByLabelText(/Pin to the top/)).toBeChecked();
  expect(screen.getByLabelText("Notes")).toHaveValue("Pixel and iPhone");
});

test("Save writes the task back in the Obsidian Tasks format, with its notes", async () => {
  const edit = vi.spyOn(api, "taskEdit").mockResolvedValue();
  const user = open("Pay rent 🔁 every month");
  await user.clear(screen.getByLabelText("Task"));
  await user.type(screen.getByLabelText("Task"), "Pay the rent #home");
  await user.click(screen.getByRole("button", { name: "Tomorrow" }));
  await user.selectOptions(screen.getByLabelText("Priority"), "highest");
  await user.click(screen.getByLabelText(/Pin to the top/));
  await user.type(screen.getByLabelText("Notes"), "Landlord's account");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(edit).toHaveBeenCalledWith(
    "Projects/Launch.md",
    4,
    "Pay rent 🔁 every month",
    "Pay the rent #home 📌 🔺 📅 2026-11-04 🔁 every month",
    "Landlord's account",
  );
  expect(app.editingTask).toBeNull();
  expect(app.changed.paths).toEqual(["Projects/Launch.md"]);
});

test("Today sets today's date; No date clears it", async () => {
  const edit = vi.spyOn(api, "taskEdit").mockResolvedValue();
  const user = open("Call Amina 📅 2026-11-10");
  await user.click(screen.getByRole("button", { name: "Today" }));
  expect(screen.getByLabelText("Due")).toHaveValue("2026-11-03");
  await user.click(screen.getByRole("button", { name: "No date" }));
  expect(screen.getByLabelText("Due")).toHaveValue("");
  expect(screen.queryByRole("button", { name: "No date" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(edit).toHaveBeenCalledWith("Projects/Launch.md", 4, "Call Amina 📅 2026-11-10", "Call Amina", "");
});

test("a task needs a name; a failed save stays open and says why", async () => {
  const edit = vi.spyOn(api, "taskEdit").mockRejectedValue(new Error("That task changed. Refresh and try again."));
  const user = open("Call Amina");
  await user.clear(screen.getByLabelText("Task"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Give the task a name.");
  expect(edit).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("Task"), "Call Amina back");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That task changed. Refresh and try again.");
  expect(app.editingTask).not.toBeNull();
});

test("Cancel and Escape leave the task as it was", async () => {
  const edit = vi.spyOn(api, "taskEdit");
  const user = open("Call Amina");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(app.editingTask).toBeNull();
  expect(edit).not.toHaveBeenCalled();
});

test("Focus closes the editor and starts a session on the task", async () => {
  const start = vi.spyOn(focus, "start").mockImplementation(() => {});
  const user = open("Write the brief #work ⏫");
  await user.click(screen.getByRole("button", { name: "Focus" }));
  expect(app.editingTask).toBeNull();
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ text: "Write the brief #work", task: expect.objectContaining({ line: 4 }) }));
});

test("a done task offers no focus session", () => {
  render(TaskEditor);
  app.editingTask = task("A.md", 0, "Done", { done: true });
  flushSync();
  expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument();
});

test("with unsaved changes, Cancel and Escape ask before throwing them away", async () => {
  const user = open("Call Amina");
  render(Dialog);
  await user.type(screen.getByLabelText("Notes"), "Bring the keys");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  const ask = await screen.findByRole("dialog", { name: "Discard your changes to this task?" });
  await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
  expect(app.editingTask).not.toBeNull();
  await user.keyboard("{Escape}");
  await user.click(await screen.findByRole("button", { name: "Discard" }));
  await vi.waitFor(() => expect(app.editingTask).toBeNull());
});

test("a task that only moved in its note is saved where it is now", async () => {
  const moved = { ...task("Projects/Launch.md", 9, "Call Amina"), details: "" };
  const edit = vi
    .spyOn(api, "taskEdit")
    .mockRejectedValueOnce(new AppError("That task changed in its note, so the list is updated. Try again.", "stale_task"))
    .mockResolvedValueOnce();
  vi.spyOn(api, "tasksVault").mockResolvedValue([moved]);
  const user = open("Call Amina");
  await user.click(screen.getByRole("button", { name: "Tomorrow" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(app.editingTask).toBeNull());
  expect(edit.mock.calls[1].slice(0, 2)).toEqual(["Projects/Launch.md", 9]);
});

test("a task whose words changed in its note says to open it again", async () => {
  vi.spyOn(api, "taskEdit").mockRejectedValue(new AppError("That task changed in its note, so the list is updated. Try again.", "stale_task"));
  vi.spyOn(api, "tasksVault").mockResolvedValue([]);
  const user = open("Call Amina");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This task changed in its note. Close this and open it again to edit what it says now.");
});
