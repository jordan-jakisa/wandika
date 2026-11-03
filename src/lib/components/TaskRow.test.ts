import "@testing-library/jest-dom/vitest";
import { resetApp } from "../../test/components-views";
import { fireEvent, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../app.svelte";
import TaskRow from "./TaskRow.svelte";

beforeEach(resetApp);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Props = { text: string; done?: boolean; due?: string | null; where?: string; leaves?: boolean; onOpen?: () => void; onToggle?: () => Promise<void> };

function setup(p: Props) {
  const onToggle = p.onToggle ?? vi.fn(async () => {});
  const r = render(TaskRow, { done: false, where: "Projects", ...p, onToggle });
  return { ...r, onToggle, box: screen.getByRole("checkbox") };
}

describe("the label", () => {
  test.each([
    ["Write the plan", "Write the plan"],
    ["Test on the phone 📅 2026-11-05", "Test on the phone"],
    ["Pick a stack ✅ 2026-11-01", "Pick a stack"],
    ["Review [[Reading list]]", "Review Reading list"],
    ["Call [[People/Amina|Amina]] back", "Call Amina back"],
    ["Read [the docs](https://example.com)", "Read the docs"],
    ["Fix **sync** and _merge_ then ~~old~~ `code`", "Fix sync and merge then old code"],
  ])("“%s” reads “%s”", (text, label) => {
    setup({ text });
    expect(screen.getByRole("checkbox", { name: label })).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("state", () => {
  test("an open task is unticked", () => {
    const { box } = setup({ text: "Plan" });
    expect(box).not.toBeChecked();
    expect(box.closest("li")).not.toHaveClass("done");
  });

  test("a done task is ticked and struck through", () => {
    const { box } = setup({ text: "Plan", done: true });
    expect(box).toBeChecked();
    expect(box.closest("li")).toHaveClass("done");
  });
});

describe("due dates", () => {
  test("no date, no date line", () => {
    setup({ text: "Plan" });
    expect(screen.queryByText(/Today|Overdue|2026/)).not.toBeInTheDocument();
  });

  test("due today says Today, in amber", () => {
    setup({ text: "Plan", due: "2026-11-03" });
    expect(screen.getByText("Today")).toHaveClass("due-today");
  });

  test("past due says Overdue with the date, in red", () => {
    setup({ text: "Plan", due: "2026-11-01" });
    expect(screen.getByText("Overdue, 2026-11-01")).toHaveClass("overdue");
  });

  test("a later date shows as it is", () => {
    setup({ text: "Plan", due: "2026-12-24" });
    const date = screen.getByText("2026-12-24");
    expect(date).not.toHaveClass("overdue");
    expect(date).not.toHaveClass("due-today");
  });

  test("a done task is never overdue", () => {
    setup({ text: "Plan", due: "2026-11-01", done: true });
    expect(screen.getByText("2026-11-01")).not.toHaveClass("overdue");
  });
});

describe("where it lives", () => {
  test("plain text when there's nowhere to go", () => {
    setup({ text: "Plan", where: "Projects" });
    expect(screen.getByText("Projects").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: "Projects" })).not.toBeInTheDocument();
  });

  test("a link that opens the note when it can", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    setup({ text: "Plan", where: "Launch", onOpen });
    await user.click(screen.getByRole("button", { name: "Launch" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("ticking", () => {
  test("ticks at once and saves", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const onToggle = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { box } = setup({ text: "Plan", onToggle });
    await user.click(box);
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(onToggle).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(box).toBeEnabled());
    expect(box).toBeChecked();
  });

  test("unticking a done task saves too", async () => {
    const user = userEvent.setup();
    const { box, onToggle } = setup({ text: "Plan", done: true });
    await user.click(box);
    expect(box).not.toBeChecked();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  test("a buzz on tick where the phone can, none on untick", async () => {
    const user = userEvent.setup();
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    const { box } = setup({ text: "Plan" });
    await user.click(box);
    expect(vibrate).toHaveBeenCalledWith(10);
    vibrate.mockClear();
    await vi.waitFor(() => expect(box).toBeEnabled());
    await user.click(box);
    expect(vibrate).not.toHaveBeenCalled();
    delete (navigator as { vibrate?: unknown }).vibrate;
  });

  test("a failed save puts the box back and says why", async () => {
    const user = userEvent.setup();
    const { box } = setup({ text: "Plan", onToggle: () => Promise.reject(new Error("The note changed on disk.")) });
    await user.click(box);
    await vi.waitFor(() => expect(box).not.toBeChecked());
    expect(box).toBeEnabled();
    expect(app.toast).toBe("Couldn't update that task. The note changed on disk.");
  });

  test("follows the list once it reloads with the new state", async () => {
    const user = userEvent.setup();
    const { box, rerender } = setup({ text: "Plan" });
    await user.click(box);
    await vi.waitFor(() => expect(box).toBeEnabled());
    await rerender({ done: true });
    expect(box).toBeChecked();
    // Changed elsewhere (another device): the row shows the list's state.
    await rerender({ done: false });
    expect(box).not.toBeChecked();
  });
});

describe("in a list that hides done tasks", () => {
  test("a ticked task shows done for a moment, then folds away and saves", async () => {
    vi.useFakeTimers();
    const { box, onToggle } = setup({ text: "Plan", leaves: true });
    await fireEvent.click(box);
    expect(box).toBeChecked();
    expect(box.closest("li")).not.toHaveClass("leaving");
    expect(onToggle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(box.closest("li")).toHaveClass("leaving");
    await vi.advanceTimersByTimeAsync(300);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  test("if the save fails the row comes back", async () => {
    vi.useFakeTimers();
    const { box } = setup({ text: "Plan", leaves: true, onToggle: () => Promise.reject(new Error("Locked.")) });
    await fireEvent.click(box);
    await vi.advanceTimersByTimeAsync(1000);
    expect(box.closest("li")).not.toHaveClass("leaving");
    expect(box).not.toBeChecked();
    expect(app.toast).toBe("Couldn't update that task. Locked.");
  });

  test("unticking saves straight away, without the pause", async () => {
    vi.useFakeTimers();
    const { box, onToggle } = setup({ text: "Plan", leaves: true, done: true });
    await fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(box.closest("li")).not.toHaveClass("leaving");
  });
});
