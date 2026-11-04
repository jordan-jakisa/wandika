import "@testing-library/jest-dom/vitest";
import { resetApp, task, todayFixture } from "../../test/components-views";
import { render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api";
import { app } from "../app.svelte";
import { clock } from "../clock.svelte";
import type { RemoteTask, VaultTask } from "../types";
import TasksView from "./TasksView.svelte";

const vaultTasks = (): VaultTask[] => [
  task("Projects/Launch.md", 3, "Set up OAuth apps"),
  task("Projects/Launch.md", 4, "Test on the phone 📅 2026-11-03", { due: "2026-11-03" }),
  task("Welcome.md", 7, "Pick a repository", { done: true }),
  task("Welcome.md", 8, "Write your first note"),
];

const remote = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  id: "r1",
  source: "google",
  list_id: "l1",
  list: "My Tasks",
  title: "Renew domain",
  done: false,
  due: null,
  ...over,
});

beforeEach(() => {
  resetApp();
  vi.spyOn(api, "tasksVault").mockResolvedValue(vaultTasks());
  vi.spyOn(api, "today").mockResolvedValue(todayFixture());
});
afterEach(() => vi.restoreAllMocks());

const summary = () => screen.getByText(/open task|No open tasks|Gathering|Couldn't/);
const group = (title: string) => screen.getByRole("button", { name: title }).closest("section")!;

describe("states", () => {
  test("says it is gathering while the notes are read", () => {
    vi.mocked(api.tasksVault).mockReturnValue(new Promise(() => {}));
    render(TasksView);
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(summary()).toHaveTextContent("Gathering tasks from your notes…");
  });

  test("empty: says how to add a task", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue([]);
    render(TasksView);
    expect(await screen.findByText("No open tasks. In any note, press ⌘L to start a checklist.")).toBeInTheDocument();
  });

  test("counts open tasks", async () => {
    render(TasksView);
    expect(await screen.findByText("3 open tasks in your notes.")).toBeInTheDocument();
  });

  test("one open task is singular", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue([task("A.md", 0, "Only one")]);
    render(TasksView);
    expect(await screen.findByText("1 open task in your notes.")).toBeInTheDocument();
  });

  test("a failed read says so instead of claiming there are no tasks", async () => {
    vi.mocked(api.tasksVault).mockRejectedValue(new Error("The vault folder can't be read."));
    render(TasksView);
    await vi.waitFor(() => expect(app.toast).toBe("The vault folder can't be read."));
    expect(summary()).toHaveTextContent("Couldn't gather your tasks.");
    expect(screen.queryByText(/No open tasks/)).not.toBeInTheDocument();
    vi.mocked(api.tasksVault).mockResolvedValue([]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(summary()).toHaveTextContent(/No open tasks/));
  });

  test("the last list shows at once while a fresh one loads", async () => {
    app.vaultTasks = [task("Plan.md", 1, "Kept from before")];
    vi.mocked(api.tasksVault).mockReturnValue(new Promise(() => {}));
    render(TasksView);
    expect(screen.getByText("Kept from before")).toBeInTheDocument();
    expect(screen.queryByText("Gathering tasks from your notes…")).not.toBeInTheDocument();
  });

  test("vault tasks show without waiting for calendars and mail", async () => {
    let arrive!: () => void;
    vi.mocked(api.today).mockReturnValue(new Promise((r) => (arrive = () => r(todayFixture({ remote_tasks: [remote()] })))));
    render(TasksView);
    try {
      expect(await screen.findByText("3 open tasks in your notes.")).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Set up OAuth apps" })).toBeInTheDocument();
    } finally {
      arrive();
    }
    expect(await screen.findByRole("checkbox", { name: "Renew domain" })).toBeInTheDocument();
  });
});

