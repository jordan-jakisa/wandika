import "@testing-library/jest-dom/vitest";
import { resetApp } from "../../test/components-views";
import { fireEvent, render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { app } from "../app.svelte";
import * as haptics from "../haptics";
import TaskRow from "./TaskRow.svelte";

beforeEach(resetApp);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Props = {
  text: string;
  done?: boolean;
  due?: string | null;
  where?: string;
  leaves?: boolean;
  details?: string;
  onOpen?: () => void;
  onToggle?: () => Promise<void>;
  onEdit?: () => void;
  onPin?: () => Promise<void>;
  onFocus?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
};

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
    ["Ship it #work 📌 ⏫ 📅 2026-11-05", "Ship it #work"],
    ["Reply to Amina [email from Amina](https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3)", "Reply to Amina"],
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

  test("a tap of the phone on tick, none on untick", async () => {
    const user = userEvent.setup();
    const buzz = vi.spyOn(haptics, "haptic").mockImplementation(() => {});
    const { box } = setup({ text: "Plan" });
    await user.click(box);
    expect(buzz).toHaveBeenCalledWith("tap");
    buzz.mockClear();
    await vi.waitFor(() => expect(box).toBeEnabled());
    await user.click(box);
    expect(buzz).not.toHaveBeenCalled();
  });

  test("a failed save puts the box back and says why", async () => {
    const user = userEvent.setup();
    const { box } = setup({ text: "Plan", onToggle: () => Promise.reject(new Error("The note changed on disk.")) });
    await user.click(box);
    await vi.waitFor(() => expect(box).not.toBeChecked());
    expect(box).toBeEnabled();
    expect(app.toast).toBe("Couldn't tick that task. The note changed on disk.");
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
    expect(app.toast).toBe("Couldn't tick that task. Locked.");
  });

  test("unticking saves straight away, without the pause", async () => {
    vi.useFakeTimers();
    const { box, onToggle } = setup({ text: "Plan", leaves: true, done: true });
    await fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(box.closest("li")).not.toHaveClass("leaving");
  });
});

