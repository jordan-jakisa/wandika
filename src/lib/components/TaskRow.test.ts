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
