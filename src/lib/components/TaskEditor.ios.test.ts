import "@testing-library/jest-dom/vitest";
import { isModal, resetApp, task } from "../../test/components-views";
import { fireEvent, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../api";
import { app } from "../app.svelte";
import TaskEditor from "./TaskEditor.svelte";

// On iPhone the editor is a form sheet: Cancel and Save in its top bar, rows in groups, a switch for Pin.
vi.mock("../platform", async (real) => ({ ...(await real<typeof import("../platform")>()), isIOS: true }));

beforeEach(resetApp);
afterEach(() => vi.restoreAllMocks());

function open(text: string, details = "") {
  const user = userEvent.setup();
  const r = render(TaskEditor);
  app.editingTask = task("Projects/Launch.md", 4, text, { details });
  flushSync();
  return { user, ...r };
}

test("opens as a sheet with Cancel and Save in its top bar and Pin as a switch", () => {
  const { container } = open("Call Amina 📌 📅 2026-11-05");
  const sheet = screen.getByRole("dialog", { name: "Edit task" });
  expect(isModal(sheet)).toBe(true);
  expect(sheet).toHaveClass("ios");
  const bar = container.querySelector("header.bar")!;
  expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
  expect(screen.getByLabelText(/Pin to the top/)).toHaveClass("toggle");
  expect(screen.getByLabelText(/Pin to the top/)).toBeChecked();
  expect(screen.getByLabelText("Task")).toHaveValue("Call Amina");
  expect(screen.getByLabelText("Due")).toHaveValue("2026-11-05");
  expect(screen.getByRole("button", { name: "Focus" })).toBeInTheDocument();
});

test("Save in the top bar writes the task; Cancel closes without saving", async () => {
  const edit = vi.spyOn(api, "taskEdit").mockResolvedValue();
  const { user } = open("Call Amina");
  await user.click(screen.getByRole("button", { name: "Tomorrow" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(edit).toHaveBeenCalledWith("Projects/Launch.md", 4, "Call Amina", "Call Amina 📅 2026-11-04", "");
  app.editingTask = task("Projects/Launch.md", 4, "Call Amina");
  flushSync();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(app.editingTask).toBeNull();
  expect(edit).toHaveBeenCalledTimes(1);
});

test("a drag down the top bar closes the sheet, but not with unsaved changes", async () => {
  const { user, container } = open("Call Amina");
  const bar = container.querySelector("header.bar")!;
  const drag = (to: number) => {
    fireEvent.pointerDown(bar, { clientY: 100 });
    fireEvent.pointerMove(bar, { clientY: to });
    fireEvent.pointerUp(bar, { clientY: to });
  };
  drag(150);
  expect(app.editingTask).not.toBeNull();
  await user.type(screen.getByLabelText("Notes"), "Bring the keys");
  drag(400);
  expect(app.editingTask).not.toBeNull();
  await user.clear(screen.getByLabelText("Notes"));
  drag(400);
  expect(app.editingTask).toBeNull();
});