describe("pins, priority, notes and actions", () => {
  test("a pinned task says so; a high priority shows in the meta line", () => {
    setup({ text: "Ship it 📌 ⏫" });
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
    expect(screen.getByText("High priority")).toHaveClass("urgent");
  });

  test("a low priority shows quietly", () => {
    setup({ text: "Tidy up 🔽" });
    expect(screen.getByText("Low priority")).not.toHaveClass("urgent");
  });

  test("the first line of the notes shows under the task", () => {
    setup({ text: "Call Amina", details: "Ask about the lease\nand the keys" });
    expect(screen.getByText("Ask about the lease")).toBeInTheDocument();
    expect(screen.queryByText(/and the keys/)).not.toBeInTheDocument();
  });

  test("the name opens the editor; the menu edits, pins and starts a focus session", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onPin = vi.fn(async () => {});
    const onFocus = vi.fn();
    setup({ text: "Write the brief", onEdit, onPin, onFocus });
    await user.click(screen.getByRole("button", { name: "Write the brief" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Actions for Write the brief" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Actions for Write the brief" }));
    await user.click(screen.getByRole("menuitem", { name: "Pin to top" }));
    await user.click(screen.getByRole("button", { name: "Actions for Write the brief" }));
    await user.click(screen.getByRole("menuitem", { name: "Focus on this" }));
    expect([onEdit.mock.calls.length, onPin.mock.calls.length, onFocus.mock.calls.length]).toEqual([2, 1, 1]);
  });

  test("a pinned task offers Unpin; a failed pin says why", async () => {
    const user = userEvent.setup();
    setup({ text: "Ship it 📌", onPin: vi.fn(async () => Promise.reject(new Error("That task changed. Refresh and try again."))) });
    await user.click(screen.getByRole("button", { name: "Actions for Ship it" }));
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    await vi.waitFor(() => expect(app.toast).toBe("That task changed. Refresh and try again."));
  });

  test("a done task offers no focus session", async () => {
    const user = userEvent.setup();
    setup({ text: "Done thing", done: true, onFocus: vi.fn(), onEdit: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Actions for Done thing" }));
    expect(screen.queryByRole("menuitem", { name: "Focus on this" })).not.toBeInTheDocument();
  });

  test("a task with no actions has no menu", () => {
    setup({ text: "Plain" });
    expect(screen.queryByRole("button", { name: "Actions for Plain" })).not.toBeInTheDocument();
  });

  test("a task made from an email opens the email in Wandika", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(app, "openLink").mockImplementation(() => {});
    setup({ text: "Reply [email](https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3)", onEdit: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Open email" }));
    expect(open).toHaveBeenCalledWith("https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3");
    await user.click(screen.getByRole("button", { name: "Actions for Reply" }));
    await user.click(screen.getByRole("menuitem", { name: "Open email" }));
    expect(open).toHaveBeenCalledTimes(2);
  });

  test("an ordinary link is not an email", () => {
    setup({ text: "Read [the docs](https://example.com)" });
    expect(screen.queryByRole("button", { name: "Open email" })).not.toBeInTheDocument();
  });
});

describe("swipe actions", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  });
  const touch = { pointerType: "touch", pointerId: 1 };
  function swipe(row: Element, dx: number, dy = 0) {
    fireEvent.pointerDown(row, { ...touch, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(row, { ...touch, clientX: 200 + dx / 2, clientY: 100 + dy / 2 });
    fireEvent.pointerMove(row, { ...touch, clientX: 200 + dx, clientY: 100 + dy });
    fireEvent.pointerUp(row, { ...touch, clientX: 200 + dx, clientY: 100 + dy });
  }
  const actions = () => ({ onPin: vi.fn(async () => {}), onArchive: vi.fn(), onDelete: vi.fn(), onEdit: vi.fn() });

  test("the menu offers Archive and Delete as well", async () => {
    const user = userEvent.setup();
    const a = actions();
    setup({ text: "Write the brief", ...a });
    await user.click(screen.getByRole("button", { name: "Actions for Write the brief" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    await vi.waitFor(() => expect(a.onArchive).toHaveBeenCalledTimes(1));
  });

  test("a swipe left shows Archive and Delete; tapping one runs it and closes the row", async () => {
    const a = actions();
    const { container } = setup({ text: "Write the brief", ...a });
    const row = container.querySelector("li")!;
    swipe(row, -120);
    const trail = container.querySelector(".swipe.trail")!;
    expect(trail).toHaveTextContent("Archive");
    expect(trail).toHaveTextContent("Delete");
    expect(container.querySelector<HTMLElement>(".slide")!.style.transform).toBe("translateX(-152px)");
    await fireEvent.click(trail.querySelector(".archive")!);
    await vi.waitFor(() => expect(a.onArchive).toHaveBeenCalledTimes(1));
    expect(a.onDelete).not.toHaveBeenCalled();
    expect(container.querySelector(".swipe")).toBeNull();
  });

  test("a long swipe left folds the row away and deletes it", async () => {
    const a = actions();
    const { container } = setup({ text: "Write the brief", ...a });
    swipe(container.querySelector("li")!, -300);
    await vi.waitFor(() => expect(a.onDelete).toHaveBeenCalledTimes(1));
    expect(container.querySelector("li")).toHaveClass("leaving");
  });

  test("a swipe right shows Pin, or Unpin on a pinned task", async () => {
    const a = actions();
    const { container } = setup({ text: "Ship it 📌", ...a });
    swipe(container.querySelector("li")!, 100);
    const lead = container.querySelector(".swipe.lead")!;
    expect(lead).toHaveTextContent("Unpin");
    await fireEvent.click(lead.querySelector("button")!);
    expect(a.onPin).toHaveBeenCalledTimes(1);
  });

  test("a short swipe springs back; scrolling and a mouse drag never swipe", () => {
    const a = actions();
    const { container } = setup({ text: "Write the brief", ...a });
    const row = container.querySelector("li")!;
    swipe(row, -30);
    swipe(row, -10, 80);
    fireEvent.pointerDown(row, { pointerType: "mouse", pointerId: 2, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(row, { pointerType: "mouse", pointerId: 2, clientX: 20, clientY: 100 });
    fireEvent.pointerUp(row, { pointerType: "mouse", pointerId: 2, clientX: 20, clientY: 100 });
    expect(container.querySelector(".swipe")).toBeNull();
    expect(a.onDelete).not.toHaveBeenCalled();
  });

  test("a tap on an open row closes it instead of opening the task", async () => {
    const a = actions();
    const { container } = setup({ text: "Write the brief", ...a });
    swipe(container.querySelector("li")!, -120);
    await fireEvent.click(screen.getByRole("button", { name: "Write the brief" }));
    expect(a.onEdit).not.toHaveBeenCalled();
    expect(container.querySelector(".swipe")).toBeNull();
  });

  test("opening one row closes the one that was open", () => {
    const a = actions();
    const first = setup({ text: "First", ...a });
    const second = render(TaskRow, { text: "Second", done: false, where: "Projects", onToggle: vi.fn(async () => {}), ...actions() });
    swipe(first.container.querySelector("li")!, -120);
    swipe(second.container.querySelector("li")!, -120);
    expect(first.container.querySelector(".swipe")).toBeNull();
    expect(second.container.querySelector(".swipe")).not.toBeNull();
  });

  test("a task without vault actions has no swipe", () => {
    const { container } = setup({ text: "From Reminders", onFocus: vi.fn() });
    swipe(container.querySelector("li")!, -300);
    expect(container.querySelector(".swipe")).toBeNull();
  });
});

test("a delete that fails brings the row back", async () => {
  const user = userEvent.setup();
  const onDelete = vi.fn(async () => false);
  const { container } = setup({ text: "Keep me", onDelete });
  await user.click(screen.getByRole("button", { name: "Actions for Keep me" }));
  await user.click(screen.getByRole("menuitem", { name: "Delete" }));
  await vi.waitFor(() => expect(onDelete).toHaveBeenCalled());
  await vi.waitFor(() => expect(container.querySelector("li")).not.toHaveClass("leaving"));
});