describe("grouped by note", () => {
  test("each note is a group of its open tasks, with its folder", async () => {
    render(TasksView);
    await screen.findByText("3 open tasks in your notes.");
    const launch = group("Launch");
    expect(within(launch).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Set up OAuth apps",
      "Test on the phone",
    ]);
    expect(within(launch).getAllByText("Projects")).toHaveLength(2);
    const welcome = group("Welcome");
    expect(within(welcome).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["Write your first note"]);
    expect(within(welcome).getByText("Vault")).toBeInTheDocument();
  });

  test("a due date shows on the task", async () => {
    render(TasksView);
    await screen.findByText("3 open tasks in your notes.");
    expect(within(group("Launch")).getByText("Today")).toBeInTheDocument();
  });

  test("a note's title opens the note", async () => {
    const user = userEvent.setup();
    render(TasksView);
    await user.click(await screen.findByRole("button", { name: "Launch" }));
    expect(app.current).toBe("Projects/Launch.md");
    expect(app.tab).toBe("notes");
  });

  test("a note whose tasks are all done is left out", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue([task("Done.md", 0, "Old", { done: true }), task("A.md", 0, "New")]);
    render(TasksView);
    await screen.findByText("1 open task in your notes.");
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
  });
});

describe("Show done", () => {
  test("off at first; on shows done tasks ticked, off hides them again", async () => {
    const user = userEvent.setup();
    render(TasksView);
    await screen.findByText("3 open tasks in your notes.");
    const chip = screen.getByRole("button", { name: "Show done" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("checkbox", { name: "Pick a repository" })).not.toBeInTheDocument();
    await user.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: "Pick a repository" })).toBeChecked();
    expect(summary()).toHaveTextContent("3 open tasks in your notes.");
    await user.click(chip);
    expect(screen.queryByRole("checkbox", { name: "Pick a repository" })).not.toBeInTheDocument();
  });

  test("is remembered on this device", async () => {
    const user = userEvent.setup();
    const first = render(TasksView);
    await user.click(await screen.findByRole("button", { name: "Show done" }));
    first.unmount();
    render(TasksView);
    expect(screen.getByRole("button", { name: "Show done" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ticking a task in a note", () => {
  test("writes the note, then the list reloads without it", async () => {
    const user = userEvent.setup();
    const toggle = vi.spyOn(api, "taskToggle").mockResolvedValue(true);
    render(TasksView);
    const box = await screen.findByRole("checkbox", { name: "Write your first note" });
    vi.mocked(api.tasksVault).mockResolvedValue(
      vaultTasks().map((t) => (t.line === 8 ? { ...t, done: true } : t)),
    );
    await user.click(box);
    expect(box).toBeChecked();
    await vi.waitFor(() => expect(toggle).toHaveBeenCalledWith("Welcome.md", 8, "Write your first note"), { timeout: 2000 });
    await vi.waitFor(() => expect(screen.getByText("2 open tasks in your notes.")).toBeInTheDocument());
    expect(screen.queryByRole("checkbox", { name: "Write your first note" })).not.toBeInTheDocument();
    expect(app.changed.paths).toEqual(["Welcome.md"]);
  });

  test("with Show done on, saves at once and stays in the list", async () => {
    const user = userEvent.setup();
    const toggle = vi.spyOn(api, "taskToggle").mockResolvedValue(false);
    render(TasksView);
    await user.click(await screen.findByRole("button", { name: "Show done" }));
    vi.mocked(api.tasksVault).mockResolvedValue(vaultTasks().map((t) => (t.line === 7 ? { ...t, done: false } : t)));
    await user.click(screen.getByRole("checkbox", { name: "Pick a repository" }));
    expect(toggle).toHaveBeenCalledWith("Welcome.md", 7, "Pick a repository");
    await vi.waitFor(() => expect(screen.getByText("4 open tasks in your notes.")).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Pick a repository" })).not.toBeChecked();
  });

  test("a failed write puts the box back and says why", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "taskToggle").mockRejectedValue(new Error("That note no longer exists."));
    render(TasksView);
    await user.click(await screen.findByRole("button", { name: "Show done" }));
    const box = screen.getByRole("checkbox", { name: "Set up OAuth apps" });
    await user.click(box);
    await vi.waitFor(() => expect(app.toast).toBe("Couldn't tick that task. That note no longer exists."));
    expect(box).not.toBeChecked();
  });
});

describe("tasks from other apps", () => {
  test("grouped by app and list, after the notes", async () => {
    vi.mocked(api.today).mockResolvedValue(
      todayFixture({
        remote_tasks: [
          remote(),
          remote({ id: "r2", title: "Pay rent", due: "2026-11-01" }),
          remote({ id: "a1", source: "apple", list: "Groceries", title: "Milk" }),
        ],
      }),
    );
    render(TasksView);
    const google = (await screen.findByRole("heading", { name: "Google Tasks: My Tasks" })).closest("section")!;
    expect(within(google).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["Renew domain", "Pay rent"]);
    expect(within(google).getByText("Overdue, 2026-11-01")).toBeInTheDocument();
    const apple = screen.getByRole("heading", { name: "Reminders: Groceries" }).closest("section")!;
    expect(within(apple).getByRole("checkbox", { name: "Milk" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Launch", "Welcome", "Google Tasks: My Tasks", "Reminders: Groceries"]);
  });

  test("ticking one marks it done in that app and refreshes", async () => {
    const user = userEvent.setup();
    const toggle = vi.spyOn(api, "remoteTaskToggle").mockResolvedValue();
    vi.mocked(api.today).mockResolvedValue(todayFixture({ remote_tasks: [remote()] }));
    render(TasksView);
    await user.click(await screen.findByRole("button", { name: "Show done" }));
    const calls = vi.mocked(api.today).mock.calls.length;
    vi.mocked(api.today).mockResolvedValue(todayFixture({ remote_tasks: [remote({ done: true })] }));
    await user.click(screen.getByRole("checkbox", { name: "Renew domain" }));
    expect(toggle).toHaveBeenCalledWith("google", "l1", "r1", true);
    await vi.waitFor(() => expect(vi.mocked(api.today).mock.calls.length).toBe(calls + 1));
    await vi.waitFor(() => expect(screen.getByRole("checkbox", { name: "Renew domain" })).toBeChecked());
  });
});

describe("a long list", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => task(`Notes/Note ${String(i).padStart(3, "0")}.md`, 0, `Task ${i}`));
  const groups = () => screen.getAllByRole("heading", { level: 3 });

  test("shows 40 notes at a time", async () => {
    const user = userEvent.setup();
    vi.mocked(api.tasksVault).mockResolvedValue(many(100));
    render(TasksView);
    await screen.findByText("100 open tasks in your notes.");
    expect(groups()).toHaveLength(40);
    await user.click(screen.getByRole("button", { name: "Show 40 more notes of 60" }));
    expect(groups()).toHaveLength(80);
    await user.click(screen.getByRole("button", { name: "Show 20 more notes" }));
    expect(groups()).toHaveLength(100);
    expect(screen.queryByRole("button", { name: /^Show \d+ more/ })).not.toBeInTheDocument();
  });

  test("one note left is singular", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue(many(41));
    render(TasksView);
    await screen.findByText("41 open tasks in your notes.");
    expect(screen.getByRole("button", { name: "Show 1 more note" })).toBeInTheDocument();
  });

  test("40 or fewer notes need no button", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue(many(40));
    render(TasksView);
    await screen.findByText("40 open tasks in your notes.");
    expect(groups()).toHaveLength(40);
    expect(screen.queryByRole("button", { name: /^Show \d+ more/ })).not.toBeInTheDocument();
  });
});

test("reloads when a sync changes the notes", async () => {
  render(TasksView);
  await screen.findByText("3 open tasks in your notes.");
  vi.mocked(api.tasksVault).mockResolvedValue([task("New.md", 0, "From the phone")]);
  app.changed = { paths: ["New.md"], at: Date.now() };
  expect(await screen.findByRole("checkbox", { name: "From the phone" })).toBeInTheDocument();
  expect(screen.getByText("1 open task in your notes.")).toBeInTheDocument();
});

describe("search, tags and pins", () => {
  const tagged = (): VaultTask[] => [
    task("Projects/Launch.md", 3, "Set up OAuth apps #setup"),
    task("Projects/Launch.md", 4, "Test on the phone #testing 📌 ⏫", { details: "Pixel and iPhone" }),
    task("Welcome.md", 8, "Write your first note #setup"),
    task("Errands.md", 1, "Call Amina about the lease #home"),
  ];

  test("search keeps tasks whose words, notes or note name match", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue(tagged());
    const user = userEvent.setup();
    render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    await user.type(screen.getByRole("searchbox", { name: "Search tasks" }), "lease");
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["Call Amina about the lease #home"]);
    await user.clear(screen.getByRole("searchbox", { name: "Search tasks" }));
    await user.type(screen.getByRole("searchbox", { name: "Search tasks" }), "iphone");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  test("tag chips show the tags in use, most used first, and filter by them", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue(tagged());
    const user = userEvent.setup();
    render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    const chips = within(screen.getByRole("group", { name: "Tags" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["#setup", "#home", "#testing"]);
    await user.click(chips[0]);
    expect(chips[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("searchbox", { name: "Search tasks" })).toHaveValue("#setup");
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Set up OAuth apps #setup",
      "Write your first note #setup",
    ]);
    await user.click(chips[0]);
    expect(screen.getByRole("searchbox", { name: "Search tasks" })).toHaveValue("");
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  test("no match says so and clears in one tap", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue(tagged());
    const user = userEvent.setup();
    render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    await user.type(screen.getByRole("searchbox", { name: "Search tasks" }), "zebra");
    expect(screen.getByText(/No tasks match “zebra”/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  test("search reaches Google Tasks and Reminders too", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue(tagged());
    app.today = todayFixture({ remote_tasks: [remote(), remote({ id: "r2", title: "Book flights" })] });
    const user = userEvent.setup();
    render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    await user.type(screen.getByRole("searchbox", { name: "Search tasks" }), "flights");
    expect(screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["Book flights"]);
  });

  test("pinned tasks gather at the top, outside their note", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue(tagged());
    render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    const pinned = screen.getByRole("heading", { name: "Pinned" }).closest("section")!;
    expect(within(pinned).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual(["Test on the phone #testing"]);
    expect(within(group("Launch")).getAllByRole("checkbox")).toHaveLength(1);
  });

  test("pinning writes the 📌 into the task and keeps its notes", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue(tagged());
    const edit = vi.spyOn(api, "taskEdit").mockResolvedValue();
    const user = userEvent.setup();
    render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    await user.click(screen.getByRole("button", { name: "Actions for Set up OAuth apps #setup" }));
    await user.click(screen.getByRole("menuitem", { name: "Pin to top" }));
    expect(edit).toHaveBeenCalledWith("Projects/Launch.md", 3, "Set up OAuth apps #setup", "Set up OAuth apps #setup 📌", "");
    await user.click(screen.getByRole("button", { name: "Actions for Test on the phone #testing" }));
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(edit).toHaveBeenLastCalledWith("Projects/Launch.md", 4, "Test on the phone #testing 📌 ⏫", "Test on the phone #testing ⏫", "Pixel and iPhone");
    await vi.waitFor(() => expect(app.changed.paths).toEqual(["Projects/Launch.md"]));
  });

  test("a task's name opens the editor; Focus starts a session on it", async () => {
    vi.mocked(api.tasksVault).mockResolvedValue(tagged());
    const { focus } = await import("../focus.svelte");
    const start = vi.spyOn(focus, "start").mockImplementation(() => {});
    const user = userEvent.setup();
    render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    await user.click(screen.getByRole("button", { name: "Write your first note #setup" }));
    expect(app.editingTask).toMatchObject({ path: "Welcome.md", line: 8 });
    await user.click(screen.getByRole("button", { name: "Actions for Write your first note #setup" }));
    await user.click(screen.getByRole("menuitem", { name: "Focus on this" }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ text: "Write your first note #setup", task: expect.objectContaining({ line: 8 }) }));
  });
});

describe("filters", () => {
  const dated = (): VaultTask[] => [
    task("Work/Plan.md", 1, "Late report 📅 2026-11-01", { due: "2026-11-01" }),
    task("Work/Plan.md", 2, "Call Ana ⏫ 📅 2026-11-04", { due: "2026-11-04" }),
    task("Home.md", 3, "Paint the door 📅 2026-11-08", { due: "2026-11-08" }),
    task("Home.md", 4, "Read a book"),
  ];
  const names = () => screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"));

  beforeEach(() => {
    localStorage.clear();
    clock.today = "2026-11-04";
    vi.mocked(api.tasksVault).mockResolvedValue(dated());
  });

  test("a due filter shows only those tasks; tapping it again shows them all", async () => {
    const user = userEvent.setup();
    render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    const filters = within(screen.getByRole("group", { name: "Filters" }));
    await user.click(filters.getByRole("button", { name: "Overdue" }));
    expect(names()).toEqual(["Late report"]);
    expect(screen.getByText("1 of 4 open tasks in your notes.")).toBeInTheDocument();
    await user.click(filters.getByRole("button", { name: "This week" }));
    expect(filters.getByRole("button", { name: "Overdue" })).toHaveAttribute("aria-pressed", "false");
    expect(names()).toEqual(["Call Ana", "Paint the door"]);
    await user.click(filters.getByRole("button", { name: "No date" }));
    expect(names()).toEqual(["Read a book"]);
    await user.click(filters.getByRole("button", { name: "No date" }));
    expect(names()).toHaveLength(4);
  });

  test("filters stack: high priority in one folder", async () => {
    const user = userEvent.setup();
    render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    await user.selectOptions(screen.getByRole("combobox", { name: "Folder" }), "Work");
    expect(names()).toEqual(["Late report", "Call Ana"]);
    await user.click(screen.getByRole("button", { name: "High priority" }));
    expect(names()).toEqual(["Call Ana"]);
  });

  test("filters are remembered, and nothing matching offers to clear them", async () => {
    const user = userEvent.setup();
    const first = render(TasksView);
    await screen.findByText("4 open tasks in your notes.");
    await user.click(screen.getByRole("button", { name: "Today" }));
    await user.click(screen.getByRole("button", { name: "High priority" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Folder" }), "Vault");
    first.unmount();
    render(TasksView);
    expect(await screen.findByText("No tasks match these filters.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(names()).toHaveLength(4);
  });

  test("tasks from Google Tasks or Reminders follow the due filters and leave with a folder", async () => {
    vi.mocked(api.today).mockResolvedValue({ ...todayFixture(), remote_tasks: [remote({ due: "2026-11-04" })] });
    const user = userEvent.setup();
    render(TasksView);
    expect(await screen.findByText("Renew domain")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Overdue" }));
    expect(screen.queryByText("Renew domain")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByText("Renew domain")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Folder" }), "Work");
    expect(screen.queryByText("Renew domain")).not.toBeInTheDocument();
  });
});

test("notes with something due come first, then the notes changed most recently", async () => {
  clock.today = "2026-11-04";
  localStorage.clear();
  vi.mocked(api.tasksVault).mockResolvedValue([
    task("Archive/Old.md", 1, "Old idea"),
    task("Daily/2026-11-04.md", 3, "Enable account deletion"),
    task("Work/Late.md", 2, "Send the report 📅 2026-11-01", { due: "2026-11-01" }),
  ]);
  app.titles = [
    { path: "Archive/Old.md", title: "Old", modified: 1 },
    { path: "Daily/2026-11-04.md", title: "2026-11-04", modified: 3 },
    { path: "Work/Late.md", title: "Late", modified: 2 },
  ] as typeof app.titles;
  render(TasksView);
  await screen.findByText("3 open tasks in your notes.");
  const heads = [...document.querySelectorAll(".group h3")].map((h) => h.textContent?.trim());
  expect(heads).toEqual(["Late", "2026-11-04", "Old"]);
});
